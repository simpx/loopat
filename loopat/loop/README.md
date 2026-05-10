# loopat / loop

1001 Phase 3 (0.1 单人版) 实现。Loop 页 MVP。

## 架构

- **server/** — Hono + ws + Claude Agent SDK，本机 `localhost:7787`
- **web/** — Vite + React + assistant-ui，`localhost:5173`，dev 时 ws 经 vite proxy 转 server
- **数据**：`~/.loopat/loops/<id>/`（filesystem-first，per-loop 一个目录）

## 起

```sh
bun install
export ANTHROPIC_API_KEY=sk-ant-...
bun run dev
```

打开 <http://localhost:5173>。

## v1 范围

- 创建 loop / 列出 loop
- 一个 loop 跟 Claude 来回对话
- 消息落 `~/.loopat/loops/<id>/.claude/projects/<hash>/<sid>.jsonl`

不做：attach、driver-transfer、context mount、富卡片右 panel、focus、chat tab、agent。
