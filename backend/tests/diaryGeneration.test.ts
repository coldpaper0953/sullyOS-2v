import { describe, expect, it } from 'vitest';
import {
  buildRecentDiaryAvoidance,
  DIARY_FOCUS_HINTS,
  parseGeneratedDiaryCompletion,
  pickDiaryFocusHint,
} from '../src/diaryGeneration.js';

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('diary generation helpers', () => {
  it('parses fenced and bare-json-prefixed model output', () => {
    const fenced = parseGeneratedDiaryCompletion(completion(
      '```json\n{"title":"窗边","content":"风吹动了纸角。","paperStyle":"lined"}\n```',
    ));
    const prefixed = parseGeneratedDiaryCompletion(completion(
      'json\n{"title":"杯底","content":"茶已经凉了。","paperStyle":"plain"}',
    ));
    expect(fenced).toMatchObject({ title: '窗边', content: '风吹动了纸角。', paperStyle: 'lined' });
    expect(prefixed).toMatchObject({ title: '杯底', content: '茶已经凉了。', paperStyle: 'plain' });
  });

  it('extracts a balanced JSON object without saving surrounding chatter', () => {
    const parsed = parseGeneratedDiaryCompletion(completion(
      '结果如下：\n{"title":"无题","content":"鞋带松了一次。","paperStyle":"grid"}\n希望有帮助。',
    ));
    expect(parsed).toMatchObject({ title: '无题', content: '鞋带松了一次。', paperStyle: 'grid' });
  });

  it('keeps up to two short scene cards for visual diary decoration', () => {
    const parsed = parseGeneratedDiaryCompletion(completion(
      '{"title":"Morning","content":"I watered the herbs.","paperStyle":"dot","sceneCards":["Light on the mint leaves","A cup beside the window"]}',
    ));
    expect(parsed).toMatchObject({
      sceneCards: ['Light on the mint leaves', 'A cup beside the window'],
    });
  });

  it('rejects malformed JSON-shaped output instead of displaying it as diary prose', () => {
    expect(parseGeneratedDiaryCompletion(completion(
      'json\n{"title":"坏掉了","content":"没有闭合"',
    ))).toBeNull();
  });

  it('keeps plain prose as a compatibility fallback', () => {
    expect(parseGeneratedDiaryCompletion(completion('灯忘了关。我躺下以后才想起来。')))
      .toMatchObject({ title: '', content: '灯忘了关。我躺下以后才想起来。', paperStyle: 'plain' });
  });

  it('builds a compact recent-diary exclusion list', () => {
    const manifest = buildRecentDiaryAvoidance([{
      diaryDate: '2026-08-10T03:00:00.000Z',
      title: '四分三十七秒',
      content: `重复场景 ${'很长的内容'.repeat(100)}`,
    }]);
    expect(manifest).toContain('2026-08-10｜四分三十七秒');
    expect(manifest).toContain('重复场景');
    expect(manifest.length).toBeLessThan(400);
  });

  it('can select every configured focus hint without leaving the list', () => {
    const selected = DIARY_FOCUS_HINTS.map((_, index) => (
      pickDiaryFocusHint(() => (index + 0.1) / DIARY_FOCUS_HINTS.length)
    ));
    expect(new Set(selected)).toEqual(new Set(DIARY_FOCUS_HINTS));
  });
});
