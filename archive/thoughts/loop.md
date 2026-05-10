# Loop —— 1001 的基本单元

## 命名（2026-05-04）

之前讨论里的"channel"是借 Slack 的占位词，正式命名为 **Loop**。

理由：
- 短（4 字母）
- 动词形式天然："loop someone in" = 把人拉进来
- 捕捉 AI 时代的本质 —— 跟 AI 协作就是 feedback loop
- 与 Bret Victor 的 "feedback loop tightness" 暗合
- **杀手点**："close the loop" 直接对应 runtime 闭环原则

## Loop 中心论（2026-05-04 进一步收敛）

模型不是"Loop + Runtime 两支柱"，而是 **Loop 是中心，其他都为它服务**：

```
        ┌─────────────────────┐
        │                     │
context ──→        LOOP         ──→ context (new) + artifacts
        │       (人 ↔ AI)       │
        │                     │
        └─────────────────────┘
                   ↑
                Runtime
         (让"现实"能进入 loop)
```

- **Loop** = 唯一的"目的"。一切存在为了让 loop 跑起来
- **Knowledge** = 流经 loop 的"流"。上一个 loop 的输出 → 下一个 loop 的输入。同一物，相对时间不同
- **Runtime** = loop 与现实之间的**薄膜**。没 runtime → 很多东西活在 loop 之外（deploy 只在脑子里、logs 只在某终端、状态只在生产环境）。有 runtime → 这些能进入 loop。**Runtime 决定什么能进入 loop**

## 一句话

**Loop is everything. Runtime is the membrane. Knowledge is the flow.**

中文：**Loop 是一切。Runtime 是膜。Knowledge 是流。**

## Loop 是什么

```
Loop = Workspace dir + Chat history + Participants + Artifacts

- workspace dir: 代码、文件、md、ppt（filesystem-native）
- chat history:  timeline，自带时间序
- participants:  人 + AI bot（单人或多人）
- artifacts:     loop 产出的可验证产物
```

## 生命周期

| 状态 | 含义 |
|---|---|
| **Open** | 新建 dir，开始 chat |
| **Active** | 正在产生 / 推进 |
| **Forked** | 分叉成新 loop |
| **Closed** | runtime 验证 artifact 完成 |
| **Archived** | 归档；artifacts 沉淀为 knowledge |

## 折叠的旧概念

之前讨论里区分的几个东西，在 Loop 模型里都是同一物的不同面：

| 旧概念 | 在 Loop 模型里 |
|---|---|
| Entity（workspace dir） | Loop 的物理面 |
| Log（log.md） | Loop 的 chat history |
| Issue（公开 timeline） | 多人 loop |
| log vs issue | 同一东西，参与者多寡之别 |
| Knowledge | 已归档 loop 的 artifacts 沉淀 |

## 框架演化

| | v1 | v2 | v3（现）|
|---|---|---|---|
| 一阶概念 | Context（Knowledge + Thread）+ Runtime | Loop + Runtime | **Loop**（中心）|
| Knowledge 地位 | 一阶支柱 | Loop 归档析出 | **流经 loop 的流** |
| Runtime 地位 | 与 Context 平级 | 与 Loop 平级 | **服务于 loop 的薄膜** |
| Thread / Issue / Log / Chat | 各自分立 | 折叠进 Loop | 同 v2 |

## 用法示例

```
"我开一个 loop 来推 loopctl deploy"
"把无厚也 loop 进来"
"gateway 那个 loop 关掉了"
"fork 这个 loop 试另一条路"
"今天有 6 个 active loop"
"close the loop"  → runtime 验证 + artifact 落地
```

## 已确认细则（2026-05-04）

- **物理位置不强求**：chat history 跟 workspace dir 逻辑同源即可，物理可分（claude-code session 在 `~/.claude/` 里 OK）
- **思考型 loop 的 closure**：artifact + mtime 衰减，不需要 runtime 验证
- **Loop 不嵌套**：保持扁平，没有 sub-loop
- **Fork 不需要显式机制**：隐式（对话里 fork）够用，至少现在不需要

## 待解

1. **Chat 协议**：IRC？claude-code log？markdown？
2. **持久化**：append-only file？SQLite？
3. **INDEX**：50 个 loop 怎么扫一眼？
4. **协作怎么办**（当前焦点）：本地单人 + AI 已经 work，协作场景未解

## 当前焦点：协作

本地 loop 已经 work（dir + chat + artifact + AI 自然成立）。但协作场景未解：

- 多 workspace 怎么共享？
- chat 在私 chat / 公 channel 之间怎么分？
- AI 是每人自带还是 channel 共享？
- 投影到外部系统（tracker / IM / GitHub）？
- handoff / 邀请的形式？
