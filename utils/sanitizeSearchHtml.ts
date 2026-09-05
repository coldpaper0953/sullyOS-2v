/**
 * 搜索结果描述净化器。
 *
 * 用法：BrowserApp 的搜索结果描述字段里带着供应商原样的 HTML
 * （仅是为了给 query 关键字加粗），但那段 HTML 来自搜索结果层，属于
 * 攻击者可影响的内容。不能裸丢 dangerouslySetInnerHTML。
 *
 * 策略（信任面极小、代价可控）：
 *  1. 只放行一组白名单内联标签：<b> <strong> <em> <i> <br> ——其他标签删掉
 *     但保留文本（escape 后回流）。
 *  2. 白名单标签只允许纯标签名，任何属性都不要（onclick/style/href 全剥）。
 *  3. 其余所有 < 先转义，防止有人构造残余的 「<img src=x onerror=…>」
 *     或「</style><script>」这类逃逸。
 */

/** 白名单标签（开/闭都算）。 */
const ALLOWED = new Set(['b', 'strong', 'em', 'i', 'br']);

/** 先转义任意 HTML 特殊字符，再把白名单标签从转义结果里挖回来。 */
export function sanitizeSearchHtml(input: unknown): string {
  const raw = typeof input === 'string' ? input : String(input ?? '');
  // 1) 整体 HTML 转义：< > & " ' 全部实体化。原始标签此刻全部失效。
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // 2) 把白名单标签以「纯标签名」的形式挖回来。只匹配字母名，任何属性都被提前
  //    阻止了（&lt;b onclick=…&gt; 不会命中）。
  return escaped.replace(
    /&lt;\/?([a-zA-Z]+)\s*\/?\s*&gt;/g,
    (whole, tag: string) => {
      const lower = tag.toLowerCase();
      if (!ALLOWED.has(lower)) return whole;      // 不在白名单：保持转义
      const closing = whole.startsWith('&lt;/');
      return `<${closing ? '/' : ''}${lower}>`;   // 干净的原生子标签
    },
  );
}
