import { describe, expect, it } from 'vitest';
import { sanitizeSearchHtml } from './sanitizeSearchHtml';

describe('sanitizeSearchHtml（搜索结果 HTML 净化）', () => {
  it('脚本注入被剥掉', () => {
    expect(sanitizeSearchHtml('hi <script>alert(1)</script>'))
      .toBe('hi &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('事件处理属性进变成 STAY_INERT 文本', () => {
    expect(sanitizeSearchHtml('<img src=x onerror=alert(1)>'))
      .toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('javascript: 和属性注入都活不下来', () => {
    expect(sanitizeSearchHtml('<a href="javascript:alert(1)" style="position:fixed">x</a>'))
      .toBe('&lt;a href=&quot;javascript:alert(1)&quot; style=&quot;position:fixed&quot;&gt;x&lt;/a&gt;');
  });

  it('自闭合的 br 保持为 <br>（大小写/是否带斜杠都归一），大小写不敏感', () => {
    expect(sanitizeSearchHtml('A<br/>B<BR>C')).toBe('A<br>B<br>C');
    expect(sanitizeSearchHtml('a<br>B<Br>C<bR>D')).toBe('a<br>B<br>C<br>D');
  });

  it('白名单加粗/强调标签保持原样（Brave 需要的样式）', () => {
    expect(sanitizeSearchHtml('<b>加粗</b> and <strong>strong</strong> and <em>em</em> and <i>i</i>'))
      .toBe('<b>加粗</b> and <strong>strong</strong> and <em>em</em> and <i>i</i>');
  });

  it('文本在标签内不会被误净化（标签夹嵌套的查找词）', () => {
    const input = 'suli <b>"love"</b> them';
    expect(sanitizeSearchHtml(input)).toBe('suli <b>&quot;love&quot;</b> them');
  });

  it('闭合自闭合的白名单标签（自闭合变原样闭合标签）', () => {
    expect(sanitizeSearchHtml('<br></br>')).toBe('<br></br>');
  });

  it('已经转义的输入会被再次转义（双重转义是安全的贬值）', () => {
    expect(sanitizeSearchHtml('a &lt; b &amp; c')).toBe('a &amp;lt; b &amp;amp; c');
  });

  it('非字符串输入兜底', () => {
    expect(sanitizeSearchHtml(null as unknown as string)).toBe('');
    expect(sanitizeSearchHtml(undefined as unknown as string)).toBe('');
    expect(sanitizeSearchHtml(42 as unknown as string)).toBe('42');
  });
});
