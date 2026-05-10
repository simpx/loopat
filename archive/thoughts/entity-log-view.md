# Thread 数据模型：Entity / Log / View

## 三层

| 层 | 是什么 | 当前承载 | SoT? |
|---|---|---|---|
| **Entity（实体）** | 一件事的本体 —— 代码、文件、context | `~/workspace/<name>/` | ✅ |
| **Log（事件）** | raw 上下文、发生了什么 | `<dir>/log.md`（暂定） | ✅ |
| **View（视图）** | 上面两层的投影 | todo doc / IM / tracker / 汇报 / ... | ❌（消耗品） |

## 关键洞察 1：View 不应该是 SoT

之前 `ccx/notes/todo.md` 失败的原因正是把 log 写进了 INDEX —— 让视图扛了 SoT 的责任。一旦如此：

- 没法多视图（个人 ≠ 团队 ≠ 汇报）
- 没法多人协作（IM doc 没人同步回 todo.md）
- 同一件事在多处重写 → desync

View 是**消耗品**：可抛弃、可重建、可定制。

## 关键洞察 2：汇报也是 View，不是 Log

更进一步：**有的"log"其实是"汇报"**，也属于 View 范畴。

| | 真 Log | 汇报 |
|---|---|---|
| 受众 | 自己 / 接力的 AI | 老板 / 团队 / 客户 |
| 形式 | 原始、带上下文、append-only | 精炼、结构化、阶段性 |
| 性质 | SoT | View |
| 例子 | "11:33 跑 v6d connector 失败，trace 见 X" | "本周修 bug N，进度 60%" |

tracker 工单更新、IM 进度、周报、todo doc —— 全是 View。

## Log 的 SoT：workspace dir 内（暂定）

决定：log 跟实体走，存 `<dir>/log.md`。

理由：
- 跟实体一起 handoff —— 把目录交出去，log 自带
- AI cd 进 dir 立即看到完整上下文
- filesystem-native，无外部依赖

代价：跨人协作不天然，需要靠 View 投影出去。

## "all-in-one" 的真实形态：SoT 一份，View 任意多个

```
                           ┌─→ todo doc (个人扫一眼)
~/workspace/<name>/        ├─→ IM 文档 (团队同步)
├── log.md  ← Log SoT  ────┼─→ tracker 工单更新 (formal record)
└── (代码/文件)            ├─→ 周报 (老板汇报)
                           └─→ AI handoff context
```

**不再"同步"，只"投影"**。

投影的执行者：人工 / AI 自动 / CLI 工具 —— 都可以，是 runtime 层的问题。

## 待讨论

1. **log.md 的格式**：完全自由？还是有最小约定（时间戳前缀？分段？）
2. **投影的执行者**：AI 自动从 log 生成汇报？还是人工，AI 辅助？
3. **跨 dir 的 INDEX**：50 个 workspace dir，怎么"扫一眼所有 thread"？这是原"扩展"问题的回归 —— 但 log 不在 INDEX 里之后，INDEX 该长什么样？
4. **团队 thread**：实体不在我本地的情况怎么处理？（比如别人在主导一件事）
