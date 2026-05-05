# 1001 框架（v3，2026-05-04）

## 一句话

**Loop is everything. Runtime is the membrane. Knowledge is the flow.**

## 核心模型：Loop 中心论

```
        ┌─────────────────────┐
        │                     │
context ──→        LOOP         ──→ context (new) + artifacts
        │       (人 ↔ AI)       │
        │                     │
        └─────────────────────┘
                   ↑
                Runtime
         (让"现实"能进入 loop：
          deploy / terminal / logs / 数据 / ...)
```

**Loop 是唯一的目的，Runtime 是手段，Knowledge 是流。**

## 三个概念

### Loop = 工作的基本单元

```
Loop = Workspace dir + Chat history + Participants + Artifacts
```

- **Workspace dir**：filesystem-native，代码 / md / ppt / 数据都在这
- **Chat history**：人 ↔ AI 的对话流，自带 timeline
- **Participants**：单人或多人，AI 是一阶身份
- **Artifacts**：loop 产出的可验证产物

生命周期：Open → Active → Closed / Forked → Archived

### Runtime = loop 与现实之间的薄膜

- 没 runtime → deploy 只在脑子里、logs 只在某终端、状态只在生产环境
- 有 runtime（loopctl）→ 这些都能进入 loop
- **Runtime 决定什么能进入 loop**

### Knowledge = 流经 loop 的流体

- 上一个 loop 的输出 = 下一个 loop 的输入
- 同一物在不同 loop 间换位置
- 不再是支柱，是流

## 关键洞察（按提出顺序）

1. **好的 runtime 压缩 knowledge** —— loopctl 把分散文档收敛进 CLI 自描述接口（`-h` 即学）
2. **工具能否存活看是否在"必经之路"上** —— GitHub issue 不死靠 PR merge 自动 close
3. **Thread closure = 做事的副产品**，不是单独动作
4. **View 不应该是 SoT** —— IM doc / tracker / todo doc 都是 view
5. **"汇报"也是 view**，不是 log
6. **AI 时代，工作即 chat** —— log / issue / chat 折叠为 Loop
7. **Issue 是外部的，Loop 是内部的** —— map 但不嵌套
8. **TODO 在 Loop 模型里是 view**，不是一阶概念

## 设计原则（自建系统的约束）

- 目录是一阶对象（loop = dir）
- AI 是一阶用户（无需 token / GUI）
- 代码 / markdown / 产物平等
- 无 GUI 必需，终端能跑就够
- Runtime 闭环第一性
- 零 lock-in

## Issue / Loop / TODO 的位置

| | 是什么 | 在哪 | 谁能见 |
|---|---|---|---|
| **Loop** | 内部工作单元 | 你本地 dir + chat | loop 参与者 |
| **Issue** | 外部任务 / 协调 | tracker / GitHub / 老板嘴里 | 团队 / 公开 |
| **TODO** | 跨 loop 或 loop 内的 view | 一个 query 渲染出来 | 看 view 的人 |

## 实施状态

| 元素 | 状态 |
|---|---|
| Knowledge | ✅ git docs（ccx/docs） |
| Runtime | 🚧 loopctl 扩展中（Heroku 风格闭环） |
| Loop | ❓ 模型已成型，实操开放 |
| IRC bot 雏形 | ✅ ergo + thelounge + coo（`~/workspace/im` 早期 Loop 实现）|

## 排除现有工具

| 工具 | 为什么不直接用 | 借鉴什么 |
|---|---|---|
| GitHub Issues | code-centric，非代码任务别扭 | PR merge 闭环模式 |
| Linear | SaaS、不 filesystem-native、不 AI-friendly | lifecycle 概念（多态状态、Triage、Cycle、Cancelled vs Done）|
| Obsidian | note-centric、GUI 流、缺 runtime 闭环 | Tasks / Dataview / backlinks 模式 |
| Notion / Jira | 太重、SaaS、AI 不友好 | — |
| IRC | 通信协议而非完整方案 | channel = 多人 loop 的早期形态 |

## 开放问题（Loop 实操层）

1. **Chat 协议**：IRC？claude-code conversation log？markdown？
2. **持久化**：append-only file？SQLite？
3. **Handoff**：怎么 onboard 新参与者？
4. **Fork**：git branch？复制目录？
5. **INDEX / view 怎么实现**：当前最关键问题（todo 问题退化到这里）
6. **AI session 与 loop chat 的对应**：1:1？多对多？

## 不再开放（已收敛）

- ~~Knowledge 是支柱还是派生~~ → **流**
- ~~Thread / Issue / Log / Chat 怎么区分~~ → **都是 Loop 的不同面 / 参与者多寡之别**
- ~~多人 thread 时 Log SoT 在哪~~ → **多人 loop = 多人 channel，本就在共享处**
- ~~汇报 / 周报 / tracker 工单怎么定位~~ → **都是 view**
- ~~是不是直接用 Obsidian / Linear / GitHub~~ → **不**，自建
- ~~TODO 系统怎么搞~~ → **不搞，是 view**

---

整套思想的演化路径在 `thoughts/` 里：

| 思考 | 主题 |
|---|---|
| `runtime-as-context-shrinker.md` | runtime 压缩 knowledge |
| `entity-log-view.md` | thread 数据模型（已折叠进 Loop）|
| `runtime-closes-the-loop.md` | 必经之路闭环原则 |
| `obsidian-deep-dive.md` | Obsidian 解读 + 借鉴 |
| `system-shape.md` | 自建决定 + 设计原则 |
| `loop.md` | Loop 概念定义 + Loop 中心论 |
| `todo-as-view.md` | TODO 是 view 不是一阶 |
