# Role · Backend Engineer

> 加载时机：用户的 `default_profiles` 包含 `role-eng-backend`。

## 后端工程师常用工具

- `internal-mcp`：内部服务 API 查询
- `deploy-cli`：发布工具（dev/staging/prod 三档）
- `db-tools`：数据库只读探查（不允许写）

## 约定

- 写新接口前先 grep 看现有 RPC 命名风格
- 数据库 schema 变更必须先在 staging 跑一遍 migration dry-run
- 性能敏感路径 (`hot-path/`) 的改动需要带 benchmark 数字
