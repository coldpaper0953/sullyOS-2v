# Conversation Event Contract

`conversation_events` 是前后端共享的统一时间线。前端必须先读取 `event_type`，再选择渲染组件；不能假定所有事件都是聊天气泡。

| `event_type` | 含义 | 未来前端默认表现 |
| --- | --- | --- |
| `user_message` | 用户普通消息 | 用户消息气泡 |
| `assistant_message` | AI 普通回复 | AI 消息气泡 |
| `proactive_message` | AI 自主发起的消息 | 带“主动发起”标识的消息 |
| `diary_entry` | AI 日记 | 日记卡片；正文同时保存到 `agent_diaries` |
| `autonomous_activity` | AI 自主进行的非 MCP 活动 | 自主活动卡片 |
| `mcp_activity` | MCP 调用、探索或结果摘要 | MCP 探索记录卡片 |
| `memory_update` | 新增、修改、归档或合并记忆 | 记忆变化卡片 |
| `scheduled_wake` | AI 或用户预约的下一次唤醒 | 预约事件卡片；计划同时保存到 `scheduled_wakes` |
| `activity_summary` | 一段后台活动的汇总 | 活动摘要卡片 |
| `system_event` | 同步、错误或系统状态 | 系统提示，默认可折叠 |
| `tool_activity` | 早期兼容类型 | 兼容卡片；新 MCP 数据应使用 `mcp_activity` |
| `platform_share` | 角色从 X/小红书等平台挑选并分享的一条内容 | X 使用网页链接卡片；小红书使用原生笔记卡片 |

## 兼容旧数据

旧 SullyOS IndexedDB 消息不需要原地迁移或改写：

- `role=user` 同步为 `user_message`。
- `role=assistant` 同步为 `assistant_message`。
- `role=system` 同步为 `system_event`。
- 原来的 `Message.type` 保存在 `source_message_type` 和 `metadata.sullyosMessageType` 中。
- 原来的数字消息 ID 保存在 `source_message_id` 中，用于去重、编辑和删除同步。

新增的主动消息、日记、活动、MCP、记忆和预约事件直接使用新的 `event_type`。因此新旧数据可以同时存在，前端逐步增加卡片渲染器即可，不需要一次性重写旧聊天记录。

## 内容与详情

- `content`：适合列表和通知显示的正文或摘要。
- `metadata`：该类型特有的结构化数据，例如工具名、参数摘要、日记心情、记忆 ID、预约原因。
- 不保存模型的原始思维链。`reason_summary` 只保存简短、可审计的行动理由。
- `sequence_id`：服务端时间线顺序；前端用它做增量拉取游标。
- `source_message_id`：仅用于映射旧 IndexedDB 消息，不能代替服务端事件 ID。
