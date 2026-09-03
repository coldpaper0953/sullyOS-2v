/**
 * SullyOS 聊天 API 转发 Worker
 *
 * 为什么需要它：部分 API 服务商（如 tokenrouter）的 WAF 拦截来自静态托管域名
 * （github.io / netlify.app / vercel.app / pages.dev 等）的跨域请求——返回 403 且
 * 不带 CORS 头，浏览器一律显示 "Failed to fetch"。本地开发（localhost/127.0.0.1）
 * 不受影响，所以「本地能聊、线上站不能聊」的根源在这里，不是你的配置问题。
 *
 * 原理：浏览器 → 你自己的这个 Worker（Worker 域名 CORS 全开）→ 服务端转发到
 * API 服务商（服务端请求不带 Origin 头，WAF 放行）。API Key 只经过你自己的
 * Cloudflare 账号，不经过任何第三方。
 *
 * 部署（约 2 分钟，需要免费注册 Cloudflare 账号）：
 *   1. 安装 Node 后执行：npm install -g wrangler
 *   2. wrangler login        （浏览器里授权 Cloudflare）
 *   3. wrangler deploy       （在本目录执行）
 *   4. 把部署输出里的地址（形如 https://xxx.workers.dev）填进
 *      SullyOS「设置 → API 配置」的地址栏：
 *      https://xxx.workers.dev/v1
 *      （key 和模型名不变）
 *
 * 验证：打开 https://xxx.workers.dev/v1/models，能看到模型列表 JSON 即成功。
 */

const DEFAULT_TARGET = 'https://api.tokenrouter.com';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

// 转发时剥掉浏览器指纹类头：WAF 按这些头拦托管域名来源。
const STRIP = new Set(['host', 'origin', 'referer', 'user-agent', 'accept-encoding', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']);

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }
        const url = new URL(request.url);
        // env 只在 fetch 的入参里存在，不能在模块顶层读——那样 Worker 一启动就 ReferenceError。
        const target = (env?.TARGET_HOST || DEFAULT_TARGET).replace(/\/+$/, '');
        const upstream = target + url.pathname + url.search;
        const headers = {};
        for (const [k, v] of request.headers) {
            if (!STRIP.has(k.toLowerCase())) headers[k] = v;
        }
        try {
            const init = {
                method: request.method,
                headers,
            };
            if (!['GET', 'HEAD'].includes(request.method)) {
                init.body = request.body;
                // @ts-ignore — Cloudflare Workers 支持 duplex 流式透传
                init.duplex = 'half';
            }
            const resp = await fetch(upstream, init);
            const out = new Response(resp.body, resp);
            for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
            return out;
        } catch (e) {
            return new Response(JSON.stringify({ error: '代理转发失败：' + (e && e.message || e) }), {
                status: 502,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
    },
};
