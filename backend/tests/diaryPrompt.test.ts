import { describe, expect, it } from 'vitest';
import { INDEPENDENT_DIARY_STYLE_GUIDE } from '../src/diaryPrompt.js';

describe('independent diary voice', () => {
  it('favours private lived-in moments over reports and forced poetry', () => {
    expect(INDEPENDENT_DIARY_STYLE_GUIDE).toContain('私下写给自己的日记');
    expect(INDEPENDENT_DIARY_STYLE_GUIDE).toContain('只挑一个很小的切片');
    expect(INDEPENDENT_DIARY_STYLE_GUIDE).toContain('不必每篇都诗意');
    expect(INDEPENDENT_DIARY_STYLE_GUIDE).toContain('不要硬造戏剧冲突');
    expect(INDEPENDENT_DIARY_STYLE_GUIDE).toContain('用具体画面代替概括');
  });
});
