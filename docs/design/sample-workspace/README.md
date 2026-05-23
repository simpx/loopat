# Sample loopat workspace

> 这是 [composition-model.md](../composition-model.md) 描述的形态的**具体样例**。
> 一个虚构公司 "acme" 的 loopat workspace 长什么样。
>
> 文件内容是简化的占位，**重点看目录结构、profile.json 和 plugin 的关系**。

---

## 顶层布局

```
sample-workspace/
├── workspace/                         ← 团队 git 仓库（一个 loopat workspace）
│   ├── profiles/                      ← loopat 原生：composition 单元
│   │   ├── base/                      ← 全员必加 profile
│   │   ├── role-*/                    ← 持久身份（你的角色）
│   │   └── mode-*/                    ← 临时模式（你的任务）
│   ├── plugins/                       ← CC 原生：local marketplace
│   │   ├── .claude-plugin/marketplace.json   ← marketplace 入口
│   │   └── <plugin-name>/.claude-plugin/plugin.json
│   ├── knowledge/                     ← workspace 全局参考
│   ├── notes/                         ← workspace 全局记忆
│   └── CODEOWNERS
│
├── personal/alice/                    ← 一个 user 的 personal 目录
│   ├── .loopat/config.json            ← default_profiles 在这里
│   ├── vaults/                        ← 个人凭据
│   ├── CLAUDE.md                      ← 个人姿态（concat 在最后）
│   └── notes/memory/                  ← 个人记忆
│
└── EXAMPLE-COMPOSITION.md             ← alice 跑 `+mode-oncall` 时 sandbox 怎么物化
```

---

## 关键概念 1:1 对照

| 概念 | 在 sample 里看哪里 |
|------|--------------------|
| **profile = loopat 原生 composition 单元** | `workspace/profiles/<name>/profile.json` + sibling `CLAUDE.md` |
| **CC plugin = 能力单元** | `workspace/plugins/<name>/.claude-plugin/plugin.json` |
| **local marketplace** | `workspace/plugins/.claude-plugin/marketplace.json` |
| **profile 引用 plugin** | `profile.json` 的 `plugins` 字段（`name@marketplace` 形式）|
| **always-on team CLAUDE.md** | `workspace/profiles/<name>/CLAUDE.md` 由 loopat concat 进 sandbox |
| **profile-内 knowledge** | `workspace/profiles/<name>/knowledge/<topic>.md` |
| **workspace 全局 knowledge** | `workspace/knowledge/*.md` |
| **personal default_profiles** | `personal/alice/.loopat/config.json` |
| **personal credentials** | `personal/alice/vaults/<vault-name>/` |
| **物化结果** | `EXAMPLE-COMPOSITION.md` |

---

## 怎么读这个 sample

1. **看一个 profile 长什么样**：`workspace/profiles/mode-oncall/`
   - `profile.json`：3 字段（name, description, plugins）
   - `CLAUDE.md`：sibling 文件，always-on
   - `knowledge/`：optional 参考材料

2. **看 profile 怎么引用 plugin**：`workspace/profiles/role-eng-backend/profile.json` 的 `plugins` 字段——值是 `name@marketplace` 形式，跨 marketplace 也行

3. **看一个 plugin 长什么样**：`workspace/plugins/internal-mcp/`——这是普通 CC plugin（`.claude-plugin/plugin.json` + 可能的 `.mcp.json` / `skills/`）

4. **看 marketplace 入口**：`workspace/plugins/.claude-plugin/marketplace.json`——把 `workspace/plugins/` 整个目录注册成 CC 的一个 local marketplace（取名 `acme-internal`）

5. **看 personal config**：`personal/alice/.loopat/config.json`——决定 alice 默认挂哪些 profile

6. **看物化**：[`EXAMPLE-COMPOSITION.md`](./EXAMPLE-COMPOSITION.md)——alice 跑 `loopat run +mode-oncall` 时实际发生什么

---

## profile vs plugin：核心区别

| | profile（loopat 原生） | plugin（CC 原生） |
|---|---|---|
| 谁定义格式 | loopat | CC |
| 在哪 | `workspace/profiles/` | `workspace/plugins/` 或外部 marketplace |
| 内容 | name + description + plugins 列表 + CLAUDE.md + knowledge/ | skills / commands / MCPs / hooks / agents |
| 谁加载 | loopat runtime（物化时） | CC plugin loader |
| 跨 marketplace 引用 | ✓ 用 `name@marketplace` | ✗ CC 不自动跨装，loopat 兜底 |
| Always-on CLAUDE.md | ✓ loopat 自动 concat | ✗ CC 不加载 plugin root CLAUDE.md |

**Profile 是 plugin 的客户，不是更高级的 plugin。** 它们格式不同、责任不同。

---

## 与现有 1001 实现的关系

**破坏性替换**（既定方向）：

| 现有 | 新模型 |
|------|--------|
| `SandboxMeta.extends?: string` | 删 — profile 之间无 extends |
| 单父线性 extends 链 | profile 平铺独立；用户列 `default_profiles` 组合 |
| `knowledge/.loopat/sandboxes/<name>/` | `workspace/profiles/<name>/` |
| sandbox 内联 plugin/mcp/CLAUDE.md | profile.json 列 plugin 名 + sibling CLAUDE.md |
| `vaults/`（personal 凭据） | 保留 |
| `compose.ts` 的 tier 机制 | 保留思路，tier 从 2 扩到 N |
| `notes/memory/` | 保留 |

---

参考 [`../composition-model.md`](../composition-model.md) 看完整概念模型。
