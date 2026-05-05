# 协作的本质：共享 loop，不共享进展

## 核心原则（2026-05-04）

> **协作的目的是协作 loop，不是协作进展。**
>
> **进展是给人看的，context 才是给 AI 看的。**

## AI 时代的协作转变

| | Pre-AI | Post-AI |
|---|---|---|
| 协作单位 | 进展 / 状态 / 报告 | **完整的 loop（context）** |
| 为什么 | 人受不了原始 context 的量 | AI 能吃完整 context |
| 后果 | 大量人力做摘要、汇报、同步 | 直接共享 SoT，view 由 AI 按需生成 |

tracker / IM doc / 周报 都是协作 **view**，不是协作 **loop**。它们衔接的是给人看的进展，**丢了 AI 能用的 context**。

## 这把"view 不是 SoT"原则推到协作维度

之前在 thread 模型里说 view 不是 SoT。今天这条把它推到协作：

- **协作的 SoT** = loop（dir + chat + artifacts）
- **协作的 view** = tracker / IM / 周报（给特定受众的进展投影）
- **AI 让 view 可以按需生成**，不必预先做

人 + tracker 的协作，等于在做"AI 不需要、人需要"的工作。低杠杆。

## 对两个痛点的重新设计

### 痛点 a：个人 loop 投到团队可见

- ❌ 老：把 loop 状态投影成 tracker / IM doc 给团队看（投进展，丢 context）
- ✅ 新：让 team 直接 read 我的 loop（dir + chat），需要时 AI 给 team 按需生成进展 view

### 痛点 b：两人协作一件事

- ❌ 老：IM 太轻 / tracker 太重，找一个"中间形态"
- ✅ 新：开一个**两人共享的 loop** —— 共享 dir + 共享 chat channel + 各自 AI

形态上就是把 IRC bot 那套（per-channel workspace + channel log + bot 进 channel）**普遍化到任何两人 / 多人协作**。

## 待解的具体形态问题

1. **Loop 共享的物理形式**：git remote？共享 fs？同机 share dir？
2. **Chat 共享**：全部走 IRC？还是有的 loop 走 git commit log？混合？
3. **AI 进共享 loop**：每人自带 AI（cd 共享 dir）/ channel 共享 AI / 混合？
4. **Read-only vs writable** 边界：团队 read = git fetch 我的 dir？
5. **跟 tracker 的衔接**：tracker 作 closure 信号 + view，**不再复制 context**

## 推论

- tracker 不是协作工具，是**外部任务跟踪工具 + 团队 view 渲染面**
- 真正的协作工具应该是**让 loop 可分享 / 可加入 / 可观察**的
- 这种工具几乎不存在 —— 是 1001 要建的
