import { z } from 'zod';
import { INDEPENDENT_DIARY_STYLE_GUIDE } from './diaryPrompt.js';
import { createChatCompletion, type ModelMessage } from './modelClient.js';

export interface ToolShareCandidate {
  platform: 'x' | 'xhs' | 'web';
  url: string;
  title: string;
  description?: string;
  author?: string;
  imageUrl?: string;
  mediaUrls?: string[];
  noteId?: string;
  xsecToken?: string;
  likes?: number;
  retweets?: number;
}

export interface ToolDigestion {
  disposition: 'message' | 'diary';
  messages?: string[];
  content?: string;
  diaryTitle?: string;
  diaryPaperStyle?: 'plain' | 'grid' | 'dot' | 'lined' | 'dark' | 'pink';
  shareCandidateIndex?: number | null;
  likeCandidateIndex?: number | null;
  repostCandidateIndex?: number | null;
}

const actionFields = {
  shareCandidateIndex: z.number().int().min(0).nullable().optional(),
  likeCandidateIndex: z.number().int().min(0).nullable().optional(),
  repostCandidateIndex: z.number().int().min(0).nullable().optional(),
};

const digestionSchema = z.discriminatedUnion('disposition', [
  z.object({
    disposition: z.literal('message'),
    messages: z.array(z.string().trim().min(1).max(100_000)).min(1),
    ...actionFields,
    diaryTitle: z.string().trim().max(500).optional(),
    diaryPaperStyle: z.enum(['plain', 'grid', 'dot', 'lined', 'dark', 'pink']).optional(),
  }),
  z.object({
    disposition: z.literal('diary'),
    content: z.string().trim().min(1).max(100_000),
    ...actionFields,
    diaryTitle: z.string().trim().min(1).max(500),
    diaryPaperStyle: z.enum(['plain', 'grid', 'dot', 'lined', 'dark', 'pink']).optional(),
  }),
]);

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  return text.length <= max ? text : `${text.slice(0, max)}\n[结果已按上下文预算截断]`;
}

export function parseToolDigestion(text: string): ToolDigestion | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const raw = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    // 兼容副 API 把索引序列化成字符串，或省略可选字段的常见返回差异。
    for (const key of ['shareCandidateIndex', 'likeCandidateIndex', 'repostCandidateIndex']) {
      if (typeof raw[key] === 'string' && /^\d+$/.test(raw[key] as string)) raw[key] = Number(raw[key]);
      if (raw[key] === '' || raw[key] === undefined) raw[key] = null;
    }
    const parsed = digestionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildToolDigestionPrompt(input: {
  toolLabel: string;
  goal: string;
  result: unknown;
  candidates: ToolShareCandidate[];
  diaryAvailable: boolean;
  shareAllowed: boolean;
  likeAllowed: boolean;
  repostAllowed?: boolean;
}): string {
  const candidates = input.candidates.slice(0, 12).map((candidate, index) => ({
    index,
    platform: candidate.platform,
    title: candidate.title,
    author: candidate.author || '',
    description: bounded(candidate.description || '', 600),
    url: candidate.url,
    likes: candidate.likes,
    retweets: candidate.retweets,
  }));
  return `
## 你主动探索后的真实结果
你刚才已经主动决定为了“${input.goal || '随便看看'}”使用「${input.toolLabel}」，并且工具调用成功。真实结果如下：
${bounded(input.result, 16_000)}

可分享或点赞的候选（索引只能从这里选择，不能编造链接）：
${candidates.length ? JSON.stringify(candidates, null, 2) : '（没有可用候选）'}

“要不要看、要不要稍后看、要不要保持沉默”已经在调用工具之前决定完了。既然你已经主动去看并拿到了结果，现在必须由角色本人把结果消化成真实反应，不能重新选择沉默：
- message：按你独有的性格、关系、用词与情绪去吐槽、评价、关心、追问或分享。你想说几条就说几条，每条都是一条会真实发给用户的独立聊天消息；不要逐条复述工具结果，也不要为了凑数量硬拆句子。
- diary：只有这次探索真的勾起一段值得留下的私人经历或思绪时才写；不能把网页或工具结果换皮抄成报告。今天已经写过日记时禁止选择。
- 可以同时选择一个候选分享成链接卡片、给真正合心意的候选点赞，或转推一条确实想放到自己主页的 X 帖子；这些动作必须符合角色本人，而不是为了显得活跃。

禁止提 JSON、MCP、工具调用、系统提示或“根据搜索结果”。禁止资讯播报、客服口吻、AI 助手总结和通用感想。说出口的每一句都必须满足：只有这个角色、在和这个用户的这段关系里，才会这样说。

${input.diaryAvailable ? '- 今天还没有写过角色日记，确实值得时可以选择 diary。' : '- 今天已经写过一篇角色日记，本轮只能选择 message。'}
${INDEPENDENT_DIARY_STYLE_GUIDE}
- ${input.shareAllowed ? '允许分享：shareCandidateIndex 可从候选中选一个；分享时 messages 仍要包含角色对它的自然反应。' : '未授权分享到聊天：shareCandidateIndex 必须为 null。'}
- ${input.likeAllowed ? '允许点赞：likeCandidateIndex 可从候选中选一个；没有真心喜欢就填 null。' : '未授权点赞：likeCandidateIndex 必须为 null。'}
- ${input.repostAllowed ? '允许转推：repostCandidateIndex 可从 X 候选中选一个；不想让它出现在自己主页就填 null。' : '当前不能转推：repostCandidateIndex 必须为 null。'}

只返回 JSON，不要 Markdown：
message：{"disposition":"message","messages":["第一条真实聊天消息","还想继续说就继续添加"],"shareCandidateIndex":null,"likeCandidateIndex":null,"repostCandidateIndex":null}
diary：{"disposition":"diary","content":"角色日记正文","diaryTitle":"日记标题","diaryPaperStyle":"plain|grid|dot|lined|dark|pink","shareCandidateIndex":null,"likeCandidateIndex":null,"repostCandidateIndex":null}
`;
}

function completionContent(completion: Record<string, unknown>): string {
  const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : '';
  return typeof content === 'string' ? content : '';
}

export async function requestToolDigestion(input: {
  messages: ModelMessage[];
  toolLabel: string;
  goal: string;
  result: unknown;
  candidates: ToolShareCandidate[];
  diaryAvailable: boolean;
  shareAllowed: boolean;
  likeAllowed: boolean;
  repostAllowed?: boolean;
}): Promise<ToolDigestion> {
  const prompt = buildToolDigestionPrompt(input);
  const completion = await createChatCompletion({
    messages: [...input.messages, { role: 'user', content: prompt }],
    temperature: 0.82,
    maxTokens: 1_600,
  });
  const content = completionContent(completion);
  const parsed = parseToolDigestion(content);
  if (parsed) return parsed;

  const repaired = await createChatCompletion({
    messages: [
      ...input.messages,
      { role: 'user', content: prompt },
      { role: 'assistant', content },
      {
        role: 'user',
        content: '上一个回答不是要求的有效 JSON。只修复格式并原样保留角色真正想说的全部消息，不要缩减、改写或添加固定兜底句。message 必须使用非空 messages 字符串数组；diary 必须使用非空 content。只返回 JSON。',
      },
    ],
    temperature: 0.2,
    maxTokens: 1_600,
  });
  const repairedParsed = parseToolDigestion(completionContent(repaired));
  if (!repairedParsed) throw new Error('角色连续两次没有返回有效的工具结果反应 JSON。');
  return repairedParsed;
}
