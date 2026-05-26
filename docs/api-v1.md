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

Token 由 web Settings 页面创建/撤销 —— 见 [`/me/tokens`](#me-tokens-token-管理-cookie-only)。Bot **不能**用自己的 token 创建新 token（防止泄露横向扩散）。Token 落盘前做 SHA-256，明文只在创建时返回一次。

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

### `/me/tokens` — Token 管理（cookie-only）

这三个端点的 path 在 `/api/v1` 下，但**只接受 session cookie**，不接受 Bearer token。这是有意的安全边界：bot 拿到 token 不能自己增殖出更多 token。

```
POST   /api/v1/me/tokens     { label, forAccount? }   → 201 { tokenId, token, label, createdAt, forAccount }
GET    /api/v1/me/tokens     [?forAccount=...]        → 200 { tokens: [{ tokenId, label, createdAt, lastUsedAt? }] }
DELETE /api/v1/me/tokens/{tokenId}                    → 204
```

- `token` 形如 `la_<48 hex>`，**只在创建响应里返回一次**，server 不留明文（SHA-256 哈希存储）。
- `tokenId` 形如 `tok_<12 hex>`，稳定不变，列出 + 撤销用它。
- `forAccount`（可选）：把 token 颁发给一个**你拥有的公共账号**。默认 = 自己。token 解析后下游 endpoint 看到的就是该公共账号身份。非你拥有的 account → `403 not_account_owner`。
- 用 Bearer auth 调这三个端点 → `401`。

### `/me/accounts` — 公共账号管理（cookie-only）

公共账号 = ownerId 非空的 account（详见 [account model](./account-model.md)）。这一套端点让人类创建、列出、删除自己拥有的公共账号。

```
POST   /api/v1/me/accounts        { id }          → 201 { id, role, status, ownerId, createdAt }
GET    /api/v1/me/accounts                        → 200 { accounts: [...] }
DELETE /api/v1/me/accounts/{id}                   → 204
```

- 创建：caller 必须是个人账号（自己的 ownerId 为 null）。创建成功后这个 id 由 caller 拥有。
- 公共账号**没有 password**，不能 web 登录；只能由 owner 颁发 token 后通过 Bearer 访问。
- 删除：hard delete + 级联撤销其所有 token。Loop 文件残留在磁盘（admin 可恢复 / 清理），但 createdBy 指向已删除 id 后业务上不可访问。
- ID 命名规则跟人类账号同套：`[a-z0-9_-]{1,32}`，flat namespace，先到先得。

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

{
  "content": "hello",                    // string，≤ 1 MB
  "permission_mode": "bypassPermissions" // 可选；本 turn 临时覆盖 loop 的当前权限模式
                                         // 取值: default | acceptEdits | bypassPermissions | plan | dontAsk | auto
}
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
| `sdk_message` | **内部用** —— 原始 SDK 消息直传 | 原 SDK 消息对象（shape 由 Anthropic SDK 决定，**不稳定**）| 否 |

**`sdk_message` 是 loopat web 自己用的逃生口**：web 的 chat 视图需要完整 SDK 消息形态（content_block_delta、tool_use、thinking 等）才能渲染富 UI，与其重写整个 dispatch pipeline，直接把 SDK 消息原样转发给同一通道。Bot 框架**不应**依赖这个事件 —— 它的 shape 跟着 Anthropic SDK 变。稳定的对外契约仍是 `assistant_delta` / `tool_call` / `requires_choice` 等。

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

---

# 现状 (Implementation Status, 2026-05-26)

> 这一节描述**当前实现**，区别于上面是**契约**。改 v1 实现前先看这里。

## 端点实现对照表

| 端点 | spec | 实现 | 单测 | web 已切到 v1？ | 备注 |
|---|---|---|---|---|---|
| `POST /api/v1/loops` | ✅ | `api-v1.ts` | ✅ | NewLoopDialog | admin flag (knowledge_rw / mount_all_loops) 仍走 legacy `/api/loops` |
| `GET  /api/v1/loops` | ✅ | `api-v1.ts` | ✅ | — | web sidebar 用 legacy 端点（带更多字段） |
| `GET  /api/v1/loops/{id}` | ✅ | `api-v1.ts` | ✅ | — | 同上 |
| `DELETE /api/v1/loops/{id}` | ✅ | `api-v1.ts` | ✅ | — | web 用 legacy PATCH (archived=true) |
| `POST /api/v1/loops/{id}/messages` | ✅ | `api-v1.ts` | ⚠️ SSE 路径跳过 (无 provider) | enqueueMessage / onNew | `files` 字段 v1 不接受，有附件仍走 ws.send |
| `GET  /api/v1/loops/{id}/events` | ✅ | `api-v1.ts` | ⚠️ SSE 路径跳过 | useLoopRuntime SSE 监听 | snapshot 只含当前 turn，不重放历史 |
| `POST /api/v1/loops/{id}/choices/{id}` | ✅ | `api-v1.ts` | ✅ | answerPermission, sendAnswers | |
| `POST /api/v1/loops/{id}/interrupt` | ✅ | `api-v1.ts` | ✅ | onCancel | |
| `POST/GET/DELETE /api/v1/me/tokens` | ✅ | `api-v1.ts` + `api-tokens.ts` | ✅ | SettingsPage | cookie-only 已强制 |

测试覆盖：`server/test/api-v1.test.ts` 31 个，`e2e/loop.spec.ts` 含 2 个 v1 端到端（create + send/receive）。

## Web Hybrid 传输（当前 useLoopRuntime）

为了不重写 ~1400 行的 SDK 消息 dispatch pipeline，当前是 hybrid：

```
                ┌─ WS  /ws/loop/:id ───────────────────────────────┐
web ◄───receive ┤                                                  │
                └─ SSE /api/v1/loops/{id}/events  (sdk_message)────┘
                                                  ↓
                                  uuid dedupe → dispatchMsg

web ─────send ──── POST /api/v1/loops/{id}/messages         (user text)
                   POST /api/v1/loops/{id}/interrupt        (cancel)
                   POST /api/v1/loops/{id}/choices/{id}     (permission/question answer)

web ─── operator ── ws.send (set_goal, complete_goal, provider_select,
                              set_max_thinking_tokens, get_context_usage,
                              clear, queue_clear, queue_remove)
```

**uuid 去重**：WS + SSE 同时传 SDK 消息，按 `msg.uuid` 在 `dispatchMsg` 入口去重。非 uuid 消息（queue_update / viewers / provider）是幂等状态更新，重复 dispatch 没副作用。

**v1 SSE 的 `sdk_message` 事件**是 web 内部用的逃生口：把整个原始 SDK message 转发给 web。Bot 不应消费它（shape 不稳定）。

## 不在 v1 spec 内的活跃端点

| 端点 | 用途 | 现在谁在用 |
|---|---|---|
| `/api/loops/*` (legacy REST) | admin 创建 (knowledge_rw 等) / list / patch | web sidebar、admin 操作 |
| `/api/loops/:id/chat-history` | DM 历史 | 暂未启用 chat 功能 |
| `/ws/loop/:id` | history 回放 + initial state + operator 出站 | useLoopRuntime |
| `/ws/loop-status` | sidebar 状态点 | useLoopStatus |
| `/ws/kanban` | 看板 | useKanbanWebSocket |
| `/ws/loop/:id/term` | 终端 PTY | Terminal.tsx |
| `/ws/chat` | DM/频道 | useChatWebSocket（功能未开放）|
| `/api/personal/*`, `/api/admin/*`, `/api/serve/*` | web 私有功能 | SettingsPage、admin UI |

## 已知 gap（待办，按优先级）

1. **解耦 useLoopRuntime 的 WS 读** — 让 v1 SSE 成为唯一接收通道。需要先建：
   - `GET /api/loops/:id/initial-state` 内部端点，返回 `{ provider, permission_mode, goal, history[] }`
   - useLoopRuntime 用 fetch 拿 initial state → dispatch → 再开 SSE listen live
   - 移除 WS read，WS 仅作 operator 出站
2. **operator 功能 REST 化** — `clear / queue_clear / queue_remove / set_goal / complete_goal / set_max_thinking_tokens / get_context_usage / provider_select` 各 1 个内部 endpoint。web 完全去 WS。
3. **`files` 字段加进 POST /messages** — 当前附件场景仍走 WS。需要 spec 增项：`files?: [{ path, content }]`。
4. **`sdk_message` 事件计划淘汰** — 当上面 1+2+3 完成，web 可以直接消费 bot-facing v1 事件。届时 `sdk_message` 从 spec 移除。
5. **Idempotency 持久化** — 当前 `Map<string, IdempotencyRecord>` 在进程内存，server 重启丢。落 JSON 文件或 SQLite。
6. **GET /loops/{id}/messages 历史** — 当前 spec 无此端点，bot 想看历史只能保存自己的事件流副本。要不要加？取决于是否有 bot 需求。
7. **Token 创建支持 Bearer？** — 当前 spec 锁定 cookie-only，反对意见可重新讨论。
8. **GET /events 的 snapshot 不包含历史 turn** — 只有当前在进行的 turn。如果 bot 重连想看刚结束的 turn，看不到。

## 关键文件 + 行数

| 文件 | 内容 | 行数 |
|---|---|---|
| `server/src/api-v1.ts` | 所有 v1 路由 + SSE 流 + idempotency + ID prefixing | ~620 |
| `server/src/api-tokens.ts` | SHA-256 hashed token store | ~140 |
| `server/src/session.ts` | LoopSession：`onMessage`/`notifyListeners`/`sendUserText`/`interrupt`/`answerPermission`/`answerQuestions`/`isBusy`/`getQueueLength`/`hasPendingPermission`/`hasPendingQuestion` | ~1420 |
| `server/src/loops.ts` | `createLoop` / `patchLoopMeta` / `getLoop` / `listLoops`；LoopMeta 类型含 `metadata` 字段 | ~1540 |
| `server/test/api-v1.test.ts` | bun 集成测试 31 个 | ~320 |
| `web/src/api.ts` | fetch-based v1 client（`createLoop` / `listApiTokens` / etc.）+ legacy LoopMeta shape 翻译层 | ~1750 |
| `web/src/useLoopRuntime.tsx` | hybrid WS+SSE 消费 + chat 出站 POST | ~1450 |
| `web/src/pages/SettingsPage.tsx` | API tokens 管理 UI（用 `/me/tokens`）| 大 |
| `e2e/loop.spec.ts` | Playwright 11 个测试，含 2 个 v1 端到端 | ~210 |
| `docs/api-v1.md` | 本文 | — |

## 改这套东西的时候记得

1. **改 spec → 同步更新本节"已知 gap"和"实现对照表"**。  
2. **加 v1 endpoint** → spec 段先描述契约，再实现，再写测试，最后 web 集成。顺序很重要 —— 别先写实现再补 spec。
3. **去掉 hybrid（任务 1）时**，注意 reconnect 路径：现在 WS reconnect 触发完整 history 回放；SSE-only 后需要 initial-state fetch + 单独的 history 回放或重订阅。
4. **v1 spec 字段命名 = `snake_case`**，但**内部 LoopMeta 仍用 `camelCase`**。`metaToApi` 在 `api-v1.ts` 做翻译。新加字段时两边都要改。
5. **`metadata` 不能给 sandbox 内的 agent 看见**（spec 承诺）—— 写 metadata 处理代码时确认它没被注入 sandbox env / prompt。

## 与 web 的关系（已部分实现）

Web 的 chat 体验逐步迁到 v1：

- ✅ "New Loop" 对话框 → `POST /api/v1/loops`
- ✅ 用户消息 → `POST /api/v1/loops/{id}/messages`
- ✅ 权限/问题弹窗 → `POST /api/v1/loops/{id}/choices/{id}`
- ✅ 取消按钮 → `POST /api/v1/loops/{id}/interrupt`
- ✅ Live SDK 事件 → `GET /api/v1/loops/{id}/events` SSE（与 WS 并行，uuid 去重）
- ❌ 历史回放、initial state、operator 写入 → 仍是 WS

Web **永远不会迁**到 v1 的部分（per spec 边界）：

- Loop 列表小红点 / 状态指示（`/ws/loop-status`）
- 看板（`/ws/kanban`）
- 终端 PTY（`/ws/loop/:id/term`）
- Token 用量进度条（如果保留）
- DM / 频道（`/ws/chat`）
- 各种 admin / personal repo / 文件浏览端点
