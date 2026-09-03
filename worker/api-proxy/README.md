# 聊天 API 转发 Worker（解决线上站 "Failed to fetch"）

## 问题

部分 API 服务商（tokenrouter 等）的 WAF 拦截来自免费静态托管域名的跨域请求：

| 请求来源 | 结果 |
|---|---|
| `localhost` / `127.0.0.1`（本地开发） | ✅ 200 |
| `*.github.io` / `*.netlify.app` / `*.vercel.app` / `*.pages.dev` | ❌ 403，无 CORS 头 → 浏览器报 "Failed to fetch" |

所以本地 dev 一切正常、部署到 GitHub Pages 后聊天必失败。这不是你的配置问题。

## 解决

这个 Worker 部署在你自己的 Cloudflare 账号里，把 API 请求服务端转发出去（服务端不带 Origin 头，WAF 放行），并给浏览器补上 CORS 头。**API Key 只经过你自己的 Cloudflare，不经过任何第三方。**

### 部署步骤

```bash
npm install -g wrangler   # 已装跳过
wrangler login            # 浏览器授权 Cloudflare（免费账号即可）
wrangler deploy           # 在本目录（worker/api-proxy/）执行
```

输出会给你地址，形如 `https://sullyos-api-proxy.<你的子域>.workers.dev`。

### 改 SullyOS 配置

设置 → API 配置：
- **地址**：`https://sullyos-api-proxy.<你的子域>.workers.dev/v1`（只替换域名部分，key 和模型名都不变）
- 保存后立即生效，聊天/识图/预设全部走你的 Worker。

### 验证

浏览器打开 `https://sullyos-api-proxy.<你的子域>.workers.dev/v1/models`，看到模型列表 JSON 即成功。

### 换别的服务商

编辑 `wrangler.toml` 里的 `TARGET_HOST` 再 `wrangler deploy` 即可。
