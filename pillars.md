# 三支柱当前状态

## Knowledge

**方案**：git + docs（类似 `ccx/docs`）
**状态**：✅ 已定型，沿用现有做法

## Runtime

**方案**：把 `~/workspace/loopctl` 做完整，基于它可以完全做开发工作。

**目标**：Heroku 风格的开发反馈闭环 —— 让 AI 非常快地拿到 feedback：

- `loopctl deploy` → 代码里直接拿到一个 URL
- `loopctl terminal` → 直接拿到一个终端
- `loopctl logs` → 直接看 log
- ……

**状态**：🚧 进行中

参考思考：[Runtime as Context Shrinker](thoughts/runtime-as-context-shrinker.md)

## Thread

**方案**：暂无好的 all-in-one 方案
**状态**：❓ 开放问题 —— 三支柱里最大的缺口
