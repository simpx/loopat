# Acme Backend Architecture

> 后端核心服务的拓扑。AI 按需 read。

```
[Client] → [API Gateway] → [Auth Service]
                        → [Product Service] ← [Postgres]
                        → [Order Service]   ← [Postgres]
                                            → [Redis cache]
                        → [Notification]    → [Kafka] → [worker pool]
```

## 服务清单

| 服务 | 仓库 | 语言 | Owner |
|------|------|------|-------|
| api-gateway | `acme/api-gateway` | Go | @api-team |
| auth-service | `acme/auth` | Go | @platform |
| product-service | `acme/product` | Go | @product-eng |
| order-service | `acme/order` | Go | @order-team |
| notification | `acme/notify` | Java | @notify-team |

## 数据库连接

不要在代码里 hard-code DSN。从 `personal/<user>/vaults/db/` 注入。
