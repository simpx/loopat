# 多人 Loop 的 UI 选项

## 已确认（2026-05-04）

多人 Loop 的最佳形态 = **共享 channel + 一个 Claude bot**（用户 `~/workspace/im` 已是雏形）。

模型对了，UI 是另一个独立的轴。

## UI 选项空间

| | 方案 | 工作量 | 体验 |
|---|---|---|---|
| A | 换现代 IRC client（senpai / halloy / catgirl）| 几小时 | 好于 weechat，差于 Claude Code |
| B | 换协议：IRC → Matrix（Element 客户端，桥接现有 IRC）| 几天 | 接近 Slack/Discord，开源 |
| C | **自建 "Loop TUI" 对标 Claude Code** | ~一周（500-1500 行）| 完全可控，最贴 |
| D | 等 Anthropic 给 Claude Code 加 multi-participant | 不可控 | 理想 |

## C 的形态草稿

```
┌──────────────────────────────────────┐
│ #gateway-launch         active loop      │
├──────────────────────────────────────┤
│ <simpx> 看下 RDMA trace              │
│ <coo>   ✓ 已分析，问题在 mr_register │
│ <阿尔萨斯>  是 cuda alignment 问题       │
├──────────────────────────────────────┤
│ > _                                  │
└──────────────────────────────────────┘
```

特征：
- 侧栏 channel 列表（active loop 列表）
- Markdown / code block 渲染（像 Claude Code）
- @mention highlight
- bot 消息特殊样式
- artifact 引用展开
- terminal 体验对标 Claude Code

技术栈候选：Textual（Python）/ Bubble Tea（Go）/ Ratatui（Rust）

## 推荐路径

| 时间 | 做法 |
|---|---|
| 今天 | 打开 thelounge / weechat，跟 coo 在 `#general` 聊半小时，感受"我 + AI 在 channel"的体感 |
| 明天 | 拉同事进 channel，三人协作干小事，验证多人 + 一 AI 体感 |
| 体验对 → | 投入做 C（Loop TUI）|
| 体验不对 → | 回头改模型 |

## 关键原则

**UI 不应决定模型选型**。先用 ugly UI 跑通模型，验证形态对 → 再投入漂亮 UI。

模型对 + UI 丑 ≠ 模型错。
