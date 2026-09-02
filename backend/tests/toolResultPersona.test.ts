import { describe, expect, it } from 'vitest';
import { buildPhonePeekReactionPrompt, phonePeekReactionSchema } from '../src/phonePeek.js';
import { buildToolDigestionPrompt, parseToolDigestion } from '../src/toolDigestion.js';

describe('persona-first tool result handling', () => {
  it('requires a spoken in-character reaction after a successful phone peek', () => {
    const prompt = buildPhonePeekReactionPrompt({
      characterName: '测试角色',
      goal: '看看用户在做什么',
      observation: '屏幕上是课程讲义和一杯咖啡的照片。',
    });

    expect(prompt).toContain('既然你已经主动来看');
    expect(prompt).toContain('吐槽、评价、关心或追问');
    expect(prompt).not.toContain('"action":"message|silent|later"');
    expect(phonePeekReactionSchema.safeParse({
      action: 'message', intent: 'tease', content: '又靠咖啡续命？', reasonSummary: '看见咖啡。',
    }).success).toBe(true);
    expect(phonePeekReactionSchema.safeParse({
      action: 'silent', intent: 'none', content: '', reasonSummary: '',
    }).success).toBe(false);
  });

  it('does not allow silence after X, XHS or MCP exploration succeeded', () => {
    const prompt = buildToolDigestionPrompt({
      toolLabel: '逛了逛小红书', goal: '看看最近有什么好玩的', result: { items: ['一条帖子'] },
      candidates: [], diaryAvailable: true, shareAllowed: true, likeAllowed: true,
    });

    expect(prompt).toContain('不能重新选择沉默');
    expect(parseToolDigestion('{"disposition":"silent"}')).toBeNull();
    expect(parseToolDigestion('{"disposition":"message","messages":["这人说话怎么比我还欠。"]}')).toMatchObject({
      disposition: 'message',
    });
  });
});
