# Example composition

> 演示：alice（后端 + security）今天值班，执行 `loopat run +mode-oncall` 时，
> loopat 怎么 orchestrate plugin 安装、CLAUDE.md concat、sandbox 物化。
>
> 这是把 profile / plugin / personal 三个抽象串成具体形态的关键文档。
> 模型已经在 `/tmp/loopat-profile-mvp/` 实测跑通（resolver ~80 行 Node 脚本）。

---

## 1. 起点：alice 的配置

`personal/alice/.loopat/config.json`：

```json
{
  "default_profiles": ["role-eng-backend", "role-security"],
  "default_vault": "dev"
}
```

她今天值班，临时叠加：

```bash
$ loopat run +mode-oncall
```

---

## 2. Loopat 计算"激活集合"

```
   active_profiles = "base" ∪ default_profiles ∪ cli_added − cli_removed
                   = { base, role-eng-backend, role-security, mode-oncall }

   active_plugins  = ⋃ (profile.plugins for each active profile)
                   = ⋃ (
                       base.plugins:             []
                       role-eng-backend.plugins: [ internal-mcp@acme-internal ]
                       role-security.plugins:    []
                       mode-oncall.plugins:      [ pagerduty-mcp@acme-internal ]
                     )
                   = { internal-mcp@acme-internal, pagerduty-mcp@acme-internal }
```

**没有 extends**——profile 平铺独立。Alice 需要 backend 工具是因为她**自己**在 `default_profiles` 列了 `role-eng-backend`，不是 mode-oncall 偷偷拉的。

排除的（**不进**这个 loop）：

- `role-eng-frontend`、`role-pm`、`role-legal`（alice 不在）
- `mode-review`、`mode-incident`（她没 CLI 加）
- 别的同事的 personal/*

---

## 3. Loopat 物化 sandbox

```
loopat run +mode-oncall
   │
   ├─ Step 1: 读 personal/alice/.loopat/config.json
   ├─ Step 2: union 4 个 profile 的 plugins → 2 个 unique plugin
   ├─ Step 3: 调 `claude plugin install` orchestrate ──┐
   │           （跨 marketplace 在这步搞定，CC 自己不会跨装）
   │           - claude plugin install internal-mcp@acme-internal
   │           - claude plugin install pagerduty-mcp@acme-internal
   ├─ Step 4: concat 4 个 profile + personal 的 CLAUDE.md → sandbox/CLAUDE.md
   ├─ Step 5: mount profile 内 knowledge/ + workspace 全局 knowledge/ → sandbox/knowledge/
   ├─ Step 6: 读 personal/alice/vaults/dev/* 导成 env vars
   └─ Step 7: 启动 CC（CC 看到一个已经配好的环境）
```

---

## 4. 物化后的 sandbox 长什么样

```
loops/2026-05-23-001/
│
├── CLAUDE.md                  ← 5 段 concat 出来的
│
├── .claude/                   ← CC 看到的 ~/.claude（loopat 已经 install 完 plugin）
│   ├── installed_plugins.json    ← internal-mcp + pagerduty-mcp + 全局已装的
│   └── plugins/cache/...
│
├── knowledge/                 ← bind-mount 多个源
│   ├── company-handbook.md       (← workspace/knowledge/)
│   ├── architecture.md           (← profile/role-eng-backend/knowledge/)
│   └── escalation-runbook.md     (← profile/mode-oncall/knowledge/)
│
├── notes/                     ← per-loop git worktree（可写）
│
└── workdir/                   ← alice 干活的项目目录（bind-mount）
```

---

## 5. CLAUDE.md 怎么 concat 出来

顺序：靠后优先级高。Personal 在最后。

```markdown
<!-- ========== base ========== -->
<!-- from: workspace/profiles/base/CLAUDE.md -->
# Acme Corp · Engineering baseline
...全员基线...

<!-- ========== role-eng-backend ========== -->
<!-- from: workspace/profiles/role-eng-backend/CLAUDE.md -->
# Role · Backend Engineer
...后端约定...

<!-- ========== role-security ========== -->
<!-- from: workspace/profiles/role-security/CLAUDE.md -->
# Role · Security Engineer
...安全工作姿态...

<!-- ========== mode-oncall ========== -->
<!-- from: workspace/profiles/mode-oncall/CLAUDE.md -->
# Mode · Oncall
...你正在值班...

<!-- ========== personal:alice ========== -->
<!-- from: personal/alice/CLAUDE.md -->
# Alice · personal CLAUDE.md
...个人偏好...
```

CC 启动时看到的 `CLAUDE.md` 就是这一份 concat 文件。

---

## 6. 几个常见操作

```bash
# 平时
$ loopat run
[loopat] active profiles: base, role-eng-backend, role-security
[loopat] plugins: 1 (internal-mcp@acme-internal)
[loopat] CLAUDE.md: 4 sections, vault=alice/dev

# 今天值班
$ loopat run +mode-oncall
[loopat] active profiles: base, role-eng-backend, role-security, mode-oncall
[loopat] plugins: 2 (+ pagerduty-mcp@acme-internal)
[loopat] CLAUDE.md: 5 sections, vault=alice/dev

# 临时 review PR
$ loopat run +mode-review -role-security
[loopat] active profiles: base, role-eng-backend, mode-review
[loopat] plugins: 1 (internal-mcp@acme-internal)
[loopat] CLAUDE.md: 4 sections, vault=alice/dev

# 应急覆盖
$ loopat run --profiles=mode-incident
[loopat] active profiles: base, mode-incident
[loopat] plugins: ?
[loopat] CLAUDE.md: 2 sections, vault=alice/dev

# dry-run（不动 sandbox，纯展示决策）
$ loopat run +mode-oncall --dry-run
```

---

## 7. CC 视角对比（同 workspace 不同人）

| | alice oncall loop | bob frontend loop | carol legal loop |
|---|---|---|---|
| **active profiles** | base + role-eng-backend + role-security + mode-oncall | base + role-eng-frontend | base + role-legal |
| **plugins (union)** | 2 | ~1 | ~1 |
| **CLAUDE.md 段数** | 5 | 3 | 3 |
| **vault** | alice/dev | bob/dev | carol/work |

**同一个 workspace，不同 user 在不同 profile 选择下看到不同环境**——这就是 isolation。

---

## 8. 关键不变量

- **profile 平铺独立**：profile A 不知道 profile B 的存在，无继承
- **plugin dedup**：同 plugin 被多 profile 引用，物化时 union dedup
- **base 永远加**：不能用 `--profiles=` 排除
- **personal 在最后**：覆盖能力最强
- **没选的 profile 完全不进 sandbox**：CC 看不到 = 0 context cost
- **每次起 loop 重新物化**：手改 `.claude/` 不持久，要改去改源 profile / plugin
- **跨 marketplace dep 由 loopat 兜底**：CC 自己不会跨装，loopat orchestrate

---

## 看完这个，回头读

- [`../composition-model.md`](../composition-model.md) — 完整概念模型
- [`./README.md`](./README.md) — sample 导览
