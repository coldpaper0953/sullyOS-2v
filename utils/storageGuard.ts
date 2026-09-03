/**
 * 存储过载保护（内置存储 ≈ IndexedDB 配额）
 *
 * 目标：本地存储逼近浏览器配额（典型 ~500MB 量级）时，用 AI 把**旧聊天记录**
 * 分层摘要——越早的消息压得越简，越新的保留越细——原消息删除、摘要以 system
 * 消息留在对话流里，角色仍然「记得」早期发生过什么，只是不再逐字保存。
 *
 * 分层策略（按「距今多久」分三档压缩比）：
 *   远古（最早 50%）：一批压成 1 段 ~100 字摘要（留人名/事件/结果）
 *   中期（中间 30%）：一批压成 1 段 ~200 字摘要（留对话要点 + 情绪）
 *   近期（最新 20%）：不动（对话上下文的活水源泉）
 *
 * 只处理 role=user/assistant 且 type=text 的消息；卡片/语音/图片/转账等
 * 功能消息原样保留（它们是渲染素材，不是可压缩文本）。
 *
 * 摘要调用走角色副 API（secondaryApi）优先、主 API 兜底——与主动消息同一
 * 取舍：压缩是后台批处理，不该抢主聊天的速率。
 */

import { DB } from './db';
import { safeFetchJson } from './safeApi';
import type { Message, APIConfig } from '../types';
import type { LightLLMConfig } from './memoryPalace/pipeline';

// ─── 配额与分层参数 ────────────────────────────────────────────────

/** 触发压缩的阈值：估算用量占 quota 的比例。 */
export const STORAGE_GUARD_THRESHOLD = 0.85;
/** 每一批送进 LLM 的原始消息条数（按字符预算动态收敛，这是上限）。 */
const BATCH_MAX_MESSAGES = 120;
/** 单批原始文本预算（字符）。超过就提前切批。 */
const BATCH_CHAR_BUDGET = 24_000;

export interface StorageUsage {
    usage: number;      // 字节（navigator.storage.estimate 的 usage）
    quota: number;      // 字节（同上；拿不到时回退 500MB 常量）
    ratio: number;      // usage / quota
    supported: boolean; // navigator.storage.estimate 是否可用
}

/** 估算当前存储用量。拿不到 estimate 时返回 supported:false（调用方按不可用处理）。 */
export async function measureStorage(): Promise<StorageUsage> {
    try {
        if (navigator.storage?.estimate) {
            const { usage = 0, quota = 500 * 1024 * 1024 } = await navigator.storage.estimate();
            return { usage, quota, ratio: quota > 0 ? usage / quota : 0, supported: true };
        }
    } catch { /* 旧浏览器/隐私模式 */ }
    return { usage: 0, quota: 500 * 1024 * 1024, ratio: 0, supported: false };
}

/** 是否达到「该压缩了」的水位。 */
export async function isStorageNearLimit(): Promise<boolean> {
    const m = await measureStorage();
    return m.supported && m.ratio >= STORAGE_GUARD_THRESHOLD;
}

// ─── 分层切批 ─────────────────────────────────────────────────────

interface CompactionTier {
    label: string;
    /** 该层目标摘要字数（同一层的所有批都压到这个长度）。 */
    summaryChars: number;
    /** 该层覆盖的原始消息区间占比（按全部可压缩消息的 index，从旧到新）。 */
    range: [number, number];
}

const TIERS: CompactionTier[] = [
    { label: '远古', summaryChars: 100, range: [0.0, 0.5] },
    { label: '中期', summaryChars: 200, range: [0.5, 0.8] },
    { label: '近期', summaryChars: 0, range: [0.8, 1.0] }, // 近期不压，仅占位
];

/** 挑出可压缩消息并切成三层批次。返回 [tier, batchMessages][]。 */
export function planCompactionBatches(messages: Message[]): Array<{ tier: CompactionTier; batch: Message[] }> {
    const compressible = messages.filter(m =>
        (m.role === 'user' || m.role === 'assistant') &&
        m.type === 'text' &&
        typeof m.content === 'string' && m.content.trim().length > 0
    );
    if (compressible.length < 20) return []; // 太少不值得动

    const plans: Array<{ tier: CompactionTier; batch: Message[] }> = [];
    for (const tier of TIERS) {
        if (tier.summaryChars === 0) continue;
        const [lo, hi] = tier.range;
        const slice = compressible.slice(
            Math.floor(compressible.length * lo),
            Math.floor(compressible.length * hi),
        );
        // 段内按字符预算切批
        let batch: Message[] = [];
        let chars = 0;
        for (const msg of slice) {
            const len = msg.content.length;
            if (batch.length >= BATCH_MAX_MESSAGES || (chars + len > BATCH_CHAR_BUDGET && batch.length > 0)) {
                plans.push({ tier, batch });
                batch = []; chars = 0;
            }
            batch.push(msg); chars += len;
        }
        if (batch.length) plans.push({ tier, batch });
    }
    return plans;
}

// ─── LLM 摘要 ─────────────────────────────────────────────────────

/** 拼一批消息成对话文本（带时间戳，便于模型理解先后）。 */
function renderBatch(batch: Message[], charName: string): string {
    const fmt = (ts: number) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    return batch.map(m => {
        const who = m.role === 'user' ? '用户' : charName;
        return `[${fmt(m.timestamp)}] ${who}: ${m.content.replace(/\s+/g, ' ').trim()}`;
    }).join('\n');
}

/**
 * 单批摘要。越早的层 targetChars 越小（= 压得越简）。
 * 失败返回 { ok:false, error }（整批保留原文，不丢数据；错误信息透传给 UI）。
 */
async function summarizeBatch(
    llm: LightLLMConfig,
    batch: Message[],
    charName: string,
    targetChars: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const systemPrompt = `你是「${charName}」的聊天记录压缩器。把下面这段对话压缩成一段 ${targetChars} 字以内的第三人称纪要。
要求：
1. 只保留人物、事件、决定、结果、情绪转折；去掉寒暄、语气词、重复内容。
2. 按时间顺序一段话写完，不要列表、不要 markdown、不要解释。
3. 出现过的专有名词（人名/地名/物品/约定）必须至少保留一次。
直接输出纪要正文。`;

    const convo = renderBatch(batch, charName);
    try {
        const data = await safeFetchJson(
            `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llm.apiKey}` },
                body: JSON.stringify({
                    model: llm.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: convo },
                    ],
                    temperature: 0.3,
                    // 推理型模型的思考过程也算在 max_tokens 里，预算给足：
                    // 思考几百 + 正文几百，再小就会「想完了但没剩篇幅写答案」。
                    max_tokens: 4000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '存储保护', purpose: '旧消息分层摘要' },
        );
        const msg = data?.choices?.[0]?.message || {};
        // 推理模型偶尔把正文留在 reasoning_content（预算耗尽时 content 为空）——兜底取思考文本末段。
        const out = String(msg.content || '').trim() || String(msg.reasoning_content || '').trim().split('\n').filter(Boolean).pop() || '';
        if (!out) return { ok: false, error: '模型返回了空内容' };
        return { ok: true, text: out };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ─── 主流程 ───────────────────────────────────────────────────────

export interface CompactionResult {
    ok: boolean;
    compactedMessages: number;
    batches: number;
    freedEstimateBytes: number;
    skippedReason?: string;
}

/**
 * 对单个角色跑分层压缩：
 *   1. 取全部消息 → 切层切批
 *   2. 逐批调 LLM 摘要（任一批失败即停，绝不半删）
 *   3. 全部成功后：删原消息，插入一条 system 摘要消息（charId 相同、时间戳取该层最早一条）
 * 「全成功才落库」是硬约束——摘要失败一半就把原消息删了 = 真丢记忆。
 *
 * llm 取值优先级由调用方决定（角色副 API → 主 API）。
 */
export async function compactCharacterHistory(
    charId: string,
    charName: string,
    llm: LightLLMConfig,
    opts: { getMessages: () => Promise<Message[]>, deleteMessages: (ids: number[]) => Promise<void>, saveMessage: (msg: any) => Promise<number> },
): Promise<CompactionResult> {
    const messages = await opts.getMessages();
    const plans = planCompactionBatches(messages);
    if (!plans.length) {
        return { ok: true, compactedMessages: 0, batches: 0, freedEstimateBytes: 0, skippedReason: '消息太少或全是近期对话，无需压缩' };
    }

    // 先全部摘要成功，再一次性落库
    const summaries: Array<{ batch: Message[]; summary: string }> = [];
    for (const { tier, batch } of plans) {
        const r = await summarizeBatch(llm, batch, charName, tier.summaryChars);
        if (!r.ok) {
            return { ok: false, compactedMessages: 0, batches: summaries.length, freedEstimateBytes: 0, skippedReason: `「${tier.label}」层摘要失败：${r.error}（未做任何改动）` };
        }
        summaries.push({ batch, summary: r.text });
    }

    // 全成功 → 逐层落库：删原消息 + 插入摘要消息
    let compacted = 0;
    let freedBytes = 0;
    for (const { batch, summary } of summaries) {
        const ids = batch.map(m => m.id);
        freedBytes += batch.reduce((a, m) => a + (m.content?.length || 0), 0);
        await opts.deleteMessages(ids);
        compacted += batch.length;
        await opts.saveMessage({
            charId,
            role: 'system',
            type: 'system',
            content: `【早期对话纪要（${batch.length} 条消息已压缩）】${summary}`,
            timestamp: batch[0].timestamp,
            metadata: { storageCompaction: true, compactedCount: batch.length },
        });
    }

    return { ok: true, compactedMessages: compacted, batches: summaries.length, freedEstimateBytes: freedBytes * 2 /* UTF-16 估算 */ };
}

/** 从角色配置推导压缩用的 LLM 配置（副 API 优先，主 API 兜底）。 */
export function deriveCompactionLlm(char: { name?: string; proactiveConfig?: any; emotionConfig?: any }, apiConfig: APIConfig): LightLLMConfig | null {
    // 角色副 API（主动消息 1.0 的 secondaryApi 是「角色专属备用通道」最常见落点）
    const sec = char?.proactiveConfig?.secondaryApi;
    if (sec?.baseUrl && sec?.apiKey && sec?.model) {
        return { baseUrl: sec.baseUrl, apiKey: sec.apiKey, model: sec.model };
    }
    if (apiConfig?.baseUrl && apiConfig?.apiKey && apiConfig?.model) {
        return { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
    }
    return null;
}

// ─── 全库巡检（设置页手动入口 / 启动自检共用） ─────────────────────

export interface CompactionReport {
    usage: StorageUsage | null;
    nearLimit: boolean;
    results: Array<{ charName: string; result: CompactionResult }>;
}

/**
 * 巡检全部角色：水位达标才动手；未达标只报用量（force 时跳过水位检查，设置页手动入口用）。
 * 返回逐角色的执行结果，UI 汇总展示。
 */
export async function runStorageCompaction(
    characters: Array<{ id: string; name?: string }>,
    apiConfig: APIConfig,
    opts: {
        getCharMessages: (charId: string) => Promise<Message[]>,
        deleteMessages: (ids: number[]) => Promise<void>,
        saveMessage: (msg: any) => Promise<number>,
        llmFor?: (char: { id: string; name?: string }) => LightLLMConfig | null,
    },
    flags: { force?: boolean } = {},
): Promise<CompactionReport> {
    const usage = await measureStorage();
    const nearLimit = usage.supported && usage.ratio >= STORAGE_GUARD_THRESHOLD;
    if (!nearLimit && !flags.force) {
        return { usage, nearLimit: false, results: [] };
    }

    const results: CompactionReport['results'] = [];
    for (const char of characters) {
        const llm = opts.llmFor
            ? opts.llmFor(char)
            : deriveCompactionLlm(char as any, apiConfig);
        if (!llm) continue;
        const result = await compactCharacterHistory(
            char.id,
            char.name || '角色',
            llm,
            { getMessages: () => opts.getCharMessages(char.id), deleteMessages: opts.deleteMessages, saveMessage: opts.saveMessage },
        );
        results.push({ charName: char.name || char.id, result });
    }
    return { usage, nearLimit: true, results };
}
