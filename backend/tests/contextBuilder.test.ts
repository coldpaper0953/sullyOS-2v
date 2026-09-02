import { describe, expect, it } from 'vitest';
import {
  formatInteractionState,
  formatRecentEventContent,
  shouldIncludeRecentEvent,
} from '../src/contextBuilder.js';

describe('heartbeat recent-event context', () => {
  const occurredAt = new Date('2026-08-12T20:16:10.000Z');

  it('shows the local event time to heartbeat decisions', () => {
    const content = formatRecentEventContent({
      content: '她已经睡着了。', occurredAt, purpose: 'heartbeat', timezone: 'Pacific/Auckland',
    });
    expect(content).toContain('[记录时间：');
    expect(content).toContain('2026');
    expect(content).toContain('08:16');
    expect(content).toContain('她已经睡着了。');
  });

  it('keeps ordinary chat history free of heartbeat-only time labels', () => {
    expect(formatRecentEventContent({
      content: '[线上聊天] 早上好。', occurredAt, purpose: 'chat', timezone: 'Pacific/Auckland',
    })).toBe('早上好。');
  });

  it('keeps offline co-presence while expiring exact physical poses', () => {
    const metadata = {
      interactionMode: 'offline', interactionScene: { location: '卧室', distance: '拥抱中' },
    };
    const heartbeat = formatInteractionState(metadata, 'heartbeat', false);
    expect(heartbeat).toContain('当前仍是线下共处模式');
    expect(heartbeat).toContain('地点：卧室');
    expect(heartbeat).toContain('你们可以各做各的');
    expect(heartbeat).toContain('具体身体姿势不会无限持续');
    expect(heartbeat).toContain('messages 的独立气泡');
    expect(heartbeat).not.toContain('拥抱中');

    expect(formatInteractionState(metadata, 'heartbeat', true)).toContain('拥抱中');

    const chat = formatInteractionState(metadata, 'chat');
    expect(chat).toContain('线下见面：你和用户处在同一个现实场景');
    expect(chat).toContain('地点：卧室');
  });

  it('expires old scene turns for heartbeat without hiding them from normal chat', () => {
    const now = new Date('2026-08-12T21:27:00.000Z');
    const oldScene = new Date('2026-08-12T13:52:00.000Z');
    const currentScene = new Date('2026-08-12T17:52:00.000Z');
    expect(shouldIncludeRecentEvent(oldScene, 'heartbeat', now)).toBe(false);
    expect(shouldIncludeRecentEvent(oldScene, 'chat', now)).toBe(true);
    expect(shouldIncludeRecentEvent(currentScene, 'heartbeat', now)).toBe(true);
  });
});
