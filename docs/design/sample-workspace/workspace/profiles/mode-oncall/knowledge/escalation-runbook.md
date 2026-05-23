# Oncall Escalation Runbook

## Step 1 · 第一响应（5 分钟内）

- ack incident（用 `pagerduty-mcp.ack`）
- 看 dashboard：`grafana.acme.internal/d/oncall-overview`
- 如果错误率 < 1% 且没扩大趋势：进入排查
- 如果错误率 > 5% 或在扩大：立刻升级到 step 2

## Step 2 · 升级（15 分钟内未稳）

- @ SRE lead，描述：服务名、症状、已尝试的步骤
- 启动 incident channel（命名 `incident-<service>-<date>`）
- 如果是 customer-facing：通知 support team

## 常见 symptom → action 映射

| Symptom | 第一动作 |
|---------|----------|
| API latency 突增 | 看 db connection pool；rolling restart 相关服务 |
| 5xx 突增 | 看最近 deploy；考虑 rollback |
| 队列堆积 | 查 worker pod 数量；扩容 |
