# 1001 Prototype Status

> 高保真原型的当前状态。所有 tab 内容都是 mock，无后端逻辑，但视觉形态、交互骨架已完整。

## 跑起来

**Server side（Ubuntu）已经在跑**：

```
opencode web (server)        :4000     ← 后端 + opencode 自带 web UI（不用）
vite dev (packages/app)      :3000     ← 我们改造过的前端
```

**Mac 端**：

```bash
ssh -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 simpx@<host>
# 浏览器打开
http://localhost:3000/?auth_token=b3BlbmNvZGU6bG9vcDEwMDE=
```

## 当前看到的 UI

```
┌──────────────────────────────────────────────────────────┐
│ Team: loopey · [Loop·][Context][Focus·6][Chat]  ⚙  @  │ ← 顶层 4 tab
├──────────────────────────────────────────────────────────┤
│ 当前 tab 完全占领下方                                      │
└──────────────────────────────────────────────────────────┘
```

切 tab 看 4 个 mock：

- **Loop**：扁平 loop 列表（无 project 嵌套），右侧 chat 用 `<user>`/`<ai>` 统一身份，driver 变更作为系统横线插入
- **Context**：sidebar 分 **Docs**（markdown 树）+ **Repos**（git 仓列表），点 repo 看"最近 loops + spawn loop"
- **Focus**：Zen 单列，3 段（📌 Pinned · focus 8d 自动归档 · active loops not in focus）
- **Chat**：Slack-like 多 channel + DM（保留人名，因为是真群聊不是 Loop chat）

## 已实现的概念映射

```
人类稀缺资源 ↔ tab：
  欲望驱动力 → Loop
  注意力     → Focus     (Zen，对抗注意力稀释)
  熵减能力   → Context   (Docs + Repos，团队精简过的资产)
  协调通道   → Chat
```

```
opencode 概念  ↔  我们暴露的概念
  Project       (隐藏)            ← 只在后端，UI 不显
  Workspace     (隐藏)            ← git worktree 概念，power user 才看
  Session       Loop 的活跃 chat  ← 一个 Loop 一个活跃 session，老的进 history
  WorkspaceID   = ccx 的 dir      ← 扁平 list，每个 dir 是一件"事"
```

```
Loop ↔ Focus = 多对多
  Focus 时间戳 = max(关联 loops 的最后 round, manual update)
  无活动 8 天 → focus 自动归档
  Pinned 永不归档
```

## 改了哪些代码

在 `~/workspace/1001/opencode/`（fork 自 sst/opencode `dev` 分支）：

| 文件 | 状态 |
|---|---|
| `packages/app/src/components/loop-tabs.tsx` | 新增：`LoopTabsProvider` + `LoopTabBar` |
| `packages/app/src/pages/layout.tsx` | 改：插入 `LoopTabBar`、用 `PrototypeBody` 切 4 tab、隐藏老 chrome |
| `packages/app/src/pages/loop-tab-loop.tsx` | 新增 mock |
| `packages/app/src/pages/loop-tab-context.tsx` | 新增 mock（替代 loop-tab-doc.tsx）|
| `packages/app/src/pages/loop-tab-focus.tsx` | 新增 mock（替代 loop-tab-todo.tsx）|
| `packages/app/src/pages/loop-tab-chat.tsx` | 新增 mock |

约 1200 行 SolidJS + Tailwind 新代码。后端（opencode core/server）零改动。

## 是 mock 不是真实

- Loop 列表是写死的（gateway-launch / loopctl / ...）
- Context 文件树写死，markdown 是手敲的
- Focus 的 expires 倒计时是写死的
- Chat 频道和消息是写死的
- 切 tab、点选 loop、点选 doc 都有 hover/active 反馈，但**没有保存**

## 下一步候选

按优先级：

1. **先用一段时间感受形态** —— 看看 4 tab 心智 / Zen / 多对多关联是不是真对
2. **Loop tab 接真实数据** —— 从 opencode HTTP API 拉 sessions 列表 + chat 内容（替代 mock）
3. **Doc tab 接真实 git** —— 用 project worktree 的 git 跟踪 markdown 文件
4. **Focus + Loop 关联实现** —— 加一个 SQLite 表存 focus，meta 里 link loops
5. **Agent 回流** —— loop turn 后自动摘要到 inbox.md

## 哲学回顾

详细见 `1001.md`：

> Loop is everything.
> Runtime is the membrane.
> Knowledge is the flow.
>
> 人类稀缺资源（欲望/注意力/熵减能力）三种 → 三个一阶 tab。
