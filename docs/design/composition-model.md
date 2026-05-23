---
title: loopat composition model
tags: [loopat, design, plugins, profiles, composition]
status: design doc · 2026-05 (post-experiment)
supersedes: implicit single-sandbox model in architecture.md
---

# loopat composition model

> **Loopat 是 CC 的组合层**：在 CC plugin 之上加一个 loopat-native 的 profile 概念，
> 负责跨 marketplace 编排、always-on context、个人凭据注入。
>
> 这份文档锚定 5 轮设计讨论 + 一次实测后的概念模型。
> 所有后续 loopat 设计决策对回这里。

---

## 0. Why this doc

加入 CC plugin / marketplace 生态 + 看了 Anthropic 的 vertical Claude（Claude for Legal）
之后，loopat 的边界开始模糊：

- 什么是 plugin、什么是 profile、什么是 knowledge
- 团队成员的"可复用 AI 能力"到底放哪
- loopat 是不是和 marketplace 在重复造轮子
- 300 人组织怎么避免 plugin/knowledge 爆炸

这份文档把答案写死。**实测过 CC plugin 行为**（2026-05，CC 2.1.148），后面有具体限制清单。

---

## 1. 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4:  Loopat profile（loopat 原生，活在 team repo）      │
│            "我们选这些 plugin + 这段 CLAUDE.md + 这堆 knowledge" │
├─────────────────────────────────────────────────────────────┤
│  Layer 3:  CC plugin（CC 原生，活在 marketplace）             │
│            "一个能力包：skill / command / MCP / hook / agent" │
├─────────────────────────────────────────────────────────────┤
│  Layer 2:  Claude Marketplace                                │
│            "plugin 的全球 / 团队 / 私有 分发目录"               │
├─────────────────────────────────────────────────────────────┤
│  Layer 1:  Claude Code engine                                │
└─────────────────────────────────────────────────────────────┘
```

熟悉的类比关系：

| Layer 4（组合） | Layer 3-2（包） | Layer 1（引擎） |
|---|---|---|
| **loopat profile** | **CC plugin / marketplace** | **CC engine** |
| `docker-compose.yml` | docker image / Hub | Docker |
| `package.json` | npm package / registry | Node.js |
| Helm chart | container image / OCI | Kubernetes |

**Profile 是 plugin 的客户**——它声明要哪些 plugin、附带哪些 CLAUDE.md/knowledge。Plugin 是 profile 的供应商——它提供 skill/MCP/agent。

> **"Claude for Legal" = Anthropic 卖的、行业层的 vertical bundle**。
> 自建 loopat = **团队层的 vertical bundle**。两者 shape 同，audience 异。

---

## 2. 为什么 profile 必须是 loopat-native，不能是 CC plugin

实测 CC plugin 有三个**硬限制**（CC 2.1.148，2026-05）：

| 限制 | 实测行为 | 对 loopat 的影响 |
|------|---------|-----------------|
| `dependencies` 不跨 marketplace 自动安装 | 同 marketplace deps auto-install ✓；跨 mp 只做 load-time 检查，不安装 | loopat 必须自己 orchestrate `claude plugin install` |
| Plugin root `CLAUDE.md` 不被加载 | `claude plugin validate` 显式 warn："use `skills/<name>/SKILL.md` instead" | always-on 团队姿态必须由 loopat 拼 |
| 没有 version lock 字段 | `dependencies` 是 array of strings，无 semver | 想可复现要 loopat 自己做 lock |

这三件事都需要在 CC plugin 之外解决。**Profile 这层就是来填这个 gap 的**。它不是更高级的 plugin，是不同性质的东西。

---

## 3. Profile 的形态

```
workspace/profiles/mode-oncall/
├── profile.json        ← 3 字段：name, description, plugins
├── CLAUDE.md           ← always-on（loopat concat）
└── knowledge/          ← optional（loopat mount）
```

`profile.json`：

```json
{
  "name": "mode-oncall",
  "description": "值班模式。假设你已加载某个 role-eng-* profile。",
  "plugins": [
    "acme-runbook-search@acme-internal",
    "frontend-design@claude-plugins-official"
  ]
}
```

**3 个字段，不多不少**：

| 字段 | 作用 |
|------|------|
| `name` | profile 标识，CLI 用 |
| `description` | 人类可读 |
| `plugins` | 要装的 CC plugin 列表（`name@marketplace` 形式） |

**没有 `extends`**：profile 互相独立，组合责任在用户的 `default_profiles` 列表。
Sub-role 通过列两个 profile 解决（`[role-eng-backend, role-eng-backend-infra]`），不引入隐式继承。

**没有内嵌 CLAUDE.md 引用**：约定 sibling 文件 `CLAUDE.md`，存在就 concat，不存在就跳过。

---

## 4. Personal config + CLI

```json
// personal/<user>/.loopat/config.json
{
  "default_profiles": ["role-eng-backend", "role-security"],
  "default_vault": "dev"
}
```

```bash
loopat run                                # base + default_profiles + personal
loopat run +mode-oncall                   # 临时加 oncall
loopat run +mode-oncall -role-security    # 加 oncall，去掉 security
loopat run --profiles=mode-incident       # 完全覆盖默认（应急）
loopat run +mode-oncall --dry-run         # 只展示决策，不动 sandbox
```

最终 sandbox = `base + (default_profiles ∪ CLI 加 − CLI 减) + personal` 的 union。

---

## 5. Loopat 管什么 / 不管什么

| 维度 | 团队 | 个人 |
|------|------|------|
| **Capability**（能做什么） | CC plugins（`workspace/plugins/` 是 local marketplace） | 罕见，可有 personal plugin |
| **Composition**（怎么组） | **loopat profile**（`workspace/profiles/`） | personal `config.json` |
| **Knowledge**（参考） | `workspace/knowledge/` + profile-内 knowledge | personal knowledge |
| **Memory**（记忆） | `workspace/notes/` | `personal/<u>/notes/` |
| **Secret**（凭据） | —（团队不共享） | `personal/<u>/vaults/` |

**Capability 行让位 CC plugin。Composition 行是 loopat 的核心增量**——profile 是 loopat 自己的 schema，对应 docker-compose.yml 在 docker 生态里的地位。

---

## 6. Docker compose 心智模型

| Docker | Loopat |
|---|---|
| docker image | CC plugin |
| Docker Hub / private registry | Claude marketplace / `workspace/plugins/` |
| **docker-compose.yml** | **loopat profile** |
| docker compose 的 `services:` 段 | profile.json 的 `plugins:` 段 |
| volume bind-mount | knowledge / notes / personal 挂进 sandbox |
| `docker compose up` | `loopat run +<profile>` |
| `.env` / local override | `personal/` 层 |

抓住两个映射：

- **profile = compose 文件**：声明组合的"配方"
- **plugin = 镜像**：无状态、可分发的能力包

---

## 7. Knowledge vs Capability：激活语义

|| Knowledge | Capability（Skill / MCP / Command / Hook） |
|---|---|---|
| 形态 | 普通 markdown | 注册到 CC plugin loader |
| 谁读 | AI 按需主动 read | CC 启动时注册、运行时自动激活 |
| 触发 | 不触发，只被引用 | 按意图/事件/用户输入 |
| 边界 | 无权限 | 有工具/MCP 权限范围 |
| 失效条件 | 没人 read → 静静躺着 | 没注册进 plugin path → 不存在 |

**关键反模式**：把 `SKILL.md` 直接放在 `knowledge/` 里。CC loader 不扫这里，它就是死 markdown。

同一段"部署流程"的三种形态：

| 形态 | 触发 | 何时用 |
|------|------|--------|
| `knowledge/deploy.md` 散文 | AI 按需 read | 流程还在变 / 仅作参考 |
| plugin 里的 `skills/deploy/SKILL.md` | CC auto-trigger | 流程稳定 + 想自动唤起 |
| plugin 里的 `commands/deploy.md` | 用户 `/deploy` | 用户想显式调用 |
| **profile 的 `CLAUDE.md`** | always-on（loopat concat） | 团队工作姿态 |

---

## 8. Loop sandbox 物化流程

```
loopat run +mode-oncall
   │
   ├─ Step 1: 读 personal/<user>/.loopat/config.json
   ├─ Step 2: 计算 active profiles = base ∪ default_profiles ∪ +CLI − -CLI
   ├─ Step 3: union 每个 profile 的 `plugins` 列表（dedup）
   ├─ Step 4: orchestrate `claude plugin install` 把所有 plugin 装齐
   │           （跨 marketplace 在这步搞定，CC 自己不会跨装）
   ├─ Step 5: concat 每个 profile 目录的 CLAUDE.md → sandbox 根 CLAUDE.md
   ├─ Step 6: mount 每个 profile 的 knowledge/ + workspace/knowledge/ → sandbox knowledge/
   ├─ Step 7: 读 personal/<u>/vaults/<v>/* 导成 env vars
   └─ Step 8: 启动 CC
```

**Loopat 在中间做胶水**，CC 看到的是一个已经配好的环境。

---

## 9. 300-person 规模

```
loopat-acme/                          ← 一个 monorepo
├── profiles/
│   ├── base/                         ← 全员必加
│   ├── role-eng-backend/
│   ├── role-eng-frontend/
│   ├── role-eng-ml/
│   ├── role-legal/
│   ├── role-pm/
│   ├── role-security/
│   ├── mode-oncall/
│   ├── mode-review/
│   ├── mode-incident/
│   └── mode-planning/
├── plugins/                          ← CC local marketplace
│   ├── .claude-plugin/marketplace.json
│   ├── internal-mcp/
│   ├── pagerduty-mcp/
│   ├── deploy-cli/
│   └── ...
├── knowledge/                        ← workspace 全局
├── notes/                            ← workspace 全局记忆
└── CODEOWNERS
```

### 维护权切分（典型）

```
/profiles/base/                @platform-team
/profiles/role-eng-*/          @eng-leads
/profiles/role-legal/          @legal-leads
/profiles/mode-oncall/         @sre-team
/plugins/<name>/               @<plugin-author>
```

10 个 profile owner 维护 ~80 条 profile→plugin 依赖边——稀疏图，标准包管理工作量。

### 何时拆 repo（monorepo → multi-repo）

| 触发 | 怎么拆 |
|------|--------|
| 某 profile/plugin **不能让其他 group 看到**（合规） | 拆独立 repo，loopat 用 git URL / OCI ref |
| 某模块 **发布节奏完全错位**（legal 一年 vs eng 一天） | 拆独立 repo，独立 release cycle |
| 单 repo > 1 GB / > 30 plugin / clone 慢 | 物理性能问题 |

**默认 monorepo + CODEOWNERS**。300 人 monorepo 完全跑得动。

---

## 10. Skill 的 graduation path

```
阶段 1: knowledge/howto-X.md           ← AI 按需 read
        ↓（流程稳定 + 多人用）
阶段 2: plugins/<name>/skills/X/       ← CC 注册为 skill，按意图自动触发
        ↓（跨团队复用 / 体积大）
阶段 3: 独立 plugin repo，profile 通过 deps 引用
```

**规则**：**"≥2 人用 + 稳定 ≥2 周" → 升级成 plugin**。早期 skill 留在 knowledge/ 不丢人——这是 graduation gate，不是反模式。

---

## 11. CC plugin 实测情况（2026-05 验证）

| 特性 | 状态 | 备注 |
|------|------|------|
| `plugin.json` 的 `dependencies` | ✅ 工作 | **array of strings**（不是 object），无 version constraint |
| Same-marketplace deps auto-install | ✅ | 装 meta-plugin 自动拉 deps |
| Cross-marketplace deps auto-install | ❌ | 只 load-time 检查，**loopat 必须 orchestrate** |
| Plugin root `CLAUDE.md` | ❌ | **不被加载**，validate 会 warn |
| `type: "library"` 标记 | ❌ | 未实现（Issue #9444） |
| Version pinning in deps | ❌ | 未支持 |
| MCP servers 自动注册 | ✅ | 命名 `plugin:<name>:<marketplace>` |
| `claude plugin prune` | ✅ | 自动清理无用 deps |
| `claude plugin validate` | ✅ | 可用做 CI 校验 |
| 跨 marketplace dep 语法 | ✅ | `name@marketplace` 形式 |

---

## 12. 与现有 architecture.md 的关系

现有 `architecture.md` 描述的 **sandbox × vault** 二维矩阵：

| Axis | What it picks | Owner |
|---|---|---|
| **Sandbox** | the tools the loop can use（**单一**命名 bundle） | team |
| **Vault** | the credentials | personal |

本文档对这层抽象的**破坏性演化**：

- **sandbox 从"单一命名 bundle"扩展到"profile 的 union"**——破坏性替换 `extends` 单父链
- 把 sandbox 的内容拆成 profile（loopat 原生）+ plugin（CC 原生）两层
- vault 保持不变（personal credential 子集）
- `compose.ts` 的 tier 机制保留思路，tier 从 2 扩到 N

**没有否定 sandbox/vault 概念**——sandbox 还是 lifecycle envelope（per-loop 隔离），vault 还是 personal credential。变化只在"sandbox 里装什么"从"一个名字"变成"profile 集合的 union"。

---

## 13. Anti-patterns（明确禁止）

1. **不要发明 "loopat plugin format"**——直接用 CC plugin 格式
2. **不要在 loopat 里造 "agent" 概念**——CC 已有 subagent，会撞名
3. **不要把 SKILL.md / MCP 配置塞进 `knowledge/`**——category error，CC 不扫这里
4. **不要在 profile 里加 `extends` 或继承**——让用户在 `default_profiles` 显式列；sub-role 列两个 profile
5. **不要用 plugin root 的 `CLAUDE.md` 传播姿态**——CC 不加载，必须靠 profile CLAUDE.md
6. **不要让 plugin 知道自己在哪些 profile 里**——耦合反转
7. **不要预先建独立 team-marketplace repo**——`workspace/plugins/` 子目录起步
8. **不要预先设计 loopat.yml schema 扩字段**——3 字段 + sibling 文件够用；要扩之前先验证刚需

---

## 14. Open questions（待定）

| 问题 | 当前倾向 | 决定时机 |
|------|----------|----------|
| Profile 引用不存在的 plugin 怎么办？ | 物化前 dry-validate；报错 | 实现 resolver 时 |
| 要不要 `plugins.lock` 锁 plugin sha？ | 短期不做，跟 marketplace upstream；长期加 | 撞到可复现性问题时 |
| Vault env 怎么注入到 CC 进程？ | 物化时把 `vaults/<v>/*` 读出来 export 进 CC env | 集成实现时 |
| 多 loop 同时跑，CC marketplace 是全局态怎么办？ | 短期：accept；长期：每 loop 独立 `~/.claude` | 多 loop 并发出问题时 |
| 用户列了同名但跨 mp plugin 冲突？ | 报错，让用户用 `name@mp` 显式 | resolver 里实现 |
| MCP OAuth token 跨 loop 共享？ | symlink 进 sandbox，撞 atomic-write 问题再换 | MCP OAuth 落盘时 |

---

## 15. 一句话总结

> **CC plugin** 是能力单元（住 marketplace），**loopat profile** 是组合单元（住 team repo）。
>
> Profile 用 `name@marketplace` 列依赖；loopat 物化 sandbox 时 orchestrate 跨 marketplace 安装、concat CLAUDE.md、mount knowledge、注入凭据。
>
> Profile 平铺独立，无继承；用户在 `default_profiles` 列自己要的，CLI 用 `+/-` 临时增减。
>
> 不发明新概念，只在 CC 原生格式撑不起的地方补一层薄 schema（profile.json 三字段）。
