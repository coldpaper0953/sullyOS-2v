/**
 * API 自动故障转移（ArtBot 式轮换）
 *
 * 需求：主聊天请求返回 429（限流）或其他错误时，先按用户设定的次数 N 重试；
 * 仍失败就自动切换到轮换列表（API 预设列表）里的下一个 API，全程无需用户介入。
 *
 * 轮换列表来源：全局 API 预设（os_api_presets），当前生效的配置排第一，
 * 其余预设按顺序排在后面。只有 ≥2 条可用配置时切换才有意义；单配置时只做重试。
 *
 * 会话内粘性：切换成功后记住"这次救了命的配置"，同一会话内后续请求直接优先
 * 用它，避免每条消息都先撞一次墙。用户手动换配置（传入的 primary 变了）时
 * 粘性自动失效——手动选择永远优先于自动决策。
 *
 * 计费安全：429/网络错误/HTML 错误页都是"请求没被生成"，重试不会双重计费；
 * 5xx 也按可重试处理（用户明确要求"或其他错误"）。401/403/404 属于换一家能
 * 解决的问题，直接切换不浪费重试次数。
 */

import type { ApiPreset } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';

const CONFIG_KEY = 'sullyos_api_failover_v1';

export interface ApiFailoverConfig {
    enabled: boolean;
    /** 每个候选 API 上的重试次数（0-10） */
    retriesPerApi: number;
}

export interface FailoverCandidate {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 显示名（切换提示用）：预设名或「当前配置」 */
    name: string;
}

const DEFAULT_CONFIG: ApiFailoverConfig = { enabled: true, retriesPerApi: 2 };

export function loadApiFailoverConfig(): ApiFailoverConfig {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_CONFIG };
        const parsed = JSON.parse(raw) as Partial<ApiFailoverConfig>;
        return {
            enabled: parsed.enabled !== false,
            retriesPerApi: Number.isFinite(Number(parsed.retriesPerApi))
                ? Math.max(0, Math.min(10, Math.trunc(Number(parsed.retriesPerApi) || 0)))
                : DEFAULT_CONFIG.retriesPerApi,
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveApiFailoverConfig(config: ApiFailoverConfig): void {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({
            enabled: config.enabled === true,
            retriesPerApi: Math.max(0, Math.min(10, Math.trunc(Number(config.retriesPerApi) || 0))),
        }));
    } catch { /* ignore */ }
}

function loadPresets(): ApiPreset[] {
    try {
        const raw = localStorage.getItem('os_api_presets');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function candidateIdentity(c: { baseUrl: string; apiKey: string; model: string }): string {
    return [
        normalizeApiBaseUrl(c.baseUrl || ''),
        normalizeApiCredential(c.apiKey || ''),
        normalizeApiModel(c.model || ''),
    ].join('|');
}

/** 轮换候选序列：当前配置 → 其余预设（与当前重复的跳过）。返回 [候选, 是否粘性命中] */
export function buildRotationCandidates(
    primary: { baseUrl: string; apiKey: string; model: string },
): { candidates: FailoverCandidate[]; stickyHit: boolean } {
    const candidates: FailoverCandidate[] = [
        { baseUrl: primary.baseUrl, apiKey: primary.apiKey, model: primary.model, name: '当前配置' },
    ];
    const seen = new Set([candidateIdentity(primary)]);
    for (const preset of loadPresets()) {
        const c = preset?.config;
        if (!c?.baseUrl || !c.apiKey || !c.model) continue;
        const id = candidateIdentity(c);
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, name: preset.name || `预设 ${candidates.length}` });
    }
    // 会话内粘性：上次故障转移救活的配置优先
    if (stickyCandidate && seen.has(candidateIdentity(stickyCandidate))) {
        const idx = candidates.findIndex(c => candidateIdentity(c) === candidateIdentity(stickyCandidate!));
        if (idx > 0) {
            const [hit] = candidates.splice(idx, 1);
            candidates.unshift(hit);
            return { candidates, stickyHit: true };
        }
    }
    return { candidates, stickyHit: false };
}

// ── 会话内粘性状态（模块级，刷新即重置；primary 变了就清）──
let stickyCandidate: FailoverCandidate | null = null;
let lastSeenPrimaryId = '';

function classifyError(error: unknown): 'retry' | 'switch' | 'fatal' {
    const message = error instanceof Error ? error.message : String(error ?? '');
    // 用户按了「停止生成」：不重试、不换候选，立刻结束整轮
    if ((error as { name?: string })?.name === 'AbortError') return 'fatal';
    // 401/403/404/模型不存在：重试同一个 API 没有意义，直接换下家
    if (/API Error (401|403|404)/.test(message)) return 'switch';
    // 429 / 5xx / 网络错误 / HTML 错误页 / 超时：可重试
    if (/API Error (429|5\d\d)/.test(message)) return 'retry';
    if (/超时|timeout|aborted/i.test(message)) return 'retry';
    if (error instanceof TypeError) return 'retry'; // fetch 网络层失败
    if (/API返回了HTML|API返回了空响应|API返回了无效JSON|Failed to fetch|NetworkError/i.test(message)) return 'retry';
    return 'fatal';
}

/**
 * 带故障转移的执行器。
 *
 * 顺序是确定的：当前配置 → 其余预设（按预设列表顺序，重复的跳过），每个候选最多
 * 重试 retriesPerApi 次，且**全局有硬上限**：总尝试次数 ≤ MAX_TOTAL_ATTEMPTS、
 * 总耗时 ≤ TOTAL_BUDGET_MS。上限存在的原因：预设一多（5 个 × 2 次重试 = 15 次尝试，
 * 每次几十秒）就会连着转好几分钟，用户看着就是"卡死在一直请求失败"。
 *
 * @param attempt 对单个候选 API 执行一次完整请求（含调用方自己的兼容重试逻辑），
 *                抛错即视为该候选本轮失败。
 * @param onSwitch 实际发生切换时回调（用于 toast 提示）。
 */
const MAX_TOTAL_ATTEMPTS = 6;
const TOTAL_BUDGET_MS = 120_000;

export async function runWithApiFailover<T>(input: {
    primary: { baseUrl: string; apiKey: string; model: string };
    attempt: (candidate: FailoverCandidate) => Promise<T>;
    onSwitch?: (candidate: FailoverCandidate, reason: string) => void;
}): Promise<T> {
    const primaryId = candidateIdentity(input.primary);
    if (primaryId !== lastSeenPrimaryId) {
        // 用户手动换过配置 → 粘性作废，尊重手动选择
        stickyCandidate = null;
        lastSeenPrimaryId = primaryId;
    }
    const config = loadApiFailoverConfig();
    const { candidates, stickyHit } = buildRotationCandidates(input.primary);

    let lastError: unknown;
    let totalAttempts = 0;
    const startedAt = Date.now();
    const outOfBudget = () => totalAttempts >= MAX_TOTAL_ATTEMPTS || (Date.now() - startedAt) > TOTAL_BUDGET_MS;
    for (let ci = 0; ci < candidates.length; ci++) {
        if (outOfBudget()) break;
        const candidate = candidates[ci];
        const attemptLimit = config.enabled ? config.retriesPerApi : 0;
        for (let attemptIdx = 0; attemptIdx <= attemptLimit; attemptIdx++) {
            if (outOfBudget()) break;
            totalAttempts++;
            try {
                const result = await input.attempt(candidate);
                if (ci > 0 || stickyHit) stickyCandidate = candidate;
                return result;
            } catch (error) {
                lastError = error;
                const kind = classifyError(error);
                if (kind === 'fatal') throw error;
                if (kind === 'switch' || attemptIdx >= attemptLimit) break; // 换下一个候选
                // 指数退避：1s, 2s, 4s...（429 常带 Retry-After，这里简化处理）
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attemptIdx) * 1000));
            }
        }
        // 本候选耗尽 → 切换下一个（有下一个、且预算还够才提示）
        if (ci + 1 < candidates.length && !outOfBudget()) {
            const next = candidates[ci + 1];
            const reason = lastError instanceof Error ? lastError.message.slice(0, 120) : '请求失败';
            if (config.enabled) {
                input.onSwitch?.(next, reason);
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('API请求失败');
}
