import { describe, expect, it } from 'vitest';
import { appendRuntimeInstruction, extractWakeReservation } from '../src/wakeScheduling.js';

describe('wake scheduling protocol', () => {
  it('hides a valid future reservation marker from the visible reply', () => {
    const now = new Date('2026-08-09T08:00:00.000Z');
    const parsed = extractWakeReservation(
      '晚上记得喝水。\n[[SULLY_WAKE_AT:2026-08-09T21:00:00+12:00]]',
      now,
    );
    expect(parsed.content).toBe('晚上记得喝水。');
    expect(parsed.dueAt?.toISOString()).toBe('2026-08-09T09:00:00.000Z');
  });

  it('strips invalid, past or excessively distant markers without scheduling them', () => {
    const parsed = extractWakeReservation(
      '正常正文\n[[SULLY_WAKE_AT:2020-01-01T00:00:00Z]]',
      new Date('2026-08-09T08:00:00.000Z'),
    );
    expect(parsed.content).toBe('正常正文');
    expect(parsed.dueAt).toBeNull();
  });

  it('adds runtime rules to the existing system message instead of duplicating role prompts', () => {
    const messages = appendRuntimeInstruction([
      { role: 'system', content: '角色核心' },
      { role: 'user', content: '你好' },
    ], '预约规则');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('角色核心\n\n预约规则');
  });
});
