# Obsidian 深度解读 —— 与我们 Thread 模型的对应

## 一句话

Obsidian 是 local-first 的 markdown 笔记工具，**Thread + Knowledge 那一面几乎是我们模型的现成实现**，特别是 SoT/View 分离。

## 核心模型

- **Vault** = 磁盘上一个文件夹
- **Note** = 一个 `.md` 文件
- 内置：wiki link `[[]]` / 双向链接 / backlinks / graph / tags / daily notes
- 力量在**插件生态**

## Folder vs Note：原子是 note

虽然 vault = folder，但 Obsidian 的一阶对象是 **note（文件）**：
- 文件夹没 metadata、没"内容"、不能写描述
- 你打开的总是一个 note

**对应到我们**：thread = dir 这个想法，要靠在每个 thread 文件夹里放 `THREAD.md` 当代表来 workaround。

## Log 模式：两种 + 一个杀手锏

### 模式 A：Daily Notes（时间索引）

每天一个 `2026-05-03.md`，所有事往里追加。低成本。

### 模式 B：Per-thread Log（thread 索引）

每个 thread 的 `THREAD.md` 留 `## Log` 段，事件按 thread 归档。高价值。

### 杀手锏：Backlinks 自动连接

`[[Thread Foo]]` 写在 daily note 里 → Obsidian 自动建反向索引 → 打开 `Thread Foo.md` 看到"哪些 daily note 提到我"。

**结果**：即使忘了整理 thread log，daily note 写了就自动反映。两个 SoT 通过引用结构自动 cross-reference。

## View 实现：五层

| 层 | 形式 | 复杂度 |
|---|---|---|
| 1 | 文件树 + 全文搜索 | built-in，零配置 |
| 2 | Tags（`#active` `#blocked`） | built-in |
| 3 | Backlinks + Graph view | built-in |
| 4 | **Tasks 插件**：`- [ ]` 跨文件查询 | 关键插件 |
| 5 | **Dataview**：SQL on YAML frontmatter + DataviewJS | 关键插件 |

Tasks 和 Dataview 是把"SoT/View 分离"工程化的现成产品。

## 完整对应

| 我们模型 | Obsidian 实现 |
|---|---|
| Entity（workspace dir） | folder + `THREAD.md` |
| Log（thread 内 raw） | `THREAD.md` 里 `## Log` |
| Log（每日流） | Daily Note + backlinks |
| View（todo / 汇报） | Tasks query + Dataview table |
| 状态 / 元数据 | YAML frontmatter |
| 引用 | `[[wiki link]]` 双向 |

## 不解的四点

1. **代码/产物**：`.py` `.go` 等非 markdown 文件在 vault 里只是 attachment，二等公民
2. **Runtime 闭环**：Obsidian 不会响应 `loopctl deploy`，需要外部脚本写文件触发
3. **Folder 非一阶**：要 `THREAD.md` workaround
4. **Mobile 同步**：付费或自建（git / iCloud / Syncthing）

## 借鉴 vs 直接采用

**借鉴的**：
- ✅ 把 daily note + per-thread log 通过 backlinks 自动连接
- ✅ 用 frontmatter YAML 存状态/元数据
- ✅ Tasks 风格的 query 语言
- ✅ Dataview 风格的多视图渲染

**不一定要绑定 Obsidian**：
- 整套机制都是 markdown + 文件系统，理论上可以脱离 Obsidian 独立工程化
- 但 Obsidian 已经把这些做成开箱即用，是最快验证模型的路径

## 实操建议

1. 把 `~/workspace/` 当 vault 试一下（即使有非 markdown 文件，Obsidian 也忍受）
2. 给两三个活跃 thread 写 `THREAD.md`，带 frontmatter
3. 写一个 Dataview 查询，看实时聚合视图
4. 评估"现成 vs 自研" —— 决定要不要绑定 Obsidian、还是只借鉴模式
