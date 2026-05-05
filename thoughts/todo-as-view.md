# TODO 在 Loop 模型里：是 view，不是一阶概念

## 旧问题

`ccx/notes/todo.md` 弃用，深层原因不只是"必经之路上没它"（runtime 闭环角度），还有：

**它想同时当 SoT 和 view**，结果两者都做不好：
- 任务条目（SoT）和扫一眼视图（view）混在一个文件
- 多人加进来就 desync
- 无法多视图

## Loop 模型自动消解

| 旧 | 新（Loop 模型）|
|---|---|
| todo.md 一文承载所有 | SoT / view 分开 |
| SoT 在 view 里 | SoT 在 loop 的 chat / notes |
| view 也在 view 里 | view 是跨 loop 的 query |

类似 **Obsidian Tasks** 的工程化范式：`- [ ]` 散落在所有 `.md`，跨文件 query 拉出列表。这套机制在 Loop 模型上完全成立。

## 两个尺度

| 尺度 | 位置 | 例 |
|---|---|---|
| 单 loop 内 | loop 自己的 chat / notes / THREAD.md | "等无厚回消息后改 RDMA 注册" |
| 跨 loop（meta）| 一个 view（query 渲染） | "今天 6 个 active loop，先推哪 2 个" |

## 太小、不值一个 loop 的事

有些事太小不值整个 loop（"找时间和无厚聊"、"明天提醒自己看下 X"）。

它们也活在某个 loop 的 chat 里，只是不专门为它开 loop：

- **默认 / inbox loop**：personal daily 类，零散事都丢这
- **self chat**：长期"自己跟自己聊"的 loop

形式上跟其他 loop 一样是个 dir，只是产物是清单 / 反思 / 计划而不是代码。

## todo doc 的角色

不消失，但永远是 **view**：

- 每天扫一眼 → 跨 loop query 当天该做的
- 周报 / 汇报 → 跨 loop query 本周变更
- 老板看的进度 → 跨 loop query 状态 / 优先级

view 是临时、可重建、可定制的。**SoT 永远在 loop 内**。

## "todo 问题"实际是什么

- ❌ 不是"再造一个 todo 系统"
- ✅ 是 **loop 的 INDEX / view 怎么实现**（之前留的 6 个开放问题里的第 5 个）

退化到 query 协议 + view 渲染机制 —— 是 Loop 实操层的问题，不是模型层的开放问题。
