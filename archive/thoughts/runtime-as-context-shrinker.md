# Runtime as Context Shrinker

## 心路历程

- 以前觉得 knowledge 是一切 —— 所有东西塞进 docs 就好
- 最近觉得 runtime 也很重要，甚至在某些场景比 knowledge 更关键

## 触发：loopctl

以前 `ccx/docs/` 里放了很多 runtime、loopey 的知识。

最近实现的 `~/workspace/loopctl` —— 一个完整 kubectl 风格的 CLI —— 把这堆复杂知识**收敛**到了一起。

相当于做了一次 **shrink context**：

- **以前**：AI 要理解很多东西才能干活
- **现在**：`loopctl -h` 就可以自行探索

## 为什么有效

loopctl 刻意采用 kubectl 的概念体系和命名约定：

- 复用通用心智（resource / verb / scope / namespace…），几乎不引入新概念
- 极小的 context footprint 就能完成工作
- 不再需要 AI 自由阅读 doc、每次临时组装一堆功能

## 提炼

**好的 runtime 不只是"让事情发生"，还是 knowledge 的压缩**：把分散在 docs 里的概念、最佳实践、操作流程，编码进 CLI 的命令结构、子命令、flag 和 help 文本里。AI 按需取用，不必预加载全部。

约定 + 自描述（-h） = 极低 context footprint。
