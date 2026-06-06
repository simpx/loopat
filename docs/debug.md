# Debugging

## Tracing (OTel)

Server 内置了 OpenTelemetry tracing，用于定位 loop 创建和启动的性能瓶颈。默认关闭，零开销。

### 快速验证

```bash
OTEL_TRACES_EXPORTER=console bun run dev:server
```

每个 span 结束时会往 stdout 打一条 JSON，包含 `name`、`duration`（微秒）、`status` 等。创建一个 loop 就能看到输出。

### 接 Jaeger

```bash
# 启动 Jaeger（all-in-one，UI 在 16686）
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# 启动 server
OTEL_TRACES_EXPORTER=otlp bun run dev:server
```

打开 `http://localhost:16686`，Service 选 `loopat-server`，能看到完整的 trace 瀑布图。

`OTEL_EXPORTER_OTLP_ENDPOINT` 默认是 `http://localhost:4318/v1/traces`，如果 Jaeger 在别的地址可以覆盖。

### 已埋点的 span

**`createLoop`**（loops.ts）— loop 创建全流程：

| span | 做什么 | 常见瓶颈 |
|------|--------|----------|
| `composeClaudeConfig` | 合并 skills/agents/profiles 到 `.claude/` | 很少慢 |
| `ensureUserContext` | 拉用户的 knowledge/notes repo | 首次 clone 慢 |
| `ensureRepoMirror` | bare mirror clone + git worktree add | 大 repo 首次 clone |
| `ensureContextMounts` | 挂载 context 目录到 loop | 很少慢 |

**`ensureStarted`**（session.ts）— SDK session 启动：

| span | 做什么 | 常见瓶颈 |
|------|--------|----------|
| `resolveProvider` | 找到有效的 API key + provider 配置 | 很少慢 |
| `ensurePlugins` | 安装 marketplace 插件 | 插件多时偏慢 |
| `ensureContainer` | 拉起 podman 容器 | 首次 build 镜像时最慢 |

### 关闭

不设 `OTEL_TRACES_EXPORTER`，或设为 `none`。不会加载任何 exporter，noop tracer 的开销可忽略。
