import { z } from 'zod';

const paperStyleSchema = z.enum(['plain', 'grid', 'dot', 'lined', 'dark', 'pink']);

const generatedDiaryPayloadSchema = z.object({
  title: z.string().trim().max(500).default(''),
  content: z.string().trim().min(1).max(20_000),
  paperStyle: paperStyleSchema.default('plain'),
  sceneCards: z.array(z.string().trim().min(1).max(120)).max(2).default([]),
});

export type GeneratedDiaryPayload = z.infer<typeof generatedDiaryPayloadSchema>;

export interface RecentDiaryForAvoidance {
  diaryDate?: string | Date;
  title: string;
  content: string;
}

export const DIARY_FOCUS_HINTS = [
  '从一个不起眼的物件切入，写它此刻为什么被注意到',
  '只写一件做到一半、被打断或暂时搁下的小事',
  '从光线、声音、温度或气味里选一种感官线索展开',
  '写身体当下很普通的感受与动作，但不要写成观察报告',
  '记下一段跳跃的零碎念头，允许停顿、改口和没有结论',
  '从吃喝、衣物、路上或房间里的一个生活细节展开',
  '写一件没有告诉任何人的小念头，但不要强行告白或升华',
  '从今天某个很短的空白时刻展开，而不是复述完整的一天',
] as const;

export function pickDiaryFocusHint(random: () => number = Math.random): string {
  const rawIndex = Math.floor(random() * DIARY_FOCUS_HINTS.length);
  const index = Math.max(0, Math.min(DIARY_FOCUS_HINTS.length - 1, rawIndex));
  return DIARY_FOCUS_HINTS[index]!;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function dateOnly(value: string | Date | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export function buildRecentDiaryAvoidance(rows: RecentDiaryForAvoidance[]): string {
  if (rows.length === 0) return '- 暂无近期角色日记；仍需自行选择一个具体而微小的生活切面。';
  return rows.slice(0, 8).map((row, index) => {
    const date = dateOnly(row.diaryDate);
    return `${index + 1}. ${date ? `${date}｜` : ''}${compact(row.title || '无题', 80)}｜${compact(row.content, 220)}`;
  }).join('\n');
}

export function rawCompletionText(completion: unknown): string {
  const choices = (completion as { choices?: unknown[] })?.choices;
  const first = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } : undefined;
  return typeof first?.message?.content === 'string' ? first.message.content.trim() : '';
}

function stripOutputEnvelope(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/^json\s*(?=\{)/i, '')
    .trim();
}

function firstBalancedObject(value: string): string | null {
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function parseCandidate(candidate: string): GeneratedDiaryPayload | null {
  try {
    let parsed: unknown = JSON.parse(candidate);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    const validated = generatedDiaryPayloadSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function looksLikeBrokenStructuredOutput(value: string): boolean {
  return /^\s*(?:```|json\s*\{|\{)/i.test(value)
    || /["“]title["”]\s*[:：]/i.test(value)
    || /["“]content["”]\s*[:：]/i.test(value);
}

export function parseGeneratedDiaryCompletion(completion: unknown): GeneratedDiaryPayload | null {
  const raw = rawCompletionText(completion);
  if (!raw) return null;
  const cleaned = stripOutputEnvelope(raw);
  const candidates = [cleaned, firstBalancedObject(cleaned)].filter(
    (candidate, index, list): candidate is string => !!candidate && list.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }

  // Plain prose is still a valid compatibility fallback. JSON-shaped output is not:
  // saving malformed JSON as the diary body is what caused the visible `json { ... }` card.
  if (looksLikeBrokenStructuredOutput(raw)) return null;
  const fallback = generatedDiaryPayloadSchema.safeParse({
    title: '',
    content: cleaned.slice(0, 20_000),
    paperStyle: 'plain',
  });
  return fallback.success ? fallback.data : null;
}
