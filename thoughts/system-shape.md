# 系统形态：自建 filesystem-base + AI-base 的 Thread 系统

## 决定（2026-05-03）

不采用现有工具（GitHub Issues / Linear / Obsidian），**自建一个本地的、filesystem-native、AI-native 的 thread 系统**。

## 排除现有工具的原因

讨论 Obsidian 时浮现的 6 点几乎全部命中：

1. **note-centric vs workspace-centric**：Obsidian 一切是 note，我们要 thread = 目录
2. **markdown 世界 vs 混合世界**：vault 假设 90% 是 `.md`，我们 workspace 大量是代码、产物、二进制
3. **知识管理基因 vs 工作管理基因**：evergreen notes / digital garden 默认沉淀，我们要推进
4. **GUI 插件流 vs 终端流**：我们活在 vim + terminal
5. **缺 runtime 闭环**：Obsidian 不响应 `loopctl deploy`
6. **"打开工具创建 thread" vs "工作中自然长出 thread"**：我们要后者

Linear / GitHub 各自的问题前面已讨论。

## 设计原则（约束）

- **目录是一阶对象**：thread = `~/workspace/<name>/`，不需要 workaround
- **AI 是一阶用户**：AI 直接读写文件、调 CLI，不需要 GUI、不需要 token
- **代码、markdown、产物平等**：没有"二等公民"
- **无 GUI 必需**：终端能跑就够，GUI 是可选
- **Runtime 闭环是第一性**：loopctl 等工具能 emit closure 事件
- **零 lock-in**：所有数据都是 plain file，换工具不丢

## 借鉴

| 来源 | 借鉴 |
|---|---|
| Obsidian Tasks | `- [ ]` 跨文件查询的"一处定义、多处渲染" |
| Obsidian Dataview | YAML frontmatter 当数据库字段 |
| Obsidian backlinks | 文件间引用 → 自动反向索引 |
| GitHub PR | runtime 闭环（PR merge 自动 close） |
| Linear lifecycle | 多态状态流、Triage、Cycle |
| ccx 旧 todo.md | 周轮换、`> workspace: foo` metadata 行 |

## 待解

- `THREAD.md` 的具体 schema（frontmatter 字段、log 约定）
- CLI 操作动词（list / new / log / close / archive？）
- AI 接入形式（MCP？skill？loopctl 子命令？独立工具？）
- INDEX 的角色（todo doc 视图怎么生成？）
- 与外部 thread（tracker / GitHub）的连接协议

## 下一步

最低成本验证：挑一个活跃 thread（如 `~/workspace/loopctl/`），写一个 `THREAD.md`，用最朴素的 markdown + frontmatter，看真实形态。比再讨论 1 小时清楚。
