# SullyOS 后端第一次 VPS 部署

这份流程只部署稳定地基：PostgreSQL、迁移服务、API 和 HTTPS。自主心跳 Worker 默认关闭；网页、小红书、手机与 MCP 适配器不在第一次部署范围内。

## 1. 部署前必须准备

- 一台能运行 Docker Engine 与 Docker Compose plugin 的 Linux VPS。
- 一个专用 API 子域名，例如 `api.example.com`，其 A/AAAA 记录已经指向 VPS。
- VPS 防火墙只对公网开放 SSH、TCP 80、TCP/UDP 443。PostgreSQL 和 Node API 不开放公网端口。
- SSH 使用密钥登录；保存一份原版/新版 SullyOS 前端导出备份。

Caddy 通过 80/443 自动申请和续期 HTTPS 证书，因此 DNS 必须先解析到 VPS，云厂商安全组也必须放行这两个端口。

## 2. 生产包结构

- `compose.production.yaml`：生产容器、私有网络和默认关闭的 Worker profile。
- `deploy/Caddyfile`：HTTPS 与反向代理入口。
- `.env.production.example`：不含真实密钥的配置模板。
- `scripts/generate-production-env.sh`：生成随机数据库密码、APP token 和模型保险库密钥。
- `scripts/deploy-production.sh`：配置检查、构建、迁移与启动。
- `scripts/healthcheck-production.sh`：验证 HTTPS、鉴权、API 与数据库。
- `scripts/backup-database.sh` / `restore-database.sh`：可校验备份与显式确认恢复。

## 3. 服务器首次启动

把 `backend` 整个目录放到 VPS 后进入该目录：

```bash
bash scripts/generate-production-env.sh
nano .env.production
```

至少修改：

```dotenv
SULLYOS_DOMAIN=你的API子域名
SULLYOS_TLS_EMAIL=你的证书通知邮箱
ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,https://你的正式前端域名
```

`ALLOWED_ORIGINS` 填浏览器地址栏所对应的 Origin，不是 API 地址；不得使用 `*`。

确认 DNS 已生效后执行：

```bash
bash scripts/deploy-production.sh
bash scripts/healthcheck-production.sh
```

成功后只会看到 `postgres`、`api`、`caddy` 常驻；`migrate` 正常退出；`worker` 不应运行。

## 4. 从当前电脑迁移数据库

先在当前电脑的 Ubuntu/WSL、现有后端目录中执行：

```bash
bash scripts/backup-database.sh --local
```

将生成的 `.dump` 和同名 `.sha256` 安全传到 VPS，再执行：

```bash
bash scripts/restore-database.sh --confirm-restore /绝对路径/sullyos-local-时间.dump
bash scripts/healthcheck-production.sh
```

### 模型池加密密钥不能弄丢

数据库中的模型 API Key 使用 `MODEL_VAULT_KEY` 加密。如果本地 `.env` 的 `MODEL_VAULT_KEY` 非空，VPS 必须使用同一个值；如果本地该项留空，则旧数据实际使用旧 `APP_TOKEN` 派生，应该把旧 `APP_TOKEN` 作为 VPS 的 `MODEL_VAULT_KEY`。VPS 自己的 `APP_TOKEN` 仍可换成新的随机值。

不要把这些密钥发到聊天、GitHub 或截图中。灾难恢复至少需要两样东西：数据库 `.dump` 和离线保存的 `.env.production`。

## 5. 前端切换与验收顺序

在 SullyOS 设置页把后端地址改为：

```text
https://你的API子域名
```

同时填入 `.env.production` 中的新 `APP_TOKEN`，按顺序验证：

1. 后端健康与模型池测试。
2. 普通聊天和模型自动故障转移。
3. 完整同步角色、聊天和记忆宫殿。
4. 新建、评论、删除日记，刷新后数据不复活。
5. 删除聊天上下文与记忆节点，确认前后端一致。
6. 关闭浏览器和本地 Docker，重新打开前端，确认仍能连接 VPS。

这一轮不要开启 Worker。先连续使用一段时间并完成一次备份与恢复演练。

## 6. 通过后再开启一个角色的心跳

容器级 Worker 开关：

```bash
docker compose --env-file .env.production -f compose.production.yaml --profile heartbeat up -d worker
```

停止：

```bash
docker compose --env-file .env.production -f compose.production.yaml --profile heartbeat stop worker
```

Worker 运行不等于所有角色都会苏醒；角色自己的后端开关、空闲阈值、时段、冷却和概率仍然生效。第一次只启用最常聊天的角色，并提高空闲阈值和冷却时间观察。

## 7. 日常备份与更新

手动备份：

```bash
bash scripts/backup-database.sh --production
```

更新代码后重新部署：

```bash
bash scripts/deploy-production.sh
```

部署脚本会主动停止 Worker，避免迁移期间自主写入。更新验收完成后再手动启用 Worker。

备份目录和 `.env.production` 已被 Git 忽略。不要执行 `docker compose down -v`，它会删除数据库卷和 Caddy 证书数据。
