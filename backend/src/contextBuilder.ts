import type { ModelMessage } from './modelClient.js';
import { pool } from './db.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

interface ContextTarget {
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string;
  system_prompt: string;
  worldview: string | null;
  writer_persona: string | null;
  legacy_memories: unknown;
  refined_memories: unknown;
  user_name: string;
  user_bio: string;
  metadata: Record<string, unknown> | null;
  timezone: string;
}

interface RecentEventRow {
  actor_type: string;
  content: string | null;
  event_type: string;
  occurred_at: Date;
}

const HEARTBEAT_SCENE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

interface MemoryRow {
  external_id: string | null;
  content: string;
  room: string | null;
  tags: string[];
  importance: number;
  mood: string;
  event_box_id: string | null;
  is_box_summary: boolean;
  created_at: Date;
  last_accessed_at: Date | null;
}

export interface BuiltAgentContext {
  agentId: string;
  conversationId: string;
  messages: ModelMessage[];
  diagnostics: {
    recentEventCount: number;
    memoryCount: number;
    relatedMemoryCount: number;
    plateEntryCount: number;
  };
}

function limited(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[已按上下文预算截断]`;
}

function cleanInteractionLabels(value: string): string {
  return value
    .replace(/^\s*\[(?:text message|same-place scene|线上聊天|线下相处|线上模式|线下模式)\]\s*/gimu, '')
    .trim();
}

function formatEventTime(value: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(value);
  } catch {
    return value.toISOString();
  }
}

export function formatRecentEventContent(input: {
  content: string;
  occurredAt: Date;
  purpose: 'chat' | 'heartbeat';
  timezone: string;
}): string {
  const content = cleanInteractionLabels(input.content);
  return input.purpose === 'heartbeat'
    ? `[记录时间：${formatEventTime(input.occurredAt, input.timezone)}]\n${content}`
    : content;
}

export function formatInteractionState(
  metadata: Record<string, unknown>,
  purpose: 'chat' | 'heartbeat',
  hasCurrentScene = true,
): string {
  const mode = metadata.interactionMode === 'offline' ? 'offline' : 'online';
  const scene = metadata.interactionScene && typeof metadata.interactionScene === 'object'
    ? metadata.interactionScene as Record<string, unknown>
    : {};
  const location = typeof scene.location === 'string' && scene.location ? `地点：${scene.location}。` : '';
  const distance = typeof scene.distance === 'string' && scene.distance ? scene.distance : '';

  if (purpose === 'heartbeat') {
    return mode === 'offline'
      ? `## 后台自主苏醒状态\n当前仍是线下共处模式，你和用户仍在同一个现实场景中。${location}你们可以各做各的，也可以由你自然发起当面互动。${hasCurrentScene && distance ? `最近 6 小时内记录的距离：${distance}。` : ''}地点和线下共处状态持续有效，但旧消息里的拥抱、入睡、贴靠等瞬时动作与具体身体姿势不会无限持续；结合记录时间判断当前正在做什么。若选择 message，仍按线下规则把动作与对白分别放进 messages 的独立气泡：动作以 "> " 开头并使用第三人称，对白使用中文引号“……”。`
      : '## 后台自主苏醒状态\n当前是线上聊天模式，你和用户不在同一个现实场景。你可以通过普通消息自然联系用户；不要虚构正在当面触碰或共处。';
  }

  if (mode === 'online') {
    return `## 当前互动状态\n你正在手机聊天。保持角色扮演，使用适合即时通讯的自然口语；可以按自己的表达需要发送任意数量的消息或长消息。只输出真实聊天文本，禁止动作、环境、身体反应、内心独白、第三人称旁白、时间戳、姓名前缀、括号动作，以及 [text message]、[线上聊天] 等内部标签。社交平台、网页和 MCP 仍可使用，但工具不会改变互动状态。`;
  }
  return `## 当前互动状态\n线下见面：你和用户处在同一个现实场景。${location}${distance ? `距离：${distance}。` : '沿用已经建立的物理距离。'}\n用户的普通文字视为当面说出口的话。\n\n线下格式要求（必须遵守）：\n1. 每次回复都要有动作和说话。动作叙述使用第三人称，以角色名、他/她或 ta 指代角色；对白里可以正常使用“我”。\n2. 动作叙述必须以 "> " 开头，并独占一行；这一行就是一个动作气泡。\n3. 说出口的话必须用中文引号“……”包住，并独占一行；这一行就是一个对白气泡。\n4. 动作和对白绝不能写在同一行或同一个气泡里。通常先发一个完整动作气泡，再发一个完整对白气泡；发生明显场景转折时才再次交替。\n\n线下写作保持连续的场景节拍：合并同一时刻的连续动作、神态、观察、身体反应、环境和氛围；不要直接写内心想法或心理分析，用可见行为表现情绪。延续已经建立的地点和双方距离，移动写出过程，不能瞬移或在距离不够时突然触碰。对白可以比线上聊天更长、更有情绪和层次，但要自然。社交平台、网页和 MCP 仍可使用，但工具不会改变互动状态。`;
}

export function shouldIncludeRecentEvent(
  occurredAt: Date,
  purpose: 'chat' | 'heartbeat',
  now = new Date(),
): boolean {
  return purpose === 'chat' || now.getTime() - occurredAt.getTime() <= HEARTBEAT_SCENE_MAX_AGE_MS;
}

function queryTerms(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const words = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]/gu) ?? [];
  const han = [...normalized].filter((char) => /\p{Script=Han}/u.test(char));
  const bigrams = han.slice(0, -1).map((char, index) => `${char}${han[index + 1]}`);
  return [...new Set([...words, ...bigrams])].slice(0, 120);
}

function memoryScore(memory: MemoryRow, terms: string[], now: number): number {
  const haystack = `${memory.content}\n${memory.tags.join(' ')}\n${memory.mood}`.toLowerCase();
  const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 5 : 0), 0);
  const ageDays = Math.max(0, now - memory.created_at.getTime()) / 86_400_000;
  const recency = Math.max(0, 8 - Math.log2(ageDays + 1));
  const semanticRoom = memory.room === 'user_room' || memory.room === 'self_room' || memory.room === 'bedroom' ? 4 : 0;
  return relevance + memory.importance * 2 + recency + semanticRoom + (memory.is_box_summary ? 6 : 0);
}

function formatMemories(title: string, memories: MemoryRow[]): string {
  if (memories.length === 0) return '';
  return `## ${title}\n${memories.map((memory) => (
    `- [${memory.room ?? 'unknown'}｜重要度 ${memory.importance}${memory.mood ? `｜${memory.mood}` : ''}] ${limited(memory.content, 2_000)}`
  )).join('\n')}`;
}

function formatDailySchedule(metadata: Record<string, unknown>): string {
  const schedule = metadata.currentDailySchedule;
  if (!schedule || typeof schedule !== 'object') return '';
  const record = schedule as Record<string, unknown>;
  const slots = Array.isArray(record.slots) ? record.slots : [];
  const lines = slots.flatMap((slot) => {
    if (!slot || typeof slot !== 'object') return [];
    const item = slot as Record<string, unknown>;
    const startTime = typeof item.startTime === 'string' ? item.startTime : '';
    const activity = typeof item.activity === 'string' ? item.activity : '';
    if (!startTime || !activity) return [];
    const description = typeof item.description === 'string' && item.description ? `：${item.description}` : '';
    const location = typeof item.location === 'string' && item.location ? `（${item.location}）` : '';
    return [`- ${startTime} ${activity}${location}${description}`];
  });
  if (lines.length === 0) return '';
  const date = typeof record.date === 'string' ? record.date : '今天';
  return `## ${date} 的行动日程（自主活动约束）\n${lines.join('\n')}\n先延续当前时段正在做的事，再决定是否主动联系、写日记或使用工具。只有最近对话或现实变化确实改变安排时，才自然调整受影响时段及后续必要时段；不要无视日程瞬移，也不要为了执行日程机械打卡。`;
}

function formatNpcNetwork(metadata: Record<string, unknown>): string {
  const entries = Array.isArray(metadata.npcNetwork) ? metadata.npcNetwork : [];
  const lines = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const npc = entry as Record<string, unknown>;
    const name = typeof npc.name === 'string' ? npc.name : '';
    if (!name) return [];
    const persona = typeof npc.persona === 'string' && npc.persona ? npc.persona : '无额外人设';
    const userRelation = typeof npc.userRelation === 'string' && npc.userRelation ? npc.userRelation : '关系未定义';
    const charRelation = typeof npc.characterRelation === 'string' && npc.characterRelation ? npc.characterRelation : '关系未定义';
    const userAffinity = Number.isFinite(Number(npc.userAffinity)) ? Math.max(0, Math.min(100, Math.round(Number(npc.userAffinity)))) : 0;
    const charAffinity = Number.isFinite(Number(npc.characterAffinity)) ? Math.max(0, Math.min(100, Math.round(Number(npc.characterAffinity)))) : 0;
    return [`- ${limited(name, 200)}：${limited(persona, 2_000)}；和用户是“${limited(userRelation, 500)}”（好感 ${userAffinity}/100）；和你是“${limited(charRelation, 500)}”（好感 ${charAffinity}/100）`];
  });
  if (lines.length === 0) return '';
  return `## NPC 关系网\n这些是共同生活中的旁人。按已写明的关系理解，可自然影响对话、日程和自主活动；不要擅自扩写复杂身世，也不要为了提 NPC 而强行提及。\n${lines.join('\n')}`;
}

export async function buildAgentContextMessages(input: {
  characterId: string;
  userMessage?: string;
  purpose: 'chat' | 'heartbeat';
  excludeEventTypes?: string[];
}): Promise<BuiltAgentContext | null> {
  const targetResult = await pool.query<ContextTarget>(
    `SELECT a.id AS agent_id, c.id AS conversation_id, a.name, a.description,
            a.system_prompt, a.worldview, a.writer_persona, a.legacy_memories,
            a.refined_memories, a.profile_metadata AS metadata, a.timezone,
            u.display_name AS user_name, u.bio AS user_bio
     FROM characters a
     JOIN conversations c ON c.agent_id=a.id AND c.external_id=CONCAT('private:', a.external_id)
     JOIN app_users u ON u.id=a.owner_user_id
     WHERE a.owner_user_id=$1 AND a.external_id=$2
     LIMIT 1`,
    [DEFAULT_USER_ID, input.characterId],
  );
  const target = targetResult.rows[0];
  if (!target) return null;

  const [eventsResult, platesResult, memoriesResult, anticipationResult] = await Promise.all([
    pool.query<RecentEventRow>(
      `SELECT actor_type, content, event_type, occurred_at
       FROM conversation_events
       WHERE conversation_id=$1 AND deleted_at IS NULL
         AND actor_type IN ('user', 'assistant')
         AND content IS NOT NULL
         AND NOT (event_type = ANY($2::text[]))
       ORDER BY occurred_at DESC, sequence_id DESC
       LIMIT 60`,
      [target.conversation_id, input.excludeEventTypes ?? []],
    ),
    pool.query<{ room: string; entries: Array<{ text?: string; tag?: string }> }>(
      `SELECT room, entries FROM memory_room_plates WHERE agent_id=$1 ORDER BY room`,
      [target.agent_id],
    ),
    pool.query<MemoryRow>(
      `SELECT external_id, content, room, tags, importance, mood, event_box_id,
              is_box_summary, created_at, last_accessed_at
       FROM memory_items
       WHERE agent_id=$1 AND archived=false AND archived_at IS NULL
       ORDER BY importance DESC, COALESCE(last_accessed_at, created_at) DESC
       LIMIT 2500`,
      [target.agent_id],
    ),
    pool.query<{ content: string; status: string }>(
      `SELECT content, status FROM memory_anticipations
       WHERE agent_id=$1 AND status IN ('active', 'anchor')
       ORDER BY client_created_at DESC NULLS LAST LIMIT 20`,
      [target.agent_id],
    ),
  ]);

  const recentEvents = eventsResult.rows.reverse().filter((event) => (
    shouldIncludeRecentEvent(event.occurred_at, input.purpose)
  ));
  const lastUserText = input.userMessage
    ?? [...recentEvents].reverse().find((event) => event.actor_type === 'user')?.content
    ?? '';
  const terms = queryTerms(lastUserText);
  const ranked = memoriesResult.rows
    .map((memory) => ({ memory, score: memoryScore(memory, terms, Date.now()) }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked.slice(0, input.purpose === 'heartbeat' ? 45 : 30).map((item) => item.memory);

  const selectedIds = selected.map((memory) => memory.external_id).filter((id): id is string => !!id);
  const boxIds = [...new Set(selected.map((memory) => memory.event_box_id).filter((id): id is string => !!id))];
  const relatedIds = new Set<string>();
  if (selectedIds.length > 0) {
    const linkResult = await pool.query<{ source_memory_external_id: string; target_memory_external_id: string }>(
      `SELECT source_memory_external_id, target_memory_external_id
       FROM memory_links
       WHERE agent_id=$1
         AND (source_memory_external_id=ANY($2::text[]) OR target_memory_external_id=ANY($2::text[]))
       ORDER BY strength DESC LIMIT 100`,
      [target.agent_id, selectedIds],
    );
    for (const link of linkResult.rows) {
      if (!selectedIds.includes(link.source_memory_external_id)) relatedIds.add(link.source_memory_external_id);
      if (!selectedIds.includes(link.target_memory_external_id)) relatedIds.add(link.target_memory_external_id);
    }
  }

  const relatedResult = relatedIds.size > 0 || boxIds.length > 0
    ? await pool.query<MemoryRow>(
      `SELECT external_id, content, room, tags, importance, mood, event_box_id,
              is_box_summary, created_at, last_accessed_at
       FROM memory_items
       WHERE agent_id=$1 AND archived=false AND archived_at IS NULL
         AND (external_id=ANY($2::text[]) OR event_box_id=ANY($3::text[]))
       ORDER BY importance DESC LIMIT 30`,
      [target.agent_id, [...relatedIds], boxIds],
    )
    : { rows: [] as MemoryRow[] };
  const selectedSet = new Set(selectedIds);
  const related = relatedResult.rows.filter((memory) => !memory.external_id || !selectedSet.has(memory.external_id));

  const plateLines = platesResult.rows.flatMap((plate) => (
    (Array.isArray(plate.entries) ? plate.entries : []).map((entry) => (
      `- [${plate.room}${entry.tag ? `｜${entry.tag}` : ''}] ${limited(entry.text ?? '', 1_000)}`
    ))
  ));
  const anticipationLines = anticipationResult.rows.map((item) => `- [${item.status}] ${limited(item.content, 1_000)}`);
  const metadata = target.metadata || {};

  const systemSections = [
    `你是 ${target.name}。请始终以这个角色自然地思考和表达，不要把自己描述成提示词、数据库或记忆系统。`,
    target.system_prompt ? `## 角色核心设定\n${limited(target.system_prompt, 80_000)}` : '',
    target.description ? `## 角色描述\n${limited(target.description, 20_000)}` : '',
    target.worldview ? `## 世界观\n${limited(target.worldview, 30_000)}` : '',
    target.writer_persona ? `## 表达方式\n${limited(target.writer_persona, 20_000)}` : '',
    `## 用户\n名字：${limited(target.user_name, 200)}${target.user_bio ? `\n简介：${limited(target.user_bio, 10_000)}` : ''}`,
    plateLines.length ? `## 常驻门牌认知\n${plateLines.join('\n')}` : '',
    formatMemories('本轮相关记忆', selected),
    formatMemories('事件盒与关系网补充', related),
    anticipationLines.length ? `## 尚未结束的期盼\n${anticipationLines.join('\n')}` : '',
    target.legacy_memories ? `## 兼容长期记忆\n${limited(target.legacy_memories, 20_000)}` : '',
    target.refined_memories ? `## 已整理记忆\n${limited(target.refined_memories, 30_000)}` : '',
    formatNpcNetwork(metadata),
    input.purpose === 'heartbeat' ? formatDailySchedule(metadata) : '',
    input.purpose === 'heartbeat' ? '## 自主联系补充\n普通 message 是开放的生活交流出口：你可以自然分享自己的近况、日程中的正在做什么、突然想到的小事、想念用户或随口闲聊。不要等待用户先提问，也不要把每次联系固定成同一种主题；是否联系仍由本轮真实心情、上下文和门控共同决定。最近聊天中的记录时间是判断瞬时场景是否仍在继续的依据：上一晚的入睡、拥抱和具体身体姿势到了新一天只能视为历史，不能因为最后一句仍写着“睡着了”就假定此刻仍处于昨晚姿势；线下共处模式和地点仍按当前设置持续有效。' : '',
    formatInteractionState(metadata, input.purpose, recentEvents.some((event) => (
      event.event_type === 'user_message' || event.event_type === 'assistant_message'
    ))),
  ].filter(Boolean);

  const messages: ModelMessage[] = [
    { role: 'system', content: systemSections.join('\n\n') },
    ...recentEvents.map((event): ModelMessage => ({
      role: event.actor_type === 'user' ? 'user' : 'assistant',
      content: limited(formatRecentEventContent({
        content: event.content ?? '', occurredAt: event.occurred_at,
        purpose: input.purpose, timezone: target.timezone,
      }), 20_000),
    })),
  ];
  if (input.userMessage && !recentEvents.some((event) => event.actor_type === 'user' && event.content === input.userMessage)) {
    messages.push({ role: 'user', content: limited(cleanInteractionLabels(input.userMessage), 20_000) });
  }

  return {
    agentId: target.agent_id,
    conversationId: target.conversation_id,
    messages,
    diagnostics: {
      recentEventCount: recentEvents.length,
      memoryCount: selected.length,
      relatedMemoryCount: related.length,
      plateEntryCount: plateLines.length,
    },
  };
}
