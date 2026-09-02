import type { ModelMessage } from './modelClient.js';

const WAKE_AT_MARKER = /\[\[SULLY_WAKE_AT:([^\]]+)\]\]/gi;
const MAX_RESERVATION_MS = 90 * 24 * 60 * 60 * 1_000;

export interface ExtractedWakeReservation {
  content: string;
  dueAt: Date | null;
}

export function wakeSchedulingInstruction(now: Date, timezone: string): string {
  return `
## 可选预约苏醒协议
当前时间：${now.toISOString()}；角色时区：${timezone}。
如果你在本轮自然地产生了一个未来要继续做的具体念头，可以在正文最后另起一行写：
[[SULLY_WAKE_AT:带时区偏移的 ISO 时间]]
示例：[[SULLY_WAKE_AT:2026-08-09T21:00:00+12:00]]
只有确实值得记住的具体时间才使用；不要每轮都预约。这个标记不会展示给用户。预约到点会直接唤醒，不走随机概率与自主活动冷却。`;
}

export function appendRuntimeInstruction(messages: ModelMessage[], instruction: string): ModelMessage[] {
  if (messages.length === 0) return [{ role: 'system', content: instruction }];
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return [{ role: 'system', content: instruction }, ...messages];
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${String(message.content ?? '')}\n\n${instruction}` }
    : message);
}

export function extractWakeReservation(
  rawContent: string,
  now = new Date(),
): ExtractedWakeReservation {
  let dueAt: Date | null = null;
  const content = rawContent.replace(WAKE_AT_MARKER, (_full, captured: string) => {
    if (!dueAt) {
      const parsed = new Date(String(captured).trim());
      const delta = parsed.getTime() - now.getTime();
      if (Number.isFinite(parsed.getTime()) && delta >= 60_000 && delta <= MAX_RESERVATION_MS) {
        dueAt = parsed;
      }
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { content, dueAt };
}
