---
title: Loop API v1
tags: [loopat, api, loop, sse]
status: living doc
---

# Loop API v1

> **Loopat 的对外 API 第一版，只承载"和 loop 对话"。** 外部程序（机器人框架、自动化脚本）通过这套 API 创建并驱动 loop，体验和 web 上"打开一个 loop 聊天"完全一致。Web 自己的"NewLoopDialog"和 ChatInterface 也将基于这套 API 实现，使 web 成为这套 API 的 reference client。

## 定位

Loopat 不区分"人"和"agent"。所谓"agent" = "由程序通过 API token 操作的 user"。要造一个机器人：在 web 上注册一个 user → 配 profile/vault → 拿一个 token → 用这套 API 操作它的 loop。

v1 API **只**包含和 "loop 对话" 直接相关的能力。所有 web UI 的辅助功能（loop 列表小红点、看板、终端、token 用量进度条等）**不**进 API，继续走各自的 WebSocket。

```
v1 API surface = "聊天对话"
其它 = 内部 WS / 内部 REST，归 web 应用专用
```

判别一件事是否该进 v1 API 的硬标准：**它是不是对话本身的语义？**

## 基本约定

- **Base URL**：`https://<host>/api/v1`
- **Content type**：`application/json`（SSE 端点是 `text/event-stream`）
- **命名**：字段一律 `snake_case`，时间戳一律 RFC 3339 UTC，ID 带类型前缀（`loop_`、`turn_`、`choice_`）
- **版本**：本 spec 是 `v1`，破坏性变更上 `v2`

## 认证

两种方式，都解析成同一个 `user_id`：

| 调用方 | 方式 |
|---|---|
| 外部程序 | `Authorization: Bearer la_<hex>` |
| Web（同源） | Session cookie |

Token 创建、撤销、列表全部走 web —— **不**在 v1 API 内。Token 落盘前做 SHA-256，明文只在创建时返回一次。

认证失败：`401` + 标准 error body（见[错误格式](#错误格式)）。

## Loop 生命周期（重要）

**Turn 是异步的。** API 连接的开关**不**影响 turn 的运行：

- 关掉 SSE 流 ≠ 取消 turn。Turn 继续跑。
- 调用方稍后可以通过 `GET /events` 或带相同 `Idempotency-Key` 重新 POST 来重新订阅。
- 没人在听 SSE 不会让 loopat 提前结束 turn。

Turn 只在以下情况终止：

1. 正常完成 → `event: done`
2. Agent 自身的错误 → `event: error`
3. 调用方主动 `POST /interrupt` → `event: interrupted`
4. 沙箱被回收（见下）→ `event: error code=sandbox_evicted`

**沙箱闲置回收**：loop 在 30 分钟内没有任何 turn 活动（包括等 choice 应答这种"被动空闲"），沙箱被回收以节省资源。下一条消息会触发冷启动（`started.cold_start = true`）。

这是 v1 spec 在生命周期上**唯一**承诺的行为；不存在"permission 等多久会超时"、"question 等多久会超时"、"turn 跑多久会被砍"这种 API 层的截止时间。

## 资源模型

### Loop

```jsonc
{
  "id": "loop_3a91...",
  "title": "kanban refactor",
  "created_at": "2026-05-25T20:00:00Z",
  "created_by": "user_abc",
  "archived": false,
  "archived_at": null,
  "metadata": { "slack_thread": "C123:1234" },

  // 创建时确定的配置
  "profiles": ["base", "coding"],
  "vault": "default",
  "repo": "myproject",

  // 运行时状态（list 不返回，GET /loops/{id} 才返回）
  "busy": true,
  "queue_depth": 1,
  "turn_count": 5,
  "current_turn": {
    "turn_id": "turn_xyz",
    "started_at": "2026-05-25T20:05:11Z",
    "pending_choice_id": null
  }
}
```

| 字段 | 说明 |
|---|---|
| `id` | UUIDv4，前缀 `loop_` |
| `title` | ≤ 200 字符 |
| `metadata` | 自由 `Record<string, string>`，总大小 ≤ 16 KB。**Loopat 不解析；沙箱内的 agent 也看不到。**纯粹是 caller 自己的 escape hatch |
| `profiles` | 创建时选定的 profile 列表 |
| `vault` | 创建时选定的 vault 名 |
| `repo` | 创建时选定的 repo（loop workdir 从 `context/repos/<repo>` 派生），可为 `null` |
| `busy` | 当前是否有 turn 进行中或排队中 |
| `queue_depth` | 排在当前 turn 后面的消息数 |
| `current_turn` | `busy` 为 true 时出现 |

## 端点

### 创建 loop

```
POST /api/v1/loops
```

```jsonc
{
  "title": "kanban refactor",            // 可选，默认 "untitled"
  "metadata": { "slack_thread": "..." }, // 可选
  "profiles": ["base", "coding"],        // 可选，默认 = user 的 default_profiles
  "vault": "default",                    // 可选，默认 = user 的 default_vault
  "repo": "myproject"                    // 可选；为空则 workdir 为空目录
}
```

`201 Created` 返回完整 Loop 对象。

字段语义与 web 上的"New Loop"对话框完全等价 —— web 也调用这个端点。

### 列出 loops

```
GET /api/v1/loops?limit=20&after=loop_xxx&archived=false
```

返回调用方自己的 loop（`created_by == user_id`），按最近活跃倒序。

```jsonc
{
  "data": [ { "id": "...", ... }, ... ],
  "first_id": "loop_a",
  "last_id": "loop_z",
  "has_more": true
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `limit` | 20 | 最大 100 |
| `after` | — | 游标（loop id），返回严格更老的 |
| `before` | — | 游标，返回严格更新的 |
| `archived` | `false` | 设 `true` 包含已 archive 的 |

`busy` / `queue_depth` / `current_turn` 在 list 响应中**不**返回；如要这些字段，调用 `GET /loops/{id}`。

### 获取 loop

```
GET /api/v1/loops/{id}
```

返回完整 Loop 对象（含运行时状态）。

### Archive loop

```
DELETE /api/v1/loops/{id}
```

设置 `archived = true`，杀沙箱，释放磁盘。返回 `204`。

反 archive 和硬删走 web —— **不**在 API 内。

### 发送消息（并流式接收 turn）

```
POST /api/v1/loops/{id}/messages
Authorization: Bearer la_...
Idempotency-Key: <client 生成>           # 强烈推荐
Content-Type: application/json
Accept: text/event-stream

{ "content": "hello" }                   # string，≤ 1 MB
```

响应：`200`，`Content-Type: text/event-stream`。事件词表见 [SSE 事件参考](#sse-事件参考)。

语义：

- loop **空闲**时，这条消息直接成为下一个 turn，流以 `event: started` 开始
- loop **忙**时，消息入队，流以 `event: queued` 开始，轮到时再发 `event: started`
- **调用方关闭连接，turn 继续运行**。重连方式：用相同 `Idempotency-Key` 重新 POST，或者用 `GET /events`

流开始**前**的错误（`401`、`404`、`409`）返回 JSON，**不是** SSE。流开始**后**的错误用 `event: error` 然后关流。

### 观察 loop（只读流）

```
GET /api/v1/loops/{id}/events
Accept: text/event-stream
```

附加到 loop 的实时事件流，**不发新消息**。用途：

- 断线重连（手头没有 `Idempotency-Key`）
- 前端被动查看其他人驾驶的 loop
- 多个并行观察者

连接建立时，如果当前有 turn 正在跑，server 先发 `event: snapshot` 给出当前状态（含已累积的 assistant 文本和待应答的 choice），然后继续推 live 事件。关掉这个流**不影响** turn。

### 回答 choice

```
POST /api/v1/loops/{id}/choices/{choice_id}
Content-Type: application/json
```

`kind = "permission"`：
```jsonc
{ "allow": true }     // 或 false
```

`kind = "question"`：
```jsonc
{ "answers": { "<question_id>": "<selected_value>", ... } }
```

成功返回 `202 Accepted`；`choice_id` 不存在或已被应答返回 `404`。

未应答的 choice **不会主动超时**。Agent 会一直等，直到：

- 有人通过这个端点（或 web）应答 →  `event: choice_resolved`
- 沙箱因 30 分钟无活动被回收 → turn 失败，`event: error code=sandbox_evicted`
- 有人调 `POST /interrupt` → `event: interrupted`

### 中断当前 turn

```
POST /api/v1/loops/{id}/interrupt
```

取消当前 turn，返回 `202`。所有打开的 SSE 流收到 `event: interrupted` 并关闭。

## SSE 事件参考

每个事件是 `event: <name>\ndata: <json>\n\n`，所有 payload 是 JSON object。`POST /messages` 和 `GET /events` 共用同一套词表。

| 事件 | 触发时机 | Payload | 终止流？ |
|---|---|---|---|
| `queued` | POST 时已有人排队，最先发 | `{ "position": 1 }` | 否 |
| `started` | turn 开始（任何 delta 前必有）| `{ "turn_id", "cold_start": false }` | 否 |
| `snapshot` | 仅 `GET /events` 接入且 turn 已在跑 | `{ "turn_id", "assistant_text_so_far", "pending_choice_id" }` | 否 |
| `assistant_delta` | 可见文本增量 | `{ "text": "..." }` | 否 |
| `thinking_delta` | extended-thinking 增量（观察）| `{ "text": "..." }` | 否 |
| `tool_call` | agent 调工具（**只读观察**，不需要回应）| `{ "tool_use_id", "tool", "input_summary"? }` | 否 |
| `tool_result` | 工具调完 | `{ "tool_use_id", "ok": true }` | 否 |
| `requires_choice` | agent 被卡住，等决定 | `{ "choice_id", "kind", "payload" }` | 否 |
| `choice_resolved` | choice 被应答（通过 API 或 web）| `{ "choice_id", "source": "api"\|"web" }` | 否 |
| `done` | turn 正常完成 | `{ "turn_id" }` | **是** |
| `interrupted` | turn 被中断 | `{ "turn_id" }` | **是** |
| `error` | 不可恢复 | `{ "code", "message", "turn_id"? }` | **是** |
| `ping` | 心跳 | `{}` | 否，每 15s |

**没有委托式 tool_call**：API 永远不要求调用方执行工具。`tool_call` / `tool_result` 是纯观察事件 —— 调用方没有"提交工具结果"的端点，因为这种端点不存在。所有工具都在 loop 沙箱里跑。

**`done` 不重发完整文本**：调用方自己累加 `assistant_delta`。Idempotency 重放会重新发同一序列的 delta，所以重建是确定性的。

**Choice payload 形态** ——

`kind = "permission"`：
```jsonc
{ "tool": "Bash", "command": "rm -rf /tmp/x", "reason": "agent wants to..." }
```

`kind = "question"`：
```jsonc
{ "questions": [
    { "id": "q1", "question": "...", "options": [...], "multi_select": false },
    ...
  ] }
```

## 幂等性

`POST /messages` 上加 `Idempotency-Key: <唯一 string，≤ 256 字符>`（其他写操作天然幂等）。

- Server 把 `(user_id, key) → 请求 hash + 事件缓冲` 保存 24 小时
- **同 key + 同请求 hash**：重放缓冲的事件。如果 turn 还在跑，挂到 live 流上
- **同 key + 不同请求 hash**：`409 conflict_error`

这是 SSE 断流恢复的标准做法。

## 错误格式

非 SSE 错误：

```jsonc
{
  "error": {
    "type": "invalid_request_error",
    "code": "loop_archived",
    "message": "Cannot send messages to an archived loop"
  }
}
```

| HTTP | `type` | `code` 举例 |
|---|---|---|
| 400 | `invalid_request_error` | `missing_content`、`content_too_large`、`loop_archived` |
| 401 | `authentication_error` | `invalid_token`、`missing_credentials` |
| 403 | `permission_error` | `not_loop_owner` |
| 404 | `not_found_error` | `loop_not_found`、`choice_not_found` |
| 409 | `conflict_error` | `idempotency_key_reused` |
| 429 | `rate_limit_error` | `too_many_requests` |
| 500 | `internal_error` | `sandbox_spawn_failed`、`sandbox_evicted` |

流中错误（SSE 已开后）发 `event: error { code, message }` 然后关流。

## 上限

| 项目 | 限制 |
|---|---|
| `title` | 200 字符 |
| `metadata` | 16 KB（JSON 序列化后）|
| `content`（单条消息）| 1 MB |
| `Idempotency-Key` | 256 字符 |
| 幂等性窗口 | 24 小时 |
| 沙箱闲置回收 | 30 分钟 |
| 速率限制 | per-token，平台层配置（不在 spec 内）|

## 示例

### 完整对话

```
> POST /api/v1/loops
> { "title": "demo" }
< 201 { "id": "loop_a1", ... }

> POST /api/v1/loops/loop_a1/messages
> Idempotency-Key: 0e92...
> { "content": "list files in /tmp" }
< 200 text/event-stream
< event: started      data: { "turn_id": "turn_b2", "cold_start": true }
< event: tool_call    data: { "tool_use_id": "tu_1", "tool": "Bash", "input_summary": "ls /tmp" }
< event: tool_result  data: { "tool_use_id": "tu_1", "ok": true }
< event: assistant_delta data: { "text": "Here are " }
< event: assistant_delta data: { "text": "the files: ..." }
< event: done         data: { "turn_id": "turn_b2" }
```

### 处理 permission choice

```
> POST /api/v1/loops/loop_a1/messages
> { "content": "now rm -rf /tmp/foo" }
< event: started      ...
< event: requires_choice data: {
    "choice_id": "choice_c3",
    "kind": "permission",
    "payload": { "tool": "Bash", "command": "rm -rf /tmp/foo" }
  }

# 在另一个连接里（或 web 上）：
> POST /api/v1/loops/loop_a1/choices/choice_c3
> { "allow": true }
< 202

# 回到流上：
< event: choice_resolved data: { "choice_id": "choice_c3", "source": "api" }
< event: tool_call ...
< event: done
```

### 断流重连

```
# 原 POST 在 assistant_delta 中途断了
# Bot 框架重新 POST，带同样的 Idempotency-Key：

> POST /api/v1/loops/loop_a1/messages
> Idempotency-Key: 0e92...
> { "content": "list files in /tmp" }
< 200 text/event-stream
# Server 重放之前缓冲的事件 + 继续 live 流
< event: started ...
< event: tool_call ...
< event: tool_result ...
< event: assistant_delta ...
< event: assistant_delta ...
< event: done ...
```

## 与 web 的关系

Web 的 chat 体验（NewLoopDialog、ChatInterface）将逐步迁移到这套 API：

- "New Loop" 对话框 → `POST /api/v1/loops`
- 主聊天面板 → `POST /api/v1/loops/{id}/messages`（SSE）
- 权限/问题弹窗 → `POST /api/v1/loops/{id}/choices/{id}`
- 取消按钮 → `POST /api/v1/loops/{id}/interrupt`

Web **不**迁移的部分（继续走原 WS / 原内部 REST）：

- Loop 列表小红点 / 状态指示（`/ws/loop-status`）
- 看板（`/ws/kanban`）
- 终端 PTY（`/ws/loop/:id/term`）—— 真双向，SSE 不适合
- Token 用量进度条（如保留则走原 WS）
- DM / 频道（`/ws/chat`）
- 各种 admin / personal repo / 文件浏览端点

迁移完成后："**API 测了 = chat 体验也基本测过了**"成立。
