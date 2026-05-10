# 协作架构（最终）：loop-tui = 富文本 IRC 客户端

## 决定（2026-05-04，多次迭代后收敛）

**Claude Code 不动**。loop-tui 是一个**纯 IRC 客户端**（带富文本渲染），AI 在 channel 的方式 = bot（用 Claude API，跟 coo 一样）。

## 架构

```
你 host A:  Claude Code（不改）   ← 你的私 AI（单人）
            +
            loop-tui              ← IRC 客户端，进 channel 聊
            
阿尔萨斯 host B: loop-tui              ← IRC 客户端
泰兰德 host C: loop-tui              ← IRC 客户端

服务器:     ergo（IRC server）
            coo bot               ← AI 在 channel 的方式（Claude API）
```

## 关键定位

| 组件 | 角色 | 改造 |
|---|---|---|
| Claude Code | 单人 + 个人 AI 助手 | **不改** |
| **loop-tui** | IRC 客户端 + 富文本渲染 | **从 claw-code fork，剥离 Anthropic API** |
| coo bot | AI 在 channel | 已有 |
| ergo | IRC server | 已有 |

## 为什么这样设计

1. **Claude Code 本来就好用** —— 不要尝试改它的角色
2. **claw-code 的价值在 TUI**（markdown / code block / syntect 高亮）—— 普通 IRC client 不够富文本
3. **AI 在 channel ≠ AI 嵌在客户端** —— bot 模式更解耦、更去中心化
4. **channel 不必总有 AI** —— 纯人 IM 也是合法 loop

## 三个设计点确认

1. **没人带 AI 的 channel** —— OK，就是 IM。AI 是增强不是必需
2. **Claude 读全不一定回** —— 标准 bot 行为（coo 现状）
3. **Claude 自己管 context** —— channel 只 feed message stream，Claude 自己决定 summarize / 保留 / 取舍

## loop-tui 实施路线（基于 claw-code）

| 步骤 | 改动 | 估算 |
|---|---|---|
| 1 | Fork claw → `~/workspace/loop-tui`，build 通过 | 半天 |
| 2 | 删除 Anthropic API 集成（剥离 api crate）| 半天 |
| 3 | 加 `irc` crate（连 ergo + 收发）| 1 天 |
| 4 | REPL loop 改：从"和 Claude 聊"→"和 channel 聊" | 1 天 |
| 5 | 多 speaker 渲染（保留 markdown / code 高亮） | 半天 |
| 6 | Slash commands：`/join` `/leave` `/nick` `/list` | 半天 |
| 7 | 联调：你 + 我 + coo 在同 channel | 半天 |

**~4 天到 demo**。比之前估算简单（不用维护多 Claude 协调逻辑）。

## 副产品

loop-tui 解耦后是个干净 chat client：

- 可以集成公司内 LLM
- 可以接 OpenAI / Gemini / 本地模型作为 channel bot
- 跨端（手机 web 用 thelounge 桥接）
- 跟 Claude Code 完全解耦

## 思想演化（journey）

之前的几次架构迭代（仅作历史）：

1. **chat.log + git**：异步协作 → 不够，多人实时不行
2. **改 Claude Code 加 IRC**：技术不可行（闭源）
3. **改 claw-code 让 Claude Code 多人化**：过度设计，每人多 Claude 复杂
4. **现在**：claw-code → loop-tui（纯 IRC 客户端），Claude Code 不动，AI 走 bot

每次迭代都让设计更解耦、更简单。
