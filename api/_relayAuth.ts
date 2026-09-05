/**
 * api/ 下所有转发器共用的鉴权闸门。
 *
 * 背景：这些 serverless 转发器支持「调用方带自己 key → 用自己的」+「不带 key →
 * 回落到部署者的付费环境变量（MINIMAX_API_KEY 之类）」。第二条路径本身是设计外的
 * 旁路：部署者填了密钥，任何人就能白嫖它。所以给环境变量 fallback 加一道门：
 * 设置 SULLY_RELAY_TOKEN 之后，所有想吃到部署者密钥的请求必须带
 * `x-sully-relay-token: <这个值>` 头，否则只能用自己的 key。
 */

/** 判定是否允许使用环境变量里的部署者 key。未配置 SULLY_RELAY_TOKEN 时保持旧行为（放行）。 */
export const permitEnvApiKey = (req: { headers?: Record<string, unknown> }): boolean => {
  const expected = typeof process.env.SULLY_RELAY_TOKEN === 'string'
    ? process.env.SULLY_RELAY_TOKEN.trim()
    : '';
  if (!expected) return true;
  const header = req.headers?.['x-sully-relay-token'];
  return typeof header === 'string' && header.trim() === expected;
};
