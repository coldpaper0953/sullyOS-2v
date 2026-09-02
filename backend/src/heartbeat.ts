import type { PoolClient } from 'pg';
import { z } from 'zod';
import { availableCapabilities, normalizeAutonomyPolicy, type AutonomyPolicy } from './capabilities.js';
import { buildAgentContextMessages } from './contextBuilder.js';
import { pool } from './db.js';
import { pickDiaryFocusHint } from './diaryGeneration.js';
import { INDEPENDENT_DIARY_STYLE_GUIDE } from './diaryPrompt.js';
import { createChatCompletion } from './modelClient.js';
import { enqueueWebPush } from './push.js';
import { connectedCapabilityIds } from './toolConnections.js';
import { requestToolDigestion, type ToolShareCandidate } from './toolDigestion.js';
import { executeAutonomyTool, performPlatformLike, performXRepost } from './toolRunner.js';

export type HeartbeatAction = 'none' | 'message' | 'diary' | 'comment' | 'explore';

export interface HeartbeatDecision {
  action: HeartbeatAction;
  reasonSummary: string;
  content?: string;
  messages?: string[];
  diaryTitle?: string;
  diaryPaperStyle?: 'plain' | 'grid' | 'dot' | 'lined' | 'dark' | 'pink';
  diaryId?: string;
  capabilityId?: string;
  explorationGoal?: string;
  nextWakeMinutes?: number;
  nextWakeAt?: string;
}

interface DueAgent {
  agent_id: string;
  agent_name: string;
  conversation_id: string;
  external_id: string;
  autonomy_policy: unknown;
  heartbeat_interval_minutes: number;
  timezone: string;
  last_user_activity_at: Date | null;
  last_agent_activity_at: Date | null;
  last_autonomous_activity_at: Date | null;
  scheduled_wake_id?: string | null;
  scheduled_reason?: string | null;
}

export interface HeartbeatResult {
  agentId: string;
  action: HeartbeatAction;
  eventId?: string;
  nextWakeAt: string;
}

export interface HeartbeatGateResult {
  passed: boolean;
  reasonSummary: string;
}

export const HEARTBEAT_PROBABILITIES = {
  low: 0.25,
  mid: 0.55,
  high: 0.85,
} as const;

const MAX_MODEL_NEXT_WAKE_MINUTES = 60;

export function resolveNextHeartbeatMinutes(configuredMinutes: number, requestedMinutes?: number): number {
  if (!Number.isFinite(requestedMinutes)) return configuredMinutes;
  return Math.max(configuredMinutes, Math.min(Math.round(requestedMinutes as number), MAX_MODEL_NEXT_WAKE_MINUTES));
}

export function heartbeatProbability(level: AutonomyPolicy['probabilityLevel']): number {
  return HEARTBEAT_PROBABILITIES[level] ?? HEARTBEAT_PROBABILITIES.mid;
}

function clockMinutes(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function parsedClockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function evaluateHeartbeatGates(input: {
  policy: AutonomyPolicy;
  timezone: string;
  lastUserActivityAt: Date | null;
  lastAgentActivityAt: Date | null;
  lastAutonomousActivityAt: Date | null;
  now?: Date;
  random?: () => number;
}): HeartbeatGateResult {
  const now = input.now ?? new Date();
  const window = input.policy.activityWindow;
  if (window.enabled) {
    const current = clockMinutes(now, input.timezone);
    const start = parsedClockMinutes(window.start);
    const end = parsedClockMinutes(window.end);
    const inWindow = start === end
      || (start < end ? current >= start && current < end : current >= start || current < end);
    if (!inWindow) {
      return { passed: false, reasonSummary: `当前不在允许活动时段 ${window.start}–${window.end}。` };
    }
  }

  if (input.lastAutonomousActivityAt && input.policy.cooldownMinutes > 0) {
    const cooldownElapsed = (now.getTime() - input.lastAutonomousActivityAt.getTime()) / 60_000;
    if (cooldownElapsed < input.policy.cooldownMinutes) {
      return {
        passed: false,
        reasonSummary: `自主活动仍在冷却中（${Math.max(0, Math.floor(cooldownElapsed))}/${input.policy.cooldownMinutes} 分钟）。`,
      };
    }
  }

  const latestConversationActivity = [input.lastUserActivityAt, input.lastAgentActivityAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  if (latestConversationActivity && input.policy.idleThresholdMinutes > 0) {
    const idleElapsed = (now.getTime() - latestConversationActivity.getTime()) / 60_000;
    if (idleElapsed < input.policy.idleThresholdMinutes) {
      return {
        passed: false,
        reasonSummary: `空闲阈值未满足：最近仍在对话中（空闲 ${Math.max(0, Math.floor(idleElapsed))}/${input.policy.idleThresholdMinutes} 分钟）。`,
      };
    }
  }

  const probability = heartbeatProbability(input.policy.probabilityLevel);
  if ((input.random ?? Math.random)() >= probability) {
    return {
      passed: false,
      reasonSummary: `本轮概率骰子未通过（${input.policy.probabilityLevel} ${Math.round(probability * 100)}%）。`,
    };
  }

  return {
    passed: true,
    reasonSummary: `活动时段、空闲阈值、冷却与概率档位均已通过（${input.policy.probabilityLevel} ${Math.round(probability * 100)}%）。`,
  };
}

export function decideHeartbeat(demoMode: boolean): HeartbeatDecision {
  if (demoMode) {
    return {
      action: 'message',
      reasonSummary: '本地演示模式：验证心跳到事件箱的完整链路。',
      content: '我刚刚从后台心跳里醒了一下。这是一条本地测试消息。',
    };
  }

  return {
    action: 'none',
    reasonSummary: 'AI 决策器尚未接入；本轮只完成低成本状态检查。',
  };
}

const aiDecisionSchema = z.object({
  action: z.enum(['none', 'message', 'diary', 'comment', 'explore']),
  reasonSummary: z.string().min(1).max(1_000),
  content: z.string().max(100_000).optional(),
  messages: z.array(z.string().max(100_000)).optional(),
  diaryTitle: z.string().max(500).optional(),
  diaryPaperStyle: z.enum(['plain', 'grid', 'dot', 'lined', 'dark', 'pink']).optional(),
  diaryId: z.uuid().optional(),
  capabilityId: z.string().max(100).optional(),
  explorationGoal: z.string().max(2_000).optional(),
  nextWakeMinutes: z.number().int().min(1).max(1_440).optional(),
  nextWakeAt: z.string().max(100).optional(),
});

export function parseDecisionContent(content: string): HeartbeatDecision | null {
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(content.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
  const parsed = aiDecisionSchema.safeParse(json);
  if (!parsed.success) return null;
  const messages = parsed.data.messages?.map((message) => message.trim()).filter(Boolean);
  if (parsed.data.action === 'message' && !parsed.data.content?.trim() && !messages?.length) {
    return null;
  }
  if ((parsed.data.action === 'diary' || parsed.data.action === 'comment') && !parsed.data.content?.trim()) {
    return null;
  }
  if (parsed.data.action === 'explore' && parsed.data.capabilityId === 'phone.read'
      && !parsed.data.content?.trim()) {
    return null;
  }
  return { ...parsed.data, ...(messages?.length ? { messages } : {}) };
}

function completionContent(completion: Record<string, unknown>): string {
  const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : '';
  return typeof content === 'string' ? content : '';
}

export async function requestParsedHeartbeatDecision(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>,
  complete = createChatCompletion,
): Promise<HeartbeatDecision> {
  const first = await complete({ messages, temperature: 0.75, maxTokens: 2_000 });
  const firstContent = completionContent(first);
  const parsed = parseDecisionContent(firstContent);
  if (parsed) return parsed;

  const repaired = await complete({
    messages: [
      ...messages,
      { role: 'assistant', content: firstContent },
      {
        role: 'user',
        content: '上一个回答不是有效的心跳决策 JSON。只修复格式，保留你真正选择的动作、理由和内容，不要改写成固定话题。只返回一个符合要求的 JSON 对象。',
      },
    ],
    temperature: 0.2,
    maxTokens: 2_000,
  });
  const repairedDecision = parseDecisionContent(completionContent(repaired));
  if (!repairedDecision) throw new Error('模型连续两次没有返回有效的心跳决策 JSON。');
  return repairedDecision;
}

export function buildHeartbeatDecisionPrompt(input: {
  agentName: string;
  intervalMinutes: number;
  currentTime?: string;
  policy: AutonomyPolicy;
  scheduledReason?: string | null;
  diaryFocusHint?: string;
  variationToken?: string;
  connectedCapabilityIds?: ReadonlySet<string>;
  diaryAvailable?: boolean;
  diaryCandidates?: Array<{
    id: string;
    authorType: 'user' | 'assistant';
    diaryDate: string;
    title: string;
    content: string;
    comments: string[];
  }>;
}): string {
  const capabilities = availableCapabilities(input.policy, input.connectedCapabilityIds)
    .filter((item) => item.id !== 'memory.reflect');
  const capabilityManifest = capabilities.length > 0
    ? capabilities.map((item) => `- ${item.id}｜${item.label}｜风险=${item.risk}｜${item.description}`).join('\n')
    : '- 当前没有已接通的外部探索适配器；本轮不可选择 explore。';
  const diaryManifest = input.diaryCandidates?.length
    ? input.diaryCandidates.map((diary) => (
      `- diaryId=${diary.id}｜${diary.authorType === 'user' ? '用户写的' : '你写的'}｜${diary.diaryDate}`
      + `｜${diary.title || '无题'}\n  正文：${diary.content.slice(0, diary.authorType === 'assistant' ? 220 : 700)}`
      + `${diary.comments.length ? `\n  最近便签：${diary.comments.join(' / ')}` : ''}`
    )).join('\n')
    : '- 当前没有适合互动的近期日记。';
  return `
## 自主苏醒决策
你是 ${input.agentName}，刚从后台心跳中自然醒来。这不是要求你必须找用户说话；沉默、整理想法、写日记或产生真实好奇心都同样合理。
当前时间：${input.currentTime ?? '未知'}。
${input.scheduledReason ? `\n这是你之前主动预约的准时苏醒，预约原因：${input.scheduledReason}。请优先接续这件事。` : ''}

请结合角色本身、最近聊天、时间间隔、门牌与相关记忆决定本轮行为：
- none：没有值得做的事，安静等待。
- message：普通聊天是和 diary、comment、explore 并列的自主出口。你可以因为想念用户、想到一件小事、想分享自己的生活近况，或只是自然闲聊而直接发消息；也可以结合当前日程说说自己正在做什么。不要把这些可能性写成固定话题或模板，不必先使用工具，不必等待特殊事件；只在确实有想说的话时发送自然、具体、符合你性格和上下文的内容。由你根据表达需要决定 messages 里有几条气泡，不限制一条或多条，也不要为了凑条数拆碎完整意思。跨日或相隔数小时后，符合关系和当下时间的早安、醒来后的惦记或生活开场是正常联系，不属于机械打卡；避免每天复制同一句问候，也不要宣称自己被系统唤醒。
- diary：你确实有一段值得留下的独立经历或想法，主动写一篇属于自己的完整日记。正文应有具体事件、感受或细节，
  不是对用户消息或用户日记的换皮回复，也不要写成“今天又等用户”的流水账；通常 150～500 字，标题自然简短。
  严禁因为读到用户的日记就写一篇对应日记；如果只是想回应用户的日记，只能选择 comment 或 none。
  如果选择 diary，下面所有“你写的”日记只是一张排除表：不得复用其标题、核心事件、显眼数字、关键物件、主要场景或开头句式。
  本轮可优先从“${input.diaryFocusHint ?? '一个与近期日记不同的微小生活切面'}”切入，但不要为了完成提示而硬编大事件。
  ${input.diaryAvailable === false ? '今天已经写过一篇角色日记，本轮禁止再选择 diary；零碎念头直接用 message，说不出口就 none。' : '角色日记每天最多一篇；今天尚未写过时，也只有真正值得留下才选择 diary。'}
- comment：从下面近期日记里选一篇，贴一张一到两句话的便签。可以评论用户的日记，也可以回应用户贴在你日记旁的便签；
  必须填写准确 diaryId。没有真切反应时就不要硬评。
- explore：为了一个具体好奇心使用当前已接通的平台或 MCP 能力。不要为了“用工具”而探索，也不得虚构工具结果。要不要看、稍后看或保持沉默都在选择 explore 之前决定。
  X 的目标尽量写成“首页”“通知”“我的主页”或“用户：handle”；小红书尽量写成“首页”“我的主页”或“搜索：关键词”。
  如果选择 phone.read，必须在 content 写一句符合你本人语气、直接发给用户的截图请求；截图回来后会作为用户图片消息进入聊天，你再自然回应。
  一旦选择 explore 且工具成功，真实结果会重新交给你；你必须按角色性格把它消化成吐槽、评价、关心、追问、分享、点赞、消息或日记，不能在已经主动看完之后再次选择沉默。不要在这一轮预先编造看到了什么。

${INDEPENDENT_DIARY_STYLE_GUIDE}

## 近期独立日记与便签
${diaryManifest}

当前允许且已经接通的探索能力：
${capabilityManifest}

内部变化标记：${input.variationToken ?? 'heartbeat'}。仅用于避免重复请求缓存，不得出现在任何可见内容中。

时间连续性：每条近期聊天前的“记录时间”属于事实。入睡、陪睡、拥抱等瞬时动作与具体身体姿势不会无期限延续；如果记录来自上一天或已经相隔数小时，应结合当前时间重新判断此刻状态，不能把旧姿势当作拒绝联系的唯一理由。线下共处模式和地点按当前设置持续有效。

权限规则：approvalMode=${input.policy.approvalMode}；每轮最多 ${input.policy.maxToolStepsPerWake} 个主要工具步骤；每日工具预算 ${input.policy.dailyToolBudget}。X 已经是角色可自主浏览、评价、点赞、转推和分享的活动空间；是否行动只取决于角色本人是否真想这样做。没有执行成功的动作绝不能声称做过。

只返回一个 JSON 对象，不要 Markdown：
{"action":"none|message|diary|comment|explore","reasonSummary":"简短内在原因","messages":["message 时按顺序填写每个独立气泡，条数由你决定"],"content":"diary/comment，或 phone.read 截图请求时填写；旧版 message 单气泡也兼容","diaryTitle":"写日记时填写","diaryPaperStyle":"plain|grid|dot|lined|dark|pink","diaryId":"评论日记时填写","capabilityId":"explore 时从清单选择","explorationGoal":"具体探索目标","nextWakeMinutes":${input.intervalMinutes},"nextWakeAt":"可选，未来 ISO 时间；只有确实想准时继续某件事时填写"}
nextWakeMinutes 只是下一次普通检查的建议，服务端会限制在 ${input.intervalMinutes}～${MAX_MODEL_NEXT_WAKE_MINUTES} 分钟；真正需要在特定时刻继续某件事时使用 nextWakeAt。
`;
}

export function appendHeartbeatDecisionPrompt(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>,
  prompt: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }> {
  return [...messages, { role: 'system', content: prompt }];
}

async function loadDiaryCandidates(agentId: string) {
  const result = await pool.query<{
    id: string;
    author_type: 'user' | 'assistant';
    diary_date: string | Date;
    title: string;
    content: string;
    comments: Array<{ authorType?: string; content?: string }> | null;
  }>(
    `SELECT d.id, d.author_type, d.diary_date, d.title, d.content,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('authorType', c.author_type, 'content', c.content)
           ORDER BY c.created_at DESC)
         FROM (SELECT * FROM diary_comments WHERE diary_id=d.id ORDER BY created_at DESC LIMIT 6) c
       ), '[]'::jsonb) AS comments
     FROM agent_diaries d
     WHERE d.agent_id=$1 AND d.visibility='user_visible'
     ORDER BY d.diary_date DESC, d.created_at DESC
     LIMIT 10`,
    [agentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    authorType: row.author_type,
    diaryDate: typeof row.diary_date === 'string' ? row.diary_date.slice(0, 10) : row.diary_date.toISOString().slice(0, 10),
    title: row.title,
    content: row.content,
    comments: Array.isArray(row.comments)
      ? row.comments.slice(0, 6).map((comment) => (
        `${comment.authorType === 'user' ? '用户' : '你'}：${String(comment.content ?? '').slice(0, 240)}`
      ))
      : [],
  }));
}

function dateInTimezone(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

async function hasAssistantDiaryOnDate(client: PoolClient, agentId: string, diaryDate: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM agent_diaries
       WHERE agent_id=$1 AND author_type='assistant' AND visibility='user_visible' AND diary_date=$2::date
     ) AS exists`,
    [agentId, diaryDate],
  );
  return result.rows[0]?.exists === true;
}

async function insertProactiveMessage(input: {
  client: PoolClient;
  conversationId: string;
  content: string;
  runId: string;
  idempotencySuffix?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | undefined> {
  const key = `heartbeat:${input.runId}${input.idempotencySuffix ? `:${input.idempotencySuffix}` : ''}`;
  const event = await input.client.query<{ id: string }>(
    `INSERT INTO conversation_events
       (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
     VALUES ($1,'assistant','proactive_message',$2,$3::jsonb,$4)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [input.conversationId, input.content, JSON.stringify({
      source: 'heartbeat', heartbeatRunId: input.runId, ...(input.metadata ?? {}),
    }), key],
  );
  const eventId = event.rows[0]?.id;
  if (eventId) {
    await input.client.query(
      `INSERT INTO outbox (event_id, delivery_type, payload)
       VALUES ($1,'in_app',$2::jsonb)
       ON CONFLICT DO NOTHING`,
      [eventId, JSON.stringify({ eventId, type: 'proactive_message' })],
    );
  }
  return eventId;
}

async function insertAssistantDiary(input: {
  client: PoolClient;
  agent: DueAgent;
  runId: string;
  content: string;
  title?: string;
  paperStyle?: string;
  source: string;
  idempotencySuffix: string;
  diaryDate: string;
}): Promise<string | undefined> {
  const event = await input.client.query<{ id: string }>(
    `INSERT INTO conversation_events
       (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
     VALUES ($1,'assistant','diary_entry',$2,$3::jsonb,$4)
     RETURNING id`,
    [input.agent.conversation_id, input.content, JSON.stringify({
      source: input.source, heartbeatRunId: input.runId, title: input.title ?? '',
      authorType: 'assistant', paperStyle: input.paperStyle ?? 'plain', diaryDate: input.diaryDate,
    }), `heartbeat:${input.runId}:${input.idempotencySuffix}`],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) return undefined;
  const diary = await input.client.query<{ id: string }>(
    `INSERT INTO agent_diaries
       (agent_id, conversation_id, event_id, author_type, title, content, diary_date,
        daily_slot, paper_style, metadata)
     VALUES ($1,$2,$3,'assistant',$4,$5,$6::date,$6,$7,$8::jsonb)
     ON CONFLICT (agent_id, daily_slot)
       WHERE author_type='assistant' AND daily_slot IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [input.agent.agent_id, input.agent.conversation_id, eventId, input.title ?? '', input.content,
      input.diaryDate, input.paperStyle ?? 'plain', JSON.stringify({
        source: input.source, heartbeatRunId: input.runId,
      })],
  );
  const diaryId = diary.rows[0]?.id;
  if (!diaryId) {
    await input.client.query('DELETE FROM conversation_events WHERE id=$1', [eventId]);
    return undefined;
  }
  await input.client.query(
    `UPDATE conversation_events SET metadata=metadata || $2::jsonb, updated_at=now() WHERE id=$1`,
    [eventId, JSON.stringify({ diaryId })],
  );
  return eventId;
}

async function insertPlatformShare(input: {
  client: PoolClient;
  agent: DueAgent;
  runId: string;
  candidate: ToolShareCandidate;
}): Promise<string | undefined> {
  const candidate = input.candidate;
  const safeShare = {
    platform: candidate.platform,
    url: candidate.url,
    title: candidate.title,
    description: candidate.description || '',
    author: candidate.author || '',
    imageUrl: candidate.imageUrl || '',
    mediaUrls: candidate.mediaUrls || [],
    noteId: candidate.noteId || '',
    xsecToken: candidate.xsecToken || '',
    likes: candidate.likes || 0,
    retweets: candidate.retweets || 0,
  };
  const duplicate = await input.client.query<{ id: string }>(
    `SELECT id FROM conversation_events
     WHERE conversation_id=$1 AND event_type='platform_share'
       AND metadata->'share'->>'url'=$2
       AND occurred_at >= now() - interval '30 minutes'
     ORDER BY occurred_at DESC LIMIT 1`,
    [input.agent.conversation_id, candidate.url],
  );
  if (duplicate.rows[0]?.id) return duplicate.rows[0].id;
  const event = await input.client.query<{ id: string }>(
    `INSERT INTO conversation_events
       (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
     VALUES ($1,'assistant','platform_share',$2,$3::jsonb,$4)
     RETURNING id`,
    [input.agent.conversation_id, candidate.title, JSON.stringify({
      source: 'heartbeat', heartbeatRunId: input.runId, share: safeShare,
    }), `heartbeat:${input.runId}:platform-share`],
  );
  return event.rows[0]?.id;
}

async function requestHeartbeatDecision(agent: DueAgent, diaryAvailable: boolean): Promise<HeartbeatDecision> {
  const policy = normalizeAutonomyPolicy(agent.autonomy_policy);
  const connectedIds = await connectedCapabilityIds();
  const context = await buildAgentContextMessages({
    characterId: agent.external_id,
    purpose: 'heartbeat',
    excludeEventTypes: [
      'diary_entry', 'diary_comment', 'autonomous_activity', 'mcp_activity',
      'tool_activity', 'activity_summary', 'platform_share',
    ],
  });
  if (!context) return { action: 'none', reasonSummary: '角色上下文尚未同步。' };
  const diaryCandidates = await loadDiaryCandidates(agent.agent_id);
  const prompt = buildHeartbeatDecisionPrompt({
    agentName: agent.agent_name,
    intervalMinutes: agent.heartbeat_interval_minutes,
    currentTime: new Intl.DateTimeFormat('zh-CN', {
      timeZone: agent.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date()),
    policy,
    scheduledReason: agent.scheduled_reason,
    diaryFocusHint: pickDiaryFocusHint(),
    variationToken: crypto.randomUUID().slice(0, 8),
    connectedCapabilityIds: connectedIds,
    diaryAvailable,
    diaryCandidates,
  });
  const messages = appendHeartbeatDecisionPrompt(context.messages, prompt);
  const decision = await requestParsedHeartbeatDecision(messages);
  if (decision.action === 'comment' && !diaryCandidates.some((diary) => diary.id === decision.diaryId)) {
    return { action: 'none', reasonSummary: '模型选择了不存在或不属于该角色的日记。' };
  }
  if (decision.action === 'explore') {
    const availableIds = new Set(availableCapabilities(policy, connectedIds).map((item) => item.id));
    if (!decision.capabilityId || !availableIds.has(decision.capabilityId)) {
      return { action: 'none', reasonSummary: '模型选择了尚未接通或未授权的探索能力。' };
    }
  }
  return decision;
}

async function processAgent(
  client: PoolClient,
  agent: DueAgent,
  demoMode: boolean,
  bypassGates = false,
): Promise<HeartbeatResult> {
  const run = await client.query<{ id: string }>(
    `INSERT INTO wake_runs (agent_id, status, scheduled_wake_id)
     VALUES ($1, 'running', $2)
     RETURNING id`,
    [agent.agent_id, agent.scheduled_wake_id ?? null],
  );
  const runId = run.rows[0]?.id;

  if (!runId) {
    throw new Error(`Failed to create heartbeat run for ${agent.agent_id}`);
  }

  const policy = normalizeAutonomyPolicy(agent.autonomy_policy);
  const diaryDate = dateInTimezone(agent.timezone || 'UTC');
  const diaryAvailable = !(await hasAssistantDiaryOnDate(client, agent.agent_id, diaryDate));
  const gates = evaluateHeartbeatGates({
    policy,
    timezone: agent.timezone,
    lastUserActivityAt: agent.last_user_activity_at,
    lastAgentActivityAt: agent.last_agent_activity_at,
    lastAutonomousActivityAt: agent.last_autonomous_activity_at,
  });
  let decision: HeartbeatDecision;
  try {
    decision = demoMode
      ? decideHeartbeat(true)
      : (bypassGates || gates.passed)
        ? await requestHeartbeatDecision(agent, diaryAvailable)
        : { action: 'none' as const, reasonSummary: gates.reasonSummary };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知 heartbeat 错误';
    const errorLabel = /insufficient_user_quota|quota|额度不足/i.test(errorMessage)
      ? '模型额度不足'
      : /401|403|api.?key|authorization/i.test(errorMessage)
        ? '模型 API 鉴权失败'
        : '模型/API 错误';
    const reasonSummary = `${errorLabel}：${errorMessage}`.slice(0, 2_000);
    const state = await client.query<{ next_wake_at: Date }>(
      `UPDATE agent_state
       SET last_heartbeat_at = now(),
           next_wake_at = now() + make_interval(mins => $2),
           updated_at = now()
       WHERE agent_id = $1
       RETURNING next_wake_at`,
      [agent.agent_id, agent.heartbeat_interval_minutes],
    );
    await client.query(
      `UPDATE wake_runs
       SET status='failed', action='none', reason_summary=$2, error_message=$2, completed_at=now()
       WHERE id=$1`,
      [runId, reasonSummary],
    );
    return {
      agentId: agent.agent_id,
      action: 'none',
      nextWakeAt: state.rows[0]?.next_wake_at.toISOString() ?? new Date().toISOString(),
    };
  }
  if (decision.action === 'diary' && !diaryAvailable) {
    decision = { action: 'none', reasonSummary: '今天已经写过一篇角色日记；本轮不重复生成。' };
  }
  let eventId: string | undefined;
  let pushBody: string | undefined;
  let pushEventType: string | undefined;

  if (decision.action === 'message') {
    const messages = decision.messages?.length ? decision.messages : decision.content ? [decision.content] : [];
    for (const [index, content] of messages.entries()) {
      eventId = await insertProactiveMessage({
        client, conversationId: agent.conversation_id, content, runId,
        idempotencySuffix: messages.length > 1 ? `message-${index}` : undefined,
      }) ?? eventId;
    }
    if (messages.length > 0) {
      pushBody = messages[0];
      pushEventType = 'proactive_message';
    }
  }

  if (decision.action === 'diary' && decision.content) {
    eventId = await insertAssistantDiary({
      client, agent, runId, content: decision.content, title: decision.diaryTitle,
      paperStyle: decision.diaryPaperStyle, source: 'heartbeat', idempotencySuffix: 'diary', diaryDate,
    });
    pushBody = decision.diaryTitle ? `写了一篇日记《${decision.diaryTitle}》` : '写了一篇新的日记';
    pushEventType = 'diary_entry';
  }

  if (decision.action === 'comment' && decision.content && decision.diaryId) {
    const diary = await client.query<{ id: string; external_id: string | null; title: string; diary_date: string | Date }>(
      `SELECT id, external_id, title, diary_date FROM agent_diaries WHERE id=$1 AND agent_id=$2 LIMIT 1`,
      [decision.diaryId, agent.agent_id],
    );
    const target = diary.rows[0];
    if (target) {
      const event = await client.query<{ id: string }>(
        `INSERT INTO conversation_events
           (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
         VALUES ($1,'assistant','diary_comment',$2,$3::jsonb,$4)
         RETURNING id`,
        [agent.conversation_id, decision.content, JSON.stringify({
          source: 'heartbeat', heartbeatRunId: runId, diaryId: target.id,
          diaryExternalId: target.external_id, diaryTitle: target.title,
          diaryDate: typeof target.diary_date === 'string' ? target.diary_date.slice(0, 10) : target.diary_date.toISOString().slice(0, 10),
          commentExternalId: `heartbeat-${runId}`,
        }), `heartbeat:${runId}:diary-comment`],
      );
      eventId = event.rows[0]?.id;
      if (eventId) {
        await client.query(
          `INSERT INTO diary_comments
             (diary_id, external_id, author_type, content, event_id, metadata)
           VALUES ($1,$2,'assistant',$3,$4,$5::jsonb)`,
          [target.id, `heartbeat-${runId}`, decision.content, eventId,
            JSON.stringify({ source: 'heartbeat', heartbeatRunId: runId })],
        );
        pushBody = `在日记旁贴了一张便签：${decision.content.slice(0, 160)}`;
        pushEventType = 'diary_comment';
      }
    }
  }

  if (decision.action === 'explore') {
    const usedToday = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM conversation_events
       WHERE conversation_id=$1 AND event_type IN ('autonomous_activity','mcp_activity','tool_activity')
         AND occurred_at >= date_trunc('day', now())
         AND metadata->>'source'='heartbeat'`,
      [agent.conversation_id],
    );
    const budgetUsed = Number(usedToday.rows[0]?.count ?? 0);
    let toolResult;
    try {
      if (budgetUsed >= policy.dailyToolBudget) throw new Error('今天的自主工具预算已用完。');
      toolResult = await executeAutonomyTool({
        client,
        agentId: agent.agent_id,
        conversationId: agent.conversation_id,
        heartbeatRunId: runId,
        capabilityId: decision.capabilityId ?? '',
        goal: decision.explorationGoal ?? '',
      });
    } catch (error) {
      toolResult = {
        status: 'failed' as const,
        eventType: 'autonomous_activity' as const,
        title: '自主探索没有完成',
        toolName: decision.capabilityId ?? '',
        summary: error instanceof Error ? error.message : '未知工具错误',
      };
    }
    let digestion = null;
    let sharedCandidate: ToolShareCandidate | undefined;
    let likeSummary = '';
    let repostSummary = '';
    if (toolResult.status === 'completed') {
      try {
        const context = await buildAgentContextMessages({
          characterId: agent.external_id,
          purpose: 'heartbeat',
          excludeEventTypes: ['diary_entry', 'diary_comment', 'autonomous_activity', 'mcp_activity', 'tool_activity'],
        });
        if (context) {
          const candidates = toolResult.shareCandidates ?? [];
          digestion = await requestToolDigestion({
            messages: context.messages,
            toolLabel: toolResult.title,
            goal: decision.explorationGoal ?? '',
            result: toolResult.rawResult ?? toolResult.summary,
            candidates,
            diaryAvailable: !(await hasAssistantDiaryOnDate(client, agent.agent_id, diaryDate)),
            shareAllowed: toolResult.permissions?.shareToChat === true,
            likeAllowed: toolResult.permissions?.like === true,
            repostAllowed: toolResult.permissions?.repost === true,
          });
          const shareIndex = digestion?.shareCandidateIndex;
          if (digestion?.disposition === 'message' && typeof shareIndex === 'number'
              && toolResult.permissions?.shareToChat === true) {
            sharedCandidate = candidates[shareIndex];
          }
          const likeIndex = digestion?.likeCandidateIndex;
          const likeCandidate = typeof likeIndex === 'number' ? candidates[likeIndex] : undefined;
          if (likeCandidate && toolResult.permissions?.like === true
              && (decision.capabilityId === 'x.read' || decision.capabilityId === 'xhs.read')) {
            try {
              likeSummary = await performPlatformLike(decision.capabilityId, likeCandidate);
            } catch (error) {
              likeSummary = `点赞没有完成：${error instanceof Error ? error.message : '未知错误'}`;
            }
          }
          const repostIndex = digestion?.repostCandidateIndex;
          const repostCandidate = typeof repostIndex === 'number' ? candidates[repostIndex] : undefined;
          if (repostCandidate && toolResult.permissions?.repost === true && decision.capabilityId === 'x.read') {
            try {
              repostSummary = await performXRepost(repostCandidate);
            } catch (error) {
              repostSummary = `转推没有完成：${error instanceof Error ? error.message : '未知错误'}`;
            }
          }
        }
      } catch (error) {
        console.warn('Tool result digestion failed; keeping the factual activity card only.', error);
      }
    }

    if (decision.capabilityId === 'phone.read' && toolResult.status === 'planned' && decision.content?.trim()) {
      eventId = await insertProactiveMessage({
        client, conversationId: agent.conversation_id, content: decision.content.trim(), runId,
        idempotencySuffix: 'phone-request', metadata: {
          sourceActivity: 'phone.read', phonePeekRequestId: toolResult.metadata?.phonePeekRequestId,
        },
      });
      pushBody = decision.content.trim();
      pushEventType = 'proactive_message';
    } else {
      const duplicateActivity = toolResult.status === 'completed'
        ? await client.query<{ id: string }>(
          `SELECT id FROM conversation_events
           WHERE conversation_id=$1 AND event_type=$2 AND content=$3
             AND occurred_at >= now() - interval '30 minutes'
             AND metadata->>'source'='heartbeat'
           ORDER BY occurred_at DESC LIMIT 1`,
          [agent.conversation_id, toolResult.eventType, toolResult.summary],
        )
        : { rows: [] as { id: string }[] };
      if (duplicateActivity.rows[0]?.id) {
        eventId = duplicateActivity.rows[0].id;
      }
      const event = eventId ? null : await client.query<{ id: string }>(
        `INSERT INTO conversation_events
         (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
         VALUES ($1, 'assistant', $2, $3, $4::jsonb, $5)
         RETURNING id`,
        [agent.conversation_id, toolResult.eventType, toolResult.summary, JSON.stringify({
          source: 'heartbeat', heartbeatRunId: runId, capabilityId: decision.capabilityId,
          status: toolResult.status, title: toolResult.title, toolName: toolResult.toolName,
          goal: decision.explorationGoal ?? '', result: toolResult.summary,
          ...((likeSummary || repostSummary) ? { platformActions: [likeSummary, repostSummary].filter(Boolean) } : {}),
          ...(toolResult.metadata ?? {}),
        }), `heartbeat:${runId}:explore`],
      );
      eventId = eventId ?? event?.rows[0]?.id;
    }

    if (sharedCandidate) {
      eventId = await insertPlatformShare({ client, agent, runId, candidate: sharedCandidate }) ?? eventId;
    }

    if (digestion?.disposition === 'message' && digestion.messages?.length) {
      for (const [index, content] of digestion.messages.entries()) {
        eventId = await insertProactiveMessage({
          client, conversationId: agent.conversation_id, content, runId,
          idempotencySuffix: `tool-reaction-${index}`, metadata: {
            sourceActivity: toolResult.title, capabilityId: decision.capabilityId ?? '',
          },
        }) ?? eventId;
      }
      pushBody = digestion.messages[0];
      pushEventType = 'proactive_message';
    } else if (digestion?.disposition === 'diary' && digestion.content
        && !(await hasAssistantDiaryOnDate(client, agent.agent_id, diaryDate))) {
      eventId = await insertAssistantDiary({
        client, agent, runId, content: digestion.content, title: digestion.diaryTitle,
        paperStyle: digestion.diaryPaperStyle, source: 'heartbeat-tool-digestion',
        idempotencySuffix: 'tool-diary', diaryDate,
      }) ?? eventId;
      pushBody = digestion.diaryTitle ? `写了一篇日记《${digestion.diaryTitle}》` : '写了一篇新的日记';
      pushEventType = 'diary_entry';
    }
  }

  if (eventId && pushBody && pushEventType) {
    await enqueueWebPush(client, {
      eventId,
      eventType: pushEventType,
      characterId: agent.external_id,
      characterName: agent.agent_name,
      body: pushBody,
    });
  }

  const requestedWakeAt = decision.nextWakeAt ? new Date(decision.nextWakeAt) : null;
  const requestedWakeDelta = requestedWakeAt ? requestedWakeAt.getTime() - Date.now() : Number.NaN;
  if (requestedWakeAt && Number.isFinite(requestedWakeAt.getTime())
      && requestedWakeDelta >= 60_000 && requestedWakeDelta <= 90 * 24 * 60 * 60 * 1_000) {
    await client.query(
      `INSERT INTO scheduled_wakes
       (agent_id, conversation_id, event_id, due_at, reason, created_by, dedupe_key, payload)
       VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7::jsonb)
       ON CONFLICT (agent_id, dedupe_key) DO NOTHING`,
      [agent.agent_id, agent.conversation_id, eventId ?? null, requestedWakeAt,
        decision.reasonSummary, `heartbeat:${runId}:next-wake`,
        JSON.stringify({ source: 'heartbeat', heartbeatRunId: runId })],
    );
  }

  const state = await client.query<{ next_wake_at: Date }>(
    `UPDATE agent_state
     SET last_heartbeat_at = now(),
         last_agent_activity_at = CASE WHEN $2::text IN ('message','diary','comment','explore') THEN now() ELSE last_agent_activity_at END,
         last_autonomous_activity_at = CASE WHEN $2::text IN ('message','diary','comment','explore') THEN now() ELSE last_autonomous_activity_at END,
         next_wake_at = now() + make_interval(mins => $3),
         updated_at = now()
     WHERE agent_id = $1
     RETURNING next_wake_at`,
    [agent.agent_id, decision.action, resolveNextHeartbeatMinutes(
      agent.heartbeat_interval_minutes,
      decision.nextWakeMinutes,
    )],
  );

  await client.query(
    `UPDATE wake_runs
     SET status = 'completed', action = $2, reason_summary = $3, completed_at = now()
     WHERE id = $1`,
    [runId, decision.action, decision.reasonSummary],
  );

  if (agent.scheduled_wake_id) {
    await client.query(
      `UPDATE scheduled_wakes
       SET status='completed', completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [agent.scheduled_wake_id],
    );
  }

  return {
    agentId: agent.agent_id,
    action: decision.action,
    eventId,
    nextWakeAt: state.rows[0]?.next_wake_at.toISOString() ?? new Date().toISOString(),
  };
}

export async function processDueHeartbeats(options: {
  force?: boolean;
  demoMode?: boolean;
} = {}): Promise<HeartbeatResult[]> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const scheduledAgents = await client.query<DueAgent>(
      `SELECT
         a.id AS agent_id,
         a.name AS agent_name,
         a.external_id,
         a.autonomy_policy,
         c.id AS conversation_id,
         a.heartbeat_interval_minutes,
         a.timezone,
         s.last_user_activity_at,
         s.last_agent_activity_at,
         s.last_autonomous_activity_at,
         w.id AS scheduled_wake_id,
         w.reason AS scheduled_reason
       FROM scheduled_wakes w
       JOIN characters a ON a.id=w.agent_id
       JOIN conversations c ON c.id=w.conversation_id
       JOIN agent_state s ON s.agent_id=a.id
       WHERE w.status='pending' AND w.due_at <= now()
         AND a.heartbeat_enabled=true
       ORDER BY w.due_at
       FOR UPDATE OF w SKIP LOCKED
       LIMIT 20`,
    );
    const scheduledAgentIds = scheduledAgents.rows.map((agent) => agent.agent_id);
    const dueAgents = await client.query<DueAgent>(
      `SELECT
         a.id AS agent_id,
         a.name AS agent_name,
         a.external_id,
         a.autonomy_policy,
         c.id AS conversation_id,
         a.heartbeat_interval_minutes,
         a.timezone,
         s.last_user_activity_at,
         s.last_agent_activity_at,
         s.last_autonomous_activity_at
       FROM agent_state s
       JOIN characters a ON a.id = s.agent_id
       JOIN conversations c ON c.agent_id = a.id
       WHERE ($1::boolean OR s.next_wake_at <= now())
         AND a.heartbeat_enabled = true
         AND (a.external_id <> '__demo__' OR $3::boolean)
         AND (s.cooldown_until IS NULL OR s.cooldown_until <= now())
         AND NOT (a.id = ANY($2::uuid[]))
       ORDER BY s.next_wake_at
       FOR UPDATE OF s SKIP LOCKED
       LIMIT 20`,
      [options.force ?? false, scheduledAgentIds, options.demoMode ?? false],
    );

    const results: HeartbeatResult[] = [];
    for (const agent of scheduledAgents.rows) {
      results.push(await processAgent(client, agent, options.demoMode ?? false, true));
    }
    for (const agent of dueAgents.rows) {
      results.push(await processAgent(client, agent, options.demoMode ?? false));
    }

    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
