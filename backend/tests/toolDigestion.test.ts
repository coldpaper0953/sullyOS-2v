import { describe, expect, it } from 'vitest';
import { buildToolDigestionPrompt, parseToolDigestion } from '../src/toolDigestion.js';

describe('tool result digestion', () => {
  it('requires a role-facing message or diary body', () => {
    expect(parseToolDigestion('{"disposition":"message"}')).toBeNull();
    expect(parseToolDigestion('{"disposition":"silent","shareCandidateIndex":null}')).toBeNull();
    expect(parseToolDigestion('{"disposition":"message","messages":["这条倒是有点意思。","你看第二张图。"]}')).toMatchObject({
      disposition: 'message', messages: ['这条倒是有点意思。', '你看第二张图。'],
    });
  });

  it('makes tool output an observation instead of the final answer', () => {
    const prompt = buildToolDigestionPrompt({
      toolLabel: '黑 X',
      goal: '看看首页',
      result: { count: 1 },
      candidates: [{ platform: 'x', url: 'https://x.com/a/status/1', title: '一条帖子' }],
      diaryAvailable: false,
      shareAllowed: true,
      likeAllowed: true,
      repostAllowed: true,
    });
    expect(prompt).toContain('不能重新选择沉默');
    expect(prompt).toContain('说出口的每一句都必须满足');
    expect(prompt).toContain('今天已经写过一篇角色日记');
    expect(prompt).toContain('本轮只能选择 message');
    expect(prompt).toContain('shareCandidateIndex');
    expect(prompt).toContain('likeCandidateIndex');
    expect(prompt).toContain('repostCandidateIndex');
    expect(prompt).toContain('你想说几条就说几条');
    expect(prompt).not.toContain('通常一两段');
  });
});
