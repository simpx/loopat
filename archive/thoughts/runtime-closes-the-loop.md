# Runtime 闭环：让 closure 成为做事的副产品

## 核心洞察

> **工具能不能存活，看它是不是在工作的"必经之路"上。**

GitHub issue 不死的根本原因：
- 代码的必经之路 = PR 合入
- 合入 = 天然的关单事件
- **绕不开**

todo.md / 普通 issue tracker 死的原因：
- 必经之路上没它
- 关单是**额外动作**
- 能省就省 → 信任崩塌 → 没人用

todo.md 当年弃用的真正原因，到这里才完整：不是因为不能扩展，而是因为没有闭环。

## 设计原则

> **Thread closure 必须是"做事的副产品"，不是单独的动作。**

决定一个 thread 该不该用 issue/timeline 跟踪，看的是 **runtime 能不能给它 close 信号**。

## GitHub 的好处是闭环 —— 我们需要用 runtime 做闭环

| 类型 | 必经之路 | closure 信号 |
|---|---|---|
| 代码改动 | PR 合入 | merge event |
| 上线/部署 | `loopctl deploy` 成功 | `loopctl status xxx` 上看到 → 触发 close |
| 文档/调研 | ?（开放） | mtime 衰减 + AI 巡检？ |
| 纯探索 | 没必经之路 | 不开 issue，靠 mtime |

具体例子：

> **上线一个 xxx，如果有 issue，那么 auto-close 的标准就是 `loopctl` 上看到 xxx。**

也就是说，issue 不是手动关，而是 runtime 验证后自动关。

## 推论

1. **不是所有 thread 都该用 issue/timeline 跟踪**。runtime 上没钩子的，issue 必腐烂。让它在 workspace dir 里靠 mtime 自然衰减就好。强求开 issue = 制造 dead issue = 系统污染源。

2. **loopctl 不只是 deploy/operate**，更是 **closure signal 的发射源**。runtime 的设计要把 "acceptance" 作为 first-class 行为：每个动作完成后都能 emit "什么被验证了"的事件。

3. **这强化了"runtime 同等重要"的判断** —— 没有 runtime 闭环，整个 thread 系统会自我崩塌。

## 待挖

- runtime → issue 的 closure 事件协议长什么样？需要标准化吗？
- 没必经之路的 thread（探索、调研）怎么处理？接受不关单？还是搞个 AI 巡检员定期 review？
- 如何避免"为了 close 而 close"的伪闭环（比如随便 deploy 一下凑数）？
