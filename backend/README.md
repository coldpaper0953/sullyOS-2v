# SullyOS Backend

这是 SullyOS 的独立常驻后端基础层。当前版本负责：

- PostgreSQL 作为服务端权威数据源
- 使用类型化事件保存聊天、主动消息、日记、工具活动和记忆更新
- 幂等同步 SullyOS 的角色核心资料、聊天消息和完整记忆宫殿
- 通过 OpenAI-compatible `/chat/completions` 接口完成普通聊天
- 提供按角色独立启用的心跳决策器与 Worker（默认不启动）
- 将需要投递的主动消息写入 outbox
- 提供前端以后可以接入的 HTTP API

第一阶段核心表已经建立：`characters`、`conversations`、`conversation_events`、`agent_state`、`memory_items`、`agent_diaries`、`wake_runs`、`scheduled_wakes`、`outbox`、`push_subscriptions`。

事件类型与未来前端组件的固定映射见 [`docs/event-contract.md`](docs/event-contract.md)。

当前版本已经可以为“普通聊天”和心跳决策调用真实 AI，但不会发送 Web Push。心跳 Worker 被放在 `heartbeat-preview` Compose profile 中，普通 `docker compose up` 时不会启动。

## VPS 生产部署

生产环境不要直接使用本地 `compose.yaml`。仓库已经提供独立的 `compose.production.yaml`、Caddy HTTPS 入口、生产环境模板，以及备份/恢复和健康检查脚本。完整步骤见 [`docs/vps-deployment.md`](docs/vps-deployment.md)。生产 Compose 不公开 PostgreSQL 和 Node API 端口，只有 Caddy 暴露 80/443；Worker 位于 `heartbeat` profile 中并默认关闭。

上下文同步只接收角色核心资料、用户称呼/简介、消息与记忆。完整记忆迁移还会接收节点、向量、关系、事件盒、房间门牌、期盼、消化报告，以及仅用于兼容旧数据的处理批次和旧话题盒。前端 API Key、头像、主题和其他界面资源不会进入这些接口。

## 本地启动

在 Ubuntu/WSL 中进入项目：

```bash
cd /mnt/c/Users/86130/Documents/sullyos/backend
cp .env.example .env
pnpm install
docker compose up --build -d
```

启动前请在 `backend/.env` 填写已经测试成功的模型配置：

```dotenv
MODEL_BASE_URL=https://你的接口地址/v1
MODEL_API_KEY=你的密钥
MODEL_NAME=你的模型名
```

`MODEL_BASE_URL` 不要包含末尾的 `/chat/completions`。修改 `.env` 后执行：

```bash
docker compose up -d --build api
```

检查服务：

```bash
docker compose ps
curl http://localhost:43210/health
```

健康接口应返回 `"ok":true`。

## 验证一次主动消息链路

先手动触发一轮演示心跳：

```bash
curl -X POST http://localhost:43210/v1/heartbeats/run \
  -H 'Authorization: Bearer change-this-local-token' \
  -H 'Content-Type: application/json' \
  -d '{"demoMessage":true}'
```

然后读取事件：

```bash
curl 'http://localhost:43210/v1/events?limit=20' \
  -H 'Authorization: Bearer change-this-local-token'
```

返回结果中应出现 `event_type` 为 `proactive_message` 的测试事件。

## 上下文同步接口

`POST /v1/context/sync` 支持重复提交同一批数据。消息使用“角色会话 + IndexedDB 消息 ID”去重，记忆使用“角色 + MemoryNode ID”去重，因此重试不会产生重复上下文。

`GET /v1/context/:characterId` 返回该角色的核心档案、近期消息、活跃记忆和心跳状态，供下一阶段的 AI 决策器使用。

编辑后的消息或记忆可以用原 ID 重新提交；删除操作使用 `deletedMessageIds` 与 `deletedMemoryIds` 墓碑列表同步。

浏览器还会为记忆节点、向量、关系、事件盒、门牌、期盼和消化报告记录本地增量队列。下一次使用新后端普通聊天时会先幂等补传这些修改；后端确认成功后才会移除队列项，断网不会丢掉待同步变更。

新版 SullyOS 的“设置 → 本地自主后端（第二阶段）”提供“完整同步角色、聊天与记忆宫殿”按钮。建议先在原版导出完整备份，再在新版导入，然后执行一次完整同步。消息、节点、向量及其他结构会自动分片，重复执行仍按原 ID 去重；最后一轮会按前端完整 ID 清单清理后端中已经失效的旧迁移副本，并逐类核对数量。原前端数据不会被删除。

记忆宫殿使用两个接口：`POST /v1/memory-palace/sync` 分片写入完整结构，所有分片携带同一个 `snapshotId`；`POST /v1/memory-palace/reconcile` 最终只提交这个小型编号，后端据此对齐快照，因此十万级关系网也不需要一次上传完整 ID 清单。`GET /v1/memory-palace/:characterId/stats` 返回逐类数量供前端验收。关系网只同步两端都属于当前角色的连接，避免不同角色的节点被串联。

旧版消息可能包含超大的图片 Base64、旧房间枚举或异常时间字段。同步器会保留普通文本与记忆语义，媒体改为占位说明，超长内容仅在上传副本中安全截断，并归一化旧字段；原 IndexedDB 数据不会被修改。

## 普通聊天接口

`POST /v1/chat/turn` 支持两种上下文模式：`frontend_snapshot` 接收 SullyOS 现有提示词快照；`server_native` 由后端读取角色设定、近期聊天、门牌、相关记忆、事件盒关系和期盼，只组装一次系统提示词。前端开启“使用新后端聊天”后会先同步当前角色上下文，再调用此接口；后端暂不可用时本轮自动回退到原前端直连。

`GET /v1/model/status` 只返回“是否已配置”、模型名和供应商 origin，不返回 API Key。

## 后端模型池

`backend/.env` 中的模型会作为只读的 `env-primary` 主模型。设置页可以继续新增不同站点或不同模型，并选择：

- `auto`：优先调用选中的主模型；失败、超时、限流或响应格式异常时依次尝试后备模型。
- `fixed`：只调用选中的模型，适合排障或强制指定。

设置页新增模型的 API Key 使用 AES-256-GCM 加密后存入 PostgreSQL。加密密钥由 `MODEL_VAULT_KEY` 提供；未单独配置时由 `APP_TOKEN` 派生。不要在已有加密模型配置后随意改变这两个值，否则旧密钥将无法解密。

## 停止服务

```bash
docker compose down
```

数据库数据保存在 Docker volume 中，普通的 `docker compose down` 不会删除它。不要运行 `docker compose down -v`，除非确实准备清空本地数据库。

## 角色自主心跳与能力边界

设置页可以为每个角色单独开启或关闭心跳，并热更新以下参数：5–120 分钟检查间隔、空闲阈值、允许活动时段、自主活动冷却，以及低/中/高概率档位。系统按这个顺序做低成本判断，全部通过后才调用模型；冷却只统计主动消息、日记与探索，不会把普通聊天误算成自主活动。关闭某个角色的心跳不会影响普通聊天。

普通回复和自主苏醒共用同一份角色资料、聊天事件、门牌、记忆关系网与模型池。后端还支持隐藏的预约苏醒协议：角色若确实想在未来某个准确时间继续一件事，可以预约一条 `scheduled_wake`；到点后绕过随机概率与冷却直接进入同一决策链路。预约标记会在保存和返回前移除，不会显示在聊天气泡里。

网页、小红书、手机感知、通用 MCP 和外部写入目前只是独立权限位，适配器状态仍为“待接入”。即使提前勾选授权，它们也不会进入模型可用能力清单，AI 不能调用或虚构结果。后续每接入一种适配器，都必须同时补充健康检查、权限校验、超时和审计后，才会把该能力标记为可用。

## 当前边界

这只是后端地基。下一阶段需要继续完成：

1. 增加服务端到前端的事件增量拉取和冲突处理。
2. 实现 Web Push 和前端收件箱。
3. 逐个接入网页、小红书、手机感知和 MCP 适配器。
4. 为外部写入增加逐次确认、预算、超时和完整审计。
