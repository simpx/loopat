/**
 * Context tab — sub-nav (Knowledge / Agents / Repos), each owns
 * sidebar+main below the sub-nav.
 *
 * Ported from opencode prototype loop-tab-context.tsx; markdown render
 * uses local Markdown component (marked-based). Wikilinks `[[X]]`
 * transform to `[X](#wiki:X)` then click handler navigates.
 */
import { createSignal, For, Show } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { Icon } from "../components/icon"
import { Markdown } from "../components/markdown"
import { CodeEditor } from "../components/code-editor"
import { createEditLoop, createDistillLoop } from "../state"

type SubTab = "knowledge" | "notes" | "personal" | "agents" | "repos"

const VALID_SUBS: SubTab[] = ["knowledge", "notes", "personal", "agents", "repos"]

const SUB_TABS: Array<{ id: SubTab; label: string; sub?: string; count?: number }> = [
  { id: "knowledge", label: "Knowledge", sub: "team · sedimented", count: 18 },
  { id: "notes", label: "Notes", sub: "team · public", count: 11 },
  { id: "personal", label: "Personal", sub: "yours · private", count: 17 },
  { id: "agents", label: "Agents", sub: "active · executable", count: 4 },
  { id: "repos", label: "Repos", sub: "passive · code", count: 4 },
]

export function ContextPage() {
  const params = useParams<{ sub: string; path?: string }>()
  const navigate = useNavigate()
  const sub = (): SubTab =>
    (VALID_SUBS as string[]).includes(params.sub) ? (params.sub as SubTab) : "knowledge"
  const subPath = () => params.path ?? ""
  const navigateTo = (sub: SubTab, path: string) => {
    const trimmed = path.replace(/^\/+|\/+$/g, "")
    navigate(trimmed ? `/context/${sub}/${trimmed}` : `/context/${sub}`)
  }
  return (
    <div class="flex flex-col h-full w-full">
      <nav class="flex items-center gap-1 px-3 h-9 shrink-0 border-b border-gray-200 bg-white">
        <For each={SUB_TABS}>
          {(t) => (
            <button
              type="button"
              onClick={() => navigate(`/context/${t.id}`)}
              class={
                sub() === t.id
                  ? "h-7 px-2.5 rounded flex items-center gap-1.5 text-xs bg-gray-100 text-gray-900"
                  : "h-7 px-2.5 rounded flex items-center gap-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
              }
            >
              <span>{t.label}</span>
              {t.count !== undefined && (
                <span
                  class={
                    sub() === t.id
                      ? "text-[10px] px-1 rounded-full bg-gray-200 text-gray-900"
                      : "text-[10px] px-1 rounded-full bg-gray-100 text-gray-500"
                  }
                >
                  {t.count}
                </span>
              )}
            </button>
          )}
        </For>
      </nav>

      <div class="flex-1 min-h-0 min-w-0">
        <Show when={sub() === "knowledge"}>
          <VaultPane
            vault="knowledge"
            urlPath={subPath}
            onNavigate={(p) => navigateTo("knowledge", p)}
          />
        </Show>
        <Show when={sub() === "notes"}>
          <VaultPane
            vault="notes"
            urlPath={subPath}
            onNavigate={(p) => navigateTo("notes", p)}
          />
        </Show>
        <Show when={sub() === "personal"}>
          <VaultPane
            vault="personal"
            urlPath={subPath}
            onNavigate={(p) => navigateTo("personal", p)}
          />
        </Show>
        <Show when={sub() === "agents"}>
          <AgentsPane urlId={subPath} onNavigate={(id) => navigateTo("agents", id)} />
        </Show>
        <Show when={sub() === "repos"}>
          <ReposPane urlId={subPath} onNavigate={(id) => navigateTo("repos", id)} />
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Vaults — Knowledge / Notes / Personal share the same markdown-vault UI
// ============================================================================

export type DocNode =
  | {
      kind: "folder"
      name: string
      children: DocNode[]
      marker?: "ai-write" | "secrets"
    }
  | { kind: "file"; name: string; path: string; updatedAgo?: string; secret?: boolean }

export type VaultId = "knowledge" | "notes" | "personal"

export function flattenVaultFiles(nodes: DocNode[]): { path: string; secret?: boolean }[] {
  const out: { path: string; secret?: boolean }[] = []
  const walk = (n: DocNode) => {
    if (n.kind === "file") out.push({ path: n.path, secret: n.secret })
    else n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

// ----- Knowledge: team · sedimented -----
const KNOWLEDGE_DOCS: DocNode[] = [
  {
    kind: "folder",
    name: "loopat",
    children: [
      { kind: "file", name: "concepts.md", path: "loopat/concepts.md", updatedAgo: "2h" },
      { kind: "file", name: "architecture.md", path: "loopat/architecture.md", updatedAgo: "1d" },
      { kind: "file", name: "phase-roadmap.md", path: "loopat/phase-roadmap.md", updatedAgo: "3d" },
      { kind: "file", name: "naming.md", path: "loopat/naming.md", updatedAgo: "5d" },
      { kind: "file", name: "attach-protocol-spec.md", path: "loopat/attach-protocol-spec.md", updatedAgo: "12h" },
    ],
  },
  {
    kind: "folder",
    name: "ai-org",
    children: [
      { kind: "file", name: "vision.md", path: "ai-org/vision.md", updatedAgo: "5d" },
      { kind: "file", name: "1001-philosophy.md", path: "ai-org/1001-philosophy.md", updatedAgo: "3d" },
      { kind: "file", name: "three-scarce-resources.md", path: "ai-org/three-scarce-resources.md", updatedAgo: "1w" },
      { kind: "file", name: "loop-is-everything.md", path: "ai-org/loop-is-everything.md", updatedAgo: "2w" },
    ],
  },
  {
    kind: "folder",
    name: "conventions",
    children: [
      { kind: "file", name: "loop-naming.md", path: "conventions/loop-naming.md", updatedAgo: "2w" },
      { kind: "file", name: "commit-messages.md", path: "conventions/commit-messages.md", updatedAgo: "2mo" },
      { kind: "file", name: "code-style-ts.md", path: "conventions/code-style-ts.md", updatedAgo: "1mo" },
      { kind: "file", name: "knowledge-layout.md", path: "conventions/knowledge-layout.md", updatedAgo: "1w" },
    ],
  },
  {
    kind: "folder",
    name: "skills",
    children: [
      {
        kind: "folder",
        name: "loop-handoff",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/loop-handoff/SKILL.md", updatedAgo: "1w" },
        ],
      },
      {
        kind: "folder",
        name: "distill-to-knowledge",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/distill-to-knowledge/SKILL.md", updatedAgo: "5d" },
        ],
      },
      {
        kind: "folder",
        name: "spawn-from-chat",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/spawn-from-chat/SKILL.md", updatedAgo: "3d" },
        ],
      },
    ],
  },
]

// ----- Notes: team · public; 任何人 / AI 都可以写入 -----
const NOTES_DOCS: DocNode[] = [
  { kind: "file", name: "inbox.md", path: "inbox.md", updatedAgo: "12m" },
  { kind: "file", name: "focus.md", path: "focus.md", updatedAgo: "2d" },
  {
    kind: "folder",
    name: "research",
    children: [
      { kind: "file", name: "opencode-deep-dive.md", path: "research/opencode-deep-dive.md", updatedAgo: "5h" },
      { kind: "file", name: "claude-code-internals.md", path: "research/claude-code-internals.md", updatedAgo: "2d" },
      { kind: "file", name: "pi-dev-eval.md", path: "research/pi-dev-eval.md", updatedAgo: "4d" },
      { kind: "file", name: "next-auth-beta-notes.md", path: "research/next-auth-beta-notes.md", updatedAgo: "1d" },
    ],
  },
  {
    kind: "folder",
    name: "memory",
    marker: "ai-write",
    children: [
      { kind: "file", name: "weekly-snapshot-2026-05-09.md", path: "memory/weekly-snapshot-2026-05-09.md", updatedAgo: "3h" },
      { kind: "file", name: "spike-comparison.md", path: "memory/spike-comparison.md", updatedAgo: "1d" },
    ],
  },
  {
    kind: "folder",
    name: "meeting",
    children: [
      { kind: "file", name: "2026-05-09-spike-decision.md", path: "meeting/2026-05-09-spike-decision.md", updatedAgo: "5h" },
      { kind: "file", name: "2026-05-02-kickoff.md", path: "meeting/2026-05-02-kickoff.md", updatedAgo: "1w" },
    ],
  },
  {
    kind: "folder",
    name: "daily",
    children: [
      { kind: "file", name: "2026-05-04.md", path: "daily/2026-05-04.md", updatedAgo: "12m" },
      { kind: "file", name: "2026-05-03.md", path: "daily/2026-05-03.md", updatedAgo: "1d" },
    ],
  },
]

// ----- Personal: yours · private; obsidian-like git repo -----
const PERSONAL_DOCS: DocNode[] = [
  {
    kind: "folder",
    name: "vault",
    children: [
      { kind: "file", name: "1001-自己想法.md", path: "vault/1001-自己想法.md", updatedAgo: "2h" },
      { kind: "file", name: "random-2026-05-05.md", path: "vault/random-2026-05-05.md", updatedAgo: "6h" },
      { kind: "file", name: "career-thoughts.md", path: "vault/career-thoughts.md", updatedAgo: "2w" },
    ],
  },
  {
    kind: "folder",
    name: "ideas",
    children: [
      { kind: "file", name: "obsidian-graph-feature.md", path: "ideas/obsidian-graph-feature.md", updatedAgo: "3d" },
      { kind: "file", name: "loop-pricing-model.md", path: "ideas/loop-pricing-model.md", updatedAgo: "1w" },
    ],
  },
  {
    kind: "folder",
    name: "daily",
    children: [
      { kind: "file", name: "2026-05-05.md", path: "daily/2026-05-05.md", updatedAgo: "30m" },
      { kind: "file", name: "2026-05-04.md", path: "daily/2026-05-04.md", updatedAgo: "1d" },
      { kind: "file", name: "2026-05-03.md", path: "daily/2026-05-03.md", updatedAgo: "2d" },
    ],
  },
  {
    kind: "folder",
    name: "style",
    children: [
      { kind: "file", name: "voice-tone.md", path: "style/voice-tone.md", updatedAgo: "5d" },
      { kind: "file", name: "english-style.md", path: "style/english-style.md", updatedAgo: "1mo" },
      { kind: "file", name: "code-aesthetics.md", path: "style/code-aesthetics.md", updatedAgo: "3w" },
    ],
  },
  {
    kind: "folder",
    name: "drafts",
    children: [
      { kind: "file", name: "1001-blog-part-1.md", path: "drafts/1001-blog-part-1.md", updatedAgo: "1d" },
      { kind: "file", name: "loop-talk-outline.md", path: "drafts/loop-talk-outline.md", updatedAgo: "5d" },
    ],
  },
  { kind: "file", name: "private-todo.md", path: "private-todo.md", updatedAgo: "1h" },
  {
    kind: "folder",
    name: "secrets",
    marker: "secrets",
    children: [
      { kind: "file", name: "LOOPAT_API_KEY", path: "secrets/LOOPAT_API_KEY", secret: true, updatedAgo: "12d" },
      { kind: "file", name: "GITHUB_TOKEN", path: "secrets/GITHUB_TOKEN", secret: true, updatedAgo: "1mo" },
      { kind: "file", name: "OPENAI_API_KEY", path: "secrets/OPENAI_API_KEY", secret: true, updatedAgo: "2mo" },
    ],
  },
]

export const VAULT_DOCS: Record<VaultId, DocNode[]> = {
  knowledge: KNOWLEDGE_DOCS,
  notes: NOTES_DOCS,
  personal: PERSONAL_DOCS,
}

const VAULT_META: Record<VaultId, { initialPath: string; defaultOpen: string[]; footer: string }> = {
  knowledge: {
    initialPath: "loopat/concepts.md",
    defaultOpen: ["loopat", "ai-org", "conventions", "skills"],
    footer: "team's distilled materials",
  },
  notes: {
    initialPath: "research/opencode-deep-dive.md",
    defaultOpen: ["research", "memory", "meeting"],
    footer: "team · public",
  },
  personal: {
    initialPath: "vault/1001-自己想法.md",
    defaultOpen: ["vault", "ideas", "daily", "style", "drafts", "secrets"],
    footer: "yours · private",
  },
}

type DocFrontmatter = {
  title?: string
  tags?: string[]
  updated?: string
  driver?: string
}

type DocPage = {
  frontmatter: DocFrontmatter
  body: string
  backlinks: { path: string; preview: string }[]
}

const KNOWLEDGE_CONTENT: Record<string, DocPage> = {
  "loop/overview.md": {
    frontmatter: { title: "Loop Overview", tags: ["loop", "core"], updated: "2h", driver: "simpx" },
    body: `# Overview

Loop is the **basic unit of work** in 1001. See [[ai-org/vision.md]] for why.

Each loop carries:

- a workspace dir
- a chat history
- participants (humans + AI)
- artifacts (verifiable outputs)

## Lifecycle

\`\`\`
Open → Active → Closed | Forked → Archived
\`\`\`

Closure happens when [[loop/lifecycle.md]] criteria are met.

## Relationship to other concepts

| | Loop | Focus | Context |
|---|---|---|---|
| Resource | desire | attention | entropy reduction |
| Cardinality | many | curated | accumulating |

A loop can be tagged \`#focus\` to surface it in the Focus tab — see
[[ai-org/1001-philosophy.md]].`,
    backlinks: [
      { path: "loop/lifecycle.md", preview: "...closure events flip state, see [[loop/overview.md]]..." },
      { path: "ai-org/vision.md", preview: "...the basic unit of work is a [[loop/overview.md|loop]]..." },
      { path: "daily/2026-05-04.md", preview: "...refactored [[loop/overview.md]] to add lifecycle table..." },
    ],
  },
  "loop/lifecycle.md": {
    frontmatter: { title: "Loop Lifecycle", tags: ["loop"], updated: "1d" },
    body: `# Loop Lifecycle

Four states + one side-state.

States:

1. **Open** — \`loop new\`, dir + empty chat
2. **Active** — work happening
3. **Closed** — runtime verified, or driver marked done
4. **Archived** — settled, knowledge precipitates

Side: **Forked** — branched off another loop.

Closure criteria: see [[loop/overview.md#lifecycle]].`,
    backlinks: [{ path: "loop/overview.md", preview: "...[[loop/lifecycle.md]] criteria are met..." }],
  },
  "ai-org/vision.md": {
    frontmatter: { title: "1001 Vision", tags: ["ai-org", "core"], updated: "5d" },
    body: `# 1001 Vision

> Loop is everything. Runtime is the membrane. Knowledge is the flow.

人类的稀缺资源映射到三个一级概念：

- **Loop**      ← 驱动力 — see [[loop/overview.md]]
- **Focus**     ← 注意力
- **Context**   ← 熵减能力 (this!)

Chat 是协调通道，不属于稀缺资源轴。

只有**人类参与**，Context 才会越来越精简 — AI 能产生输出但不会自发追求简洁。
关于这个原则的展开，看 [[ai-org/1001-philosophy.md]]。`,
    backlinks: [
      { path: "loop/overview.md", preview: "See [[ai-org/vision.md]] for why." },
      { path: "ai-org/1001-philosophy.md", preview: "...continues from [[ai-org/vision.md]]..." },
    ],
  },
  "ai-org/1001-philosophy.md": {
    frontmatter: { title: "1001 Philosophy", tags: ["ai-org"], updated: "3d" },
    body: `# 1001 Philosophy

(extends [[ai-org/vision.md]])

## Driver = human

AI has no autonomous desire. The driver — the source of intent — must be a
human. Agents are tools the driver uses, not autonomous actors.

## Three scarce resources

The product surface is shaped by what's scarce in the human:

1. **Drive (驱动力)** — \`Loop\`
2. **Attention (注意力)** — \`Focus\`
3. **Entropy reduction (熵减能力)** — \`Context\` (you're reading it)`,
    backlinks: [
      { path: "ai-org/vision.md", preview: "...[[ai-org/1001-philosophy.md]]." },
      { path: "loop/overview.md", preview: "see [[ai-org/1001-philosophy.md]]." },
    ],
  },
  "gateway/cache-strategies.md": {
    frontmatter: { title: "KV Cache Strategies", tags: ["gateway"], updated: "1w" },
    body: `# KV Cache Strategies

(WIP — picking up from [[gateway/rdma-mr-register.md]])

## SLRU + Ghost

Two-tier admission with a ghost queue for re-admission. Helps with cache
thrashing under workload shifts.

## Eviction

LRU baseline, then SLRU+G overlay. See vllm fork for impl.`,
    backlinks: [],
  },
  "gateway/rdma-mr-register.md": {
    frontmatter: { title: "RDMA mr_register", tags: ["rdma"], updated: "2w" },
    body: `# RDMA mr_register

\`mr_register\` is the bottleneck for RDMA-backed cache. Page alignment must
match cuda alignment.

See loops: gateway-launch, rdma-fix.`,
    backlinks: [
      { path: "gateway/cache-strategies.md", preview: "picking up from [[gateway/rdma-mr-register.md]]" },
    ],
  },
  "loop/rfd-and-claim.md": {
    frontmatter: { title: "RFD & Claim", tags: ["loop"], updated: "4d" },
    body: `# RFD (Request For Drive) & Claim

When the current driver can't keep going (会议、休假、阻塞），可以 **release** loop。
Loop 进入 RFD 状态，任何成员都能 **claim drive** 接手。

## 流程

1. 当前 driver 点 RFD → loop 状态变 \`active · RFD\`
2. 列表里出现 RFD 标，所有成员可见
3. 接手人点 drive → driver 改成接手人，状态回 \`active\`
4. 时间线记录 \`released by X\` + \`claimed by Y\`

## 自己 RFD 自己接

允许的——同一人也可以 release 后再 drive 自己。常用于"我先 release 一下让别人有机会，没人接我自己继续"。`,
    backlinks: [],
  },
  "ai-org/three-scarce-resources.md": {
    frontmatter: { title: "Three Scarce Resources", tags: ["ai-org", "core"], updated: "1w" },
    body: `# 三种稀缺资源

AI 时代，人贡献什么？三件事：

1. **驱动力** (drive) — 决定做 X 而不是 Y。映射到 \`Loop\`
2. **注意力** (attention) — 识别什么重要。映射到 \`Focus\`
3. **熵减能力** (entropy reduction) — 把混乱整理成清晰。映射到 \`Context\`

Chat 不在这条轴上——它是协调通道，不是稀缺资源。

延伸阅读：[[ai-org/vision.md]] / [[ai-org/1001-philosophy.md]]`,
    backlinks: [
      { path: "ai-org/vision.md", preview: "...展开看 [[ai-org/three-scarce-resources.md]]" },
    ],
  },
  "ml/long-context-techniques.md": {
    frontmatter: { title: "Long Context Techniques", tags: ["ml", "long-context"], updated: "3w" },
    body: `# Long Context Techniques

> 沉淀自 llama-research loop 的发现 + 公开 papers

## Attention 优化

- **Flash-Attention v3** — IO-aware kernel，64k+ 长度收益最大
- **MLA (Multi-head Latent Attention)** — KV cache 压缩，降 IO 5-8x
- **Sliding window** — 超长序列下截断，但需要任务能容忍

## Prefill 优化

- **Chunked prefill** — 流水化，提高 GPU util
- **Shared prefix cache** — 同 prompt 前缀复用，命中率 > 60% 才有意义
- **Paged KV** — 减少 IO round-trip

## 实测瓶颈

64k+ 长度下，attention 自身 IO 是瓶颈，不是 compute。GPU util 通常 30-40%。`,
    backlinks: [],
  },
  "ml/speculative-decoding.md": {
    frontmatter: { title: "Speculative Decoding", tags: ["ml"], updated: "1mo" },
    body: `# Speculative Decoding

用小模型起草，大模型验证。延迟降低 ~2x，吞吐持平。

## 实现要点

- draft 模型 vocab 必须是 target 的子集
- 一次生成 4-8 token candidate，并行验证
- 接受率 > 60% 才划算

## 适用场景

延迟敏感、token 不太长的场景（chat、补全）。长生成（>1k tokens）收益递减。`,
    backlinks: [],
  },
  "conventions/git-style.md": {
    frontmatter: { title: "Git Style", tags: ["conventions"], updated: "2mo" },
    body: `# Git Style

## Commit 信息

\`type: scope: subject\` 风格，第一行 ≤ 60 字符。

\`\`\`
feat: runtime: paginate list-shards
fix: rdma: align buffer to 4K before reg
docs: 1001: add loop lifecycle diagram
\`\`\`

## Branch 命名

- \`feat/<thing>\` 新功能
- \`fix/<thing>\` 修 bug
- \`refactor/<thing>\` 重构
- 临时探索：\`spike/<thing>\`

## Merge 策略

- 默认 rebase，保持线性历史
- 不用 merge commit，除非显式要求`,
    backlinks: [],
  },
  "conventions/code-style-go.md": {
    frontmatter: { title: "Go Code Style", tags: ["conventions", "go"], updated: "2mo" },
    body: `# Go Code Style

## 错误处理

- \`if err != nil { return fmt.Errorf("ctx: %w", err) }\`
- 永远 wrap，永远加 context

## 注释

- 只写 *why*，不解释 *what*
- public symbol 必须有 godoc 注释，简洁

## Package layout

- \`cmd/\` 入口
- \`internal/\` 私有
- \`api/\` 对外 SDK
- 不用 \`pkg/\``,
    backlinks: [],
  },
  "conventions/code-style-python.md": {
    frontmatter: { title: "Python Code Style", tags: ["conventions", "python"], updated: "2mo" },
    body: `# Python Code Style

- type hints 必填
- 用 \`ruff\` + \`pyright\`，不用 black（ruff format 取代）
- 异步用 \`asyncio\`，不混 \`trio\`
- Pydantic v2 only`,
    backlinks: [],
  },
  "skills/loop-handoff/SKILL.md": {
    frontmatter: { title: "Loop Handoff", tags: ["skill"], updated: "1w" },
    body: `---
name: loop-handoff
description: 在 loop 移交（RFD / claim）时，整理 context 让下一位 driver 能快速接手
trigger: explicit
---

# Loop Handoff

## 何时触发

driver 主动 \`release\`，或被指派接手 loop 时。

## 步骤

1. **梳理已完成** — 翻 chat / artifacts，列已 close 的子任务
2. **梳理在做的** — 当前正在动的代码 / 文档 / 实验
3. **梳理阻塞** — 卡在哪、需要谁
4. **personal symlinks unlink** — 移交方的私人 context 拆掉
5. **dump 一份 handoff note 到 notes/memory/** — 接手人读完就能上手

## 输出

\`\`\`
## handoff: <loop-name>
- done: ...
- in-flight: ...
- blocked: ...
- watch out: ...
\`\`\``,
    backlinks: [],
  },
  "skills/distill-to-knowledge/SKILL.md": {
    frontmatter: { title: "Distill to Knowledge", tags: ["skill"], updated: "5d" },
    body: `---
name: distill-to-knowledge
description: 把 notes / loop 产物里成熟的内容沉淀进 knowledge
trigger: ai-suggest
---

# Distill to Knowledge

> 熵减只能由人完成。AI 提示候选，最终是用户决定蒸馏什么、丢什么。

## 何时触发

AI 看到一段 notes 内容反复被引用、被多个 loop 命中、被 backlink 多次——提示用户考虑 distill。

## 评估清单

- [ ] 内容稳定（最近 30d 修改 < 2 次）
- [ ] 跨 loop 适用（不是某 loop 局部知识）
- [ ] 有结构（标题、段落、能被引用）
- [ ] 用户认为值得沉淀

## 动作

- 选目标路径（loop/ / ai-org/ / gateway/ / ml/ / conventions/ / skills/）
- 必要时 reorg、加 frontmatter、补 backlinks
- commit \`docs(knowledge): distill <topic> from notes\``,
    backlinks: [],
  },
  "skills/code-review-checklist/SKILL.md": {
    frontmatter: { title: "Code Review Checklist", tags: ["skill"], updated: "2w" },
    body: `---
name: code-review-checklist
description: 在 loop 里对一段 diff 做 review 时跑这个 checklist
trigger: explicit
---

# Code Review Checklist

> 不引入独立 review 系统——review 就在 loop 里完成。reviewer 是有 commit 权限的人接 loop。

- [ ] 改动范围与 PR 描述一致，没有"夹带"
- [ ] 没有引入 secret 明文（grep \`API_KEY\` / \`TOKEN\`）
- [ ] error 都 wrap 了 context（go: \`%w\`，python: \`raise X from e\`）
- [ ] 公共 API 改了 → CHANGELOG 更新了
- [ ] 测试覆盖：至少 happy path + 1 个 edge
- [ ] runtime 有 deprecation warn（如果删了 API）`,
    backlinks: [],
  },
  "skills/incident-triage/SKILL.md": {
    frontmatter: { title: "Incident Triage", tags: ["skill", "ops"], updated: "1mo" },
    body: `---
name: incident-triage
description: 收到 alert / page 后 5 分钟内做的事
trigger: alert
---

# Incident Triage

## 5 分钟规则

收到 page 后 5min 内必须完成：

1. **ack** — 在告警通道里 \`/ack\`，告诉别人你接手了
2. **看面板** — Grafana / SLS 找异常 metric
3. **判断 blast radius** — 是单 region / 全网？user-facing 吗？
4. **decide** — rollback / hotfix / 拉群

## 判断标准

| signal | action |
|---|---|
| qps 跌 50%+ | rollback |
| p99 涨 2x+ 且 sustained | rollback or hotfix |
| 单实例 OOM | restart, 不 rollback |
| auth fail | check token expiry first |

## 拉群标准

涉及 > 1 服务、> 5min 未恢复、或客户已感知 → 拉应急群。`,
    backlinks: [],
  },
  "skills/incident-triage/runbook-template.md": {
    frontmatter: { tags: ["skill", "template"], updated: "1mo" },
    body: `# Runbook template

事件结束后填这个模板，归档进 \`notes/memory/\`。

\`\`\`
## Incident <yyyy-mm-dd-slug>

- detected: <when, by whom/what>
- impact: <region / pct of traffic / customer count>
- root cause: <one line>
- mitigation: <what was done>
- postmortem owner: <name>
- followups:
  - [ ] ...
\`\`\``,
    backlinks: [],
  },
  "skills/incident-triage/grafana-cheatsheet.md": {
    frontmatter: { tags: ["skill", "cheatsheet"], updated: "1mo" },
    body: `# Grafana cheatsheet

常用 dashboard 直链：

- **api-latency**: grafana.internal/d/api-latency
- **gateway-cache-hit**: grafana.internal/d/gateway-cache
- **rdma-register**: grafana.internal/d/rdma-mr
- **traffic-mix**: grafana.internal/d/llama-traffic

筛 5min 窗口：URL 加 \`?from=now-5m&to=now\`。

oncall 默认看 api-latency 那张。`,
    backlinks: [],
  },
  "skills/code-review-checklist/examples.md": {
    frontmatter: { tags: ["skill", "examples"], updated: "2w" },
    body: `# Examples

实际跑过这个 checklist 的几个例子，给 AI / 新人参考。

## 例 1：runtime paginate (loopctl loop)

通过：
- 范围对 ✓
- 没 secret ✓
- error wrap 有 \`%w\` ✓
- CHANGELOG 加了 ✓
- e2e 测试覆盖 + deprecation warn ✓

## 例 2：rdma alignment (gateway-launch loop)

打回：
- ✗ 改了 \`runtime/gateway.py\` 但 PR 描述没提
- ✗ 没加测试，只手动验证
- 修完再 commit`,
    backlinks: [],
  },
  "loopat/concepts.md": {
    frontmatter: { title: "loopat 4 一级概念", tags: ["loopat", "core"], updated: "2h", driver: "simpx" },
    body: `# loopat 4 一级概念

> 对外品牌 loopat，内部 codename 1001。

## Loop（驱动力）

first-class 工作单元 = **context + ai + workdir**。绑定一个长程任务和一个 driver。

强单人语义但允许"无 driver 出生"（rfd from creation）—— 这正是 incident queue 的形态。

参考 [[loopat/architecture.md]] §2。

## Focus（注意力）

团队当下"什么重要"的派生 view。**不是 entity**，状态预算只有 \`notes/focus.md\` 几行 pinned/listed。
其余从 \`loop.focuses[]\` 派生。

参考 [[ai-org/three-scarce-resources.md]]。

## Context（熵减能力）

team's distilled materials，三种形态：

- **Knowledge** — 沉淀文档（你正在读的）
- **Notes** — 团队 prose（含 inbox.md 稀碎）
- **Repos** — git 仓
- **Agents** — 可执行外壳，配置在 Context，调用在 Chat

(Personal 是私人的，跟 team Context 隔离)

## Chat（sync 协调）

ephemeral context。通过 \`loop.context.chats[]\` 被 loop ingest 后变成 first-class context source。

参考 [[loopat/architecture.md]] §3。`,
    backlinks: [
      { path: "loopat/architecture.md", preview: "...4 一级概念见 [[loopat/concepts.md]]..." },
      { path: "ai-org/loop-is-everything.md", preview: "...[[loopat/concepts.md]] 是产品落地..." },
    ],
  },
  "loopat/architecture.md": {
    frontmatter: { title: "loopat 架构", tags: ["loopat"], updated: "1d", driver: "panlilu" },
    body: `# loopat 架构

## 1. C/S 架构

每个 loop 跑在某个 server 上（本机或云端）。client 走同一套 attach 协议。
0.1 即采用 c/s，避免 0.2 协作时返工。

## 2. Loop = AI runtime + Context + Workdir

\`\`\`
loop {
  driver: who's driving (or null = rfd-from-birth / incident)
  context: { knowledge, notes, personal, chats[] }
  workdir: git worktree
  timeline: events (create / driver-change / rfd / claim / fork)
}
\`\`\`

## 3. Attach 协议（草稿）

ws topic \`/loop/<id>\`：subscriber 立刻收 snapshot + 增量 event。
driver-transfer 是事件，所有 client 同步。close 是 send-only。

参考 [[loopat/attach-protocol-spec.md]]。

## 已决问题

- ChatMount 走 mutate（@@id([loopId, channelId])），不做 versioning（先简单）
- driver 字段挂在 session metadata 而不是另起 model
- attach SSE → ws，多 subscriber

## 未决

- workspace 隔离 + 权限边界
- agent 的 trigger / 安全沙箱`,
    backlinks: [
      { path: "loopat/concepts.md", preview: "...参考 [[loopat/architecture.md]] §2..." },
      { path: "loopat/attach-protocol-spec.md", preview: "...扩展自 [[loopat/architecture.md]] §3..." },
    ],
  },
  "loopat/phase-roadmap.md": {
    frontmatter: { title: "loopat phase roadmap", tags: ["loopat", "planning"], updated: "3d" },
    body: `# Phase Roadmap

> 1001-mvp.md §2 的精简版。

## Phase 1 — 高保真原型 ← **目前在做**

产出：4 tab UI 原型 + 说明文档。reviewer 看完能讲清 1001 是什么。

## Phase 2 — 架构选型

候选：
1. fork \`sst/opencode\`（simpx 在做 spike）
2. 自建 Next.js + tRPC + Prisma + Postgres + WS（panlilu 在做 spike）
3. pi.dev 等 — 待评估

周末 close 取舍。

## Phase 3 — 0.1 单人版

100% 替代 simpx 本地 ccx，连续用一周不回退。c/s 架构从 0.1 开始。

## Phase 4 — 0.2 多人协作

attach 别人 loop。两人完成 spawn → attach → close 流程。`,
    backlinks: [
      { path: "ai-org/vision.md", preview: "...phase 计划见 [[loopat/phase-roadmap.md]]..." },
    ],
  },
  "loopat/naming.md": {
    frontmatter: { title: "loopat 命名由来", tags: ["loopat", "brand"], updated: "5d" },
    body: `# loopat 命名

\`loopat.ai\` —— 内嵌两个语义资产：

1. **loop**（项目核心概念）
2. **pat**（隐藏词）—— 计划做成产品 UX 动词：用户给 AI response 一个 "pat"，比 thumbs-up 更具身。
   跟 RLHF 反馈语义吻合。

放弃了"loop at AI"作为短语解读 —— "loop at" 不是英语 idiom，硬解牵强。

logo emoji **🧶**（毛线团）—— loop 的有机/暖感呈现，跟 brand 软调性一致。

workspace 内部 codename 仍叫 \`1001\`（Scheherazade 起源典故）。`,
    backlinks: [],
  },
  "loopat/attach-protocol-spec.md": {
    frontmatter: { title: "Attach 协议草稿", tags: ["loopat", "spec"], updated: "12h", driver: "simpx" },
    body: `# Attach 协议（草稿 v0）

> 状态：草稿，simpx 写，明早跟 panlilu 对一遍。

## 目标

让多个 client 实时 mirror 同一个 loop —— driver 操作 + AI 回复 + chat 增量 全部同步。

## Topic

\`/loop/<id>\` — ws subscription

## 消息类型

| event | direction | payload |
|---|---|---|
| \`snapshot\` | s→c | 完整 loop state（订阅时立刻发） |
| \`message\` | s→c | 新 chat 增量 |
| \`timeline\` | s→c | driver-change / rfd / claim / fork 等系统事件 |
| \`tool-call\` | s→c | AI 调工具的中间状态 |
| \`user-input\` | c→s | 当前 driver 发的消息 |
| \`claim\` | c→s | 非 driver 想 claim drive |

## 权限

非 driver 只能 sub + 发 \`claim\`。driver 改了之后，rfd=false，原 driver 失去 user-input 权限。

## 待办

- [ ] 跟 panlilu 对齐 ws message envelope 格式
- [ ] 决定 reconnect / replay 策略
- [ ] sub auth：workspace token + loop visibility check`,
    backlinks: [
      { path: "loopat/architecture.md", preview: "...细节见 [[loopat/attach-protocol-spec.md]]..." },
    ],
  },
  "ai-org/loop-is-everything.md": {
    frontmatter: { title: "Loop is everything", tags: ["ai-org", "philosophy"], updated: "2w" },
    body: `# Loop is everything

> Loop is everything. Runtime is the membrane. Knowledge is the flow.

## Loop is everything

任何长程工作都装在 loop 里 —— 而不是 todo / issue / channel。
loop 有 driver、有 workdir、有 context、有 timeline，是一个完整的"工作单元"。

## Runtime is the membrane

好的 runtime（如 dashctl）把分散文档收敛进 CLI 自描述接口，降低 AI context footprint。
Loop 通过 runtime 跟外界交互（git / file system / agent api）。

## Knowledge is the flow

knowledge 不是仓库里的死文档，是 loop 沉淀出的"流"——
loop 完成 → distill → knowledge 增长 → 下一个 loop 启动时拉到的 context 更密、更准。`,
    backlinks: [
      { path: "loopat/concepts.md", preview: "...[[ai-org/loop-is-everything.md]] 的产品落地..." },
    ],
  },
  "conventions/loop-naming.md": {
    frontmatter: { title: "Loop 命名约定", tags: ["conventions"], updated: "2w" },
    body: `# Loop 命名

- **kebab-case** —— \`loopat-runtime-spike\`，不混 camelCase / 下划线
- **动词优先**: \`research-opencode\`, \`fix-callback-5xx\`, \`spike-trpc-router\`
- **scope 在前，subject 在后**: \`prototype-hifi\`, \`loopat-ts-mvp\`
- **incident**: 以 \`incident-\` 或描述性词如 \`site-uptime-spike\` 开头`,
    backlinks: [],
  },
  "conventions/commit-messages.md": {
    frontmatter: { title: "Commit message 约定", tags: ["conventions"], updated: "2mo" },
    body: `# Commit Messages

\`type(scope): subject\`

第一行 ≤ 60 字符。type 候选：
- \`feat\` 新功能
- \`fix\` bug 修复
- \`refactor\` 内部重构
- \`docs\` 文档
- \`test\` 测试
- \`chore\` 工程杂项

例：
- \`feat(focus): derive section from loop.focuses[]\`
- \`fix(chat): merge contacts into dms section\``,
    backlinks: [],
  },
  "conventions/code-style-ts.md": {
    frontmatter: { title: "TypeScript 风格", tags: ["conventions"], updated: "1mo" },
    body: `# TypeScript Style

## 命名
- \`PascalCase\` for types/components
- \`camelCase\` for functions/variables
- \`UPPER_SNAKE\` for module-level constants

## 注释
默认不写。只在 WHY 非显然时写一行。
不写 WHAT（命名好就够了）。

## SolidJS 约定
- 组件名 PascalCase
- signal getter 末尾 \`()\`，setter 用 \`setX\`
- module-level signal 走 \`createSignal\` + export
- props 严禁 destructure（破坏响应性）`,
    backlinks: [],
  },
  "conventions/knowledge-layout.md": {
    frontmatter: { title: "Knowledge 目录约定", tags: ["conventions"], updated: "1w" },
    body: `# Knowledge Layout

## 主题目录 + CLAUDE.md 索引

每个主题一个目录。目录下的 CLAUDE.md 是索引（一行一文件 + 简述）。
AI 加载主题时只读索引，需要时再深入。

## 内部链接用 wikilink

\`[[topic/file.md]]\` 而不是相对路径。backlinks 自动维护。

## 命名
- 文件名 kebab-case
- 一个文件 one topic
- frontmatter 含 \`title / tags / updated / driver\`

## inbox 与 sediment

\`notes/inbox.md\` 是高熵稀碎的家。沉淀后进 \`knowledge/<topic>/\`。
\`notes/\` 是公开 prose；\`personal/\` 是私人。`,
    backlinks: [],
  },
  "skills/spawn-from-chat/SKILL.md": {
    frontmatter: { title: "Spawn loop from chat message", tags: ["skill"], updated: "3d" },
    body: `# Spawn loop from chat message

## 触发
讨论开始变深入；某条消息值得有 driver 跟到底。

## 步骤
1. 选中消息或 reply 时按 \`⌘L\`（or 右键 → spawn loop）
2. 自动填充：title = 消息前 50 字；context.chats = [{id: this channel, upTo: now}]
3. driver 默认 = 当前用户；可选填 focus tag
4. 跳到新 loop 的 chat 视图，原 channel 留一条系统消息 \`✓ spawned loop xxx\`

## anti-pattern
- 不要 spawn loop 当 todo —— 稀碎走 \`notes/inbox.md\`
- 不要 spawn loop 当 group chat —— 临时多人聊就直接在 channel 里

## 谁能做
任何 workspace member。AI agent 也可以（如 coo 发现讨论变深入时主动建议）。`,
    backlinks: [
      { path: "loopat/concepts.md", preview: "...spawn 流程见 [[skills/spawn-from-chat/SKILL.md]]..." },
    ],
  },
}

const NOTES_CONTENT: Record<string, DocPage> = {
  "inbox.md": {
    frontmatter: { tags: ["inbox"], updated: "12m" },
    body: `# 团队稀碎 inbox

> 一行一个 bullet，没有 status / assignee / due date —— 想做就 spawn loop，不想做直接删。
> 这不是 todo list，是 prose；腐烂时直接删，不维护"open 数量"。

- 看了下 sst/opencode v0.7 release notes，有几个 hook 点变了，回头确认 fork 还能不能 rebase
- tweetdeck 上看到一个聊 'AI org' 的 thread，截图存了 personal/inbox/
- @panlilu next-auth beta 的 session expire callback 跟 5.0 final 行为不一样，注意
- 把 1001-mvp.md §3 重写一版，加 c/s 协议的边界
- https://github.com/sst/opencode/discussions/482 有人问怎么加 attach，回头看下他们怎么想的
- loopat.ai 域名转 cloudflare 的事还没办，等 panlilu 那边 deployment 决定
- demo 视频先录第一版（2 分钟），上 hn show 用
- 周三跟 panlilu 把两条 spike 的取舍讨论 closed，下周二之前定方向`,
    backlinks: [],
  },
  "focus.md": {
    frontmatter: { tags: ["meta"], updated: "2d" },
    body: `# Focus 配置

> Focus tab 的唯一"真存"。其余都从 \`loop.focuses[]\` 派生。

## pinned

永不从当下消失，即使 8d 无活动。Focus tab 顶部的 📌 段。

- 产品侧高保真原型
- 可自举的MVP

## listed

当前还没绑定 loop 的 meta focus，作为占位出现。当任意 loop 给自己打上对应 tag 时，自动转为正常 focus。

- 初版上线
`,
    backlinks: [],
  },
  "memory/team-conventions-2026-05.md": {
    frontmatter: { tags: ["memory"], updated: "3h", driver: "ai" },
    body: `# Team conventions (2026-05 snapshot)

> AI 自主整理。从最近 30d 的 loop 行为里观察到的隐性约定。

- **Loop 命名** 用 kebab-case（gateway-launch、llama-research），不混 camelCase
- **commit 信息** 第一行 ≤ 60 字符，type: scope: subject 风格
- **CHANGELOG.md** 一律放仓库根目录，按 Unreleased / [version] 分段
- **Deprecation** 通过 \`internal/deprecation\` 包做 runtime warn，不靠 README
- **Knowledge distill** 来自 loop 时，AI 会主动建议路径而不是用户选`,
    backlinks: [],
  },
  "memory/1001-design-snapshot.md": {
    frontmatter: { tags: ["memory", "1001"], updated: "1d", driver: "ai" },
    body: `# 1001 design snapshot — 2026-05-04

当前在 phase1-prototype 上验证：

- **Loop 中心论**：Loop = AI + Context，是基本工作单位
- **Context 三层**：knowledge（沉淀）/ notes（团队 raw）/ personal（私人）
- **注入机制**：创建 loop 时从三个 source 挑 path 注入 workdir
- **移交时**：personal symlink unlink，接手人自己重建 context

待确认：private loop 的 dump 目标路径；secrets 加密方案。`,
    backlinks: [],
  },
  "todo/active.md": {
    frontmatter: { tags: ["todo"], updated: "30m" },
    body: `# Active todos

- [ ] context tab 三层模型实现（in progress）
- [ ] loop 创建对话框：让用户挑要注入的 source path
- [ ] loop header 显示 injected sources
- [ ] secrets 注入按钮（mock）`,
    backlinks: [],
  },
  "todo/blocked.md": {
    frontmatter: { tags: ["todo", "blocked"], updated: "2d" },
    body: `# Blocked

- [ ] private loop 设计 — 等 dump path 决策
- [ ] secrets 加密 — 等评估 git-crypt vs sops`,
    backlinks: [],
  },
  "daily/2026-05-04.md": {
    frontmatter: { tags: ["daily"], updated: "12m" },
    body: `# 2026-05-04

- ✅ 验证 opencode TUI 多客户端共享 work
- ✅ Fork opencode 起 1001 prototype
- 📌 完成 4-tab + Focus zen 重构
- 💡 Context 三层模型 — 拉通了
- 💡 加 wikilink + backlinks，向 [[loop/overview.md]] 看齐`,
    backlinks: [],
  },
  "daily/2026-05-03.md": {
    frontmatter: { tags: ["daily"], updated: "1d" },
    body: `# 2026-05-03

- 跟 [[ai-org/vision.md]] 拉齐了"三种稀缺资源"哲学
- focus tab zen 化讨论`,
    backlinks: [],
  },
  "memory/llama-3-rollout-status.md": {
    frontmatter: { tags: ["memory", "rollout"], updated: "5h", driver: "ai" },
    body: `# Llama-3 Rollout 状态

> AI 自动汇总 · 5h ago

## 当前进度

- **shadow** (流量镜像) → 进行中，p99 偏高，已经 patch \`--warm-on-swap=true\`
- **canary** (1% 真流量) → 计划本周末
- **GA** → 下周三视 canary 表现

## 关键指标

| metric | shadow | baseline |
|---|---|---|
| p99 | 145ms (post-patch) | 124ms |
| cache hit | 0.71 | 0.78 |
| qps | 408 | 410 |

## 风险

- cache hit 还差 ~7pp，可能与 swap 后 warmup 步长有关`,
    backlinks: [],
  },
  "todo/this-week.md": {
    frontmatter: { tags: ["todo"], updated: "1d" },
    body: `# 本周 (2026-05-04 ~ 05-10)

- [x] 1001 phase1-prototype 4-tab 拉通
- [x] Context 三层模型实现
- [ ] Loop 创建对话框 polish
- [ ] Knowledge 编辑器对接
- [ ] Notes 自动归类策略
- [ ] llama canary 准备`,
    backlinks: [],
  },
  "meeting/2026-05-05-standup.md": {
    frontmatter: { tags: ["meeting", "standup"], updated: "5h" },
    body: `# Standup · 2026-05-05

## simpx
- 完成 1001 Context 三层模型
- 在做 Loop 编辑器对接
- 阻塞：无

## 阿尔萨斯
- gateway RDMA alignment 跑通了
- 在做 NUMA pinning
- 阻塞：需要 loopat-runtime repo 写权限确认

## 伊利丹
- llama-3 long-context eval 跑完
- 跑了 long context eval（结果在 llama-research loop 自己的 workdir）
- 阻塞：无

## 决议

- 周四 llama-3 canary 准备 review`,
    backlinks: [],
  },
  "meeting/2026-05-04-arch-review.md": {
    frontmatter: { tags: ["meeting", "arch"], updated: "1d" },
    body: `# Arch review · 2026-05-04

讨论：1001 是否要把 chat 也作为一级资源。

结论：不要。chat 是协调通道，不是稀缺资源轴上的东西。
详见 [[ai-org/three-scarce-resources.md]]。`,
    backlinks: [],
  },
  "meeting/2026-05-02-quarterly-plan.md": {
    frontmatter: { tags: ["meeting", "plan"], updated: "3d" },
    body: `# Q3 Plan · 2026-05-02

## 北极星

把"AI 是同事"做成可用的、本地化的协作系统。

## 关键里程碑

- **M1** (5月底) — 1001 phase1 内部用起来
- **M2** (6月中) — Knowledge 自动 distill 跑通
- **M3** (7月) — 多人 loop 协作压测`,
    backlinks: [],
  },
  "research/opencode-deep-dive.md": {
    frontmatter: { tags: ["research", "opencode"], updated: "5h", driver: "simpx" },
    body: `# opencode 深度调研

> simpx 在 \`research-opencode\` loop 里写的笔记。

## stack
- TypeScript 全栈 monorepo
- packages: server (express+ws) / desktop (Tauri) / cli
- session = chat history + tool calls + working state
- project = workdir，1:N session
- attach: SSE 单 subscriber

## 适配 1001 概念

| 1001 | opencode 现状 | 改动 |
|---|---|---|
| Loop | session × project 组合 | 加 driver / rfd 字段 |
| Focus | 无 | workspace-level 派生 view |
| Context.chats | 无 | session.contextSources 扩展 |
| Attach (multi-client) | SSE 单 sub | 改 ws + 多 sub |

## 风险
- upstream 节奏快（v0.7 hooks 系统重构），fork 容易脱节
- desktop 是 Tauri，1001 想要 web-first 的话还要拆

## 结论倾向
fork 时间短（3-4w）但有 upstream 风险。看 panlilu 自建那条进度。`,
    backlinks: [
      { path: "memory/spike-comparison.md", preview: "...细节见 [[research/opencode-deep-dive.md]]..." },
    ],
  },
  "research/claude-code-internals.md": {
    frontmatter: { tags: ["research", "claude-code"], updated: "2d" },
    body: `# Claude Code SDK 调研

## 形态
单进程 CLI。无 multi-client attach。

## 扩展机制
- **hooks**: pre-tool / post-tool / on-stop 注入用户行为
- **skills**: SKILL.md 描述 + AI 按需加载
- **MCP**: 接外部 server

## 对 loopat 的启示
- skills 系统值得抄 —— SKILL.md 自描述、按需加载
- hooks 比 opencode 的 tool 系统灵活
- 但他们的 single-process 模型对 attach 不友好

## 不适合直接 fork
跟 1001 c/s 协作架构错位。可以借鉴 skills 系统。`,
    backlinks: [],
  },
  "research/pi-dev-eval.md": {
    frontmatter: { tags: ["research", "pi-dev"], updated: "4d" },
    body: `# pi.dev 评估

> 候选架构 #3。

试用 30 分钟印象：
- 类 cursor 的 IDE-内嵌形态
- 强调 individual productivity，不是团队 loop
- 没有 driver / focus / attach 的概念

不匹配 1001 团队协作语义。**否决。**

只剩 opencode-fork vs 自建二选一。`,
    backlinks: [],
  },
  "research/next-auth-beta-notes.md": {
    frontmatter: { tags: ["research", "next-auth"], updated: "1d", driver: "panlilu" },
    body: `# next-auth 5.0-beta 注意点

> panlilu 写的，集成时遇到的坑。

## session expire callback 行为变化
beta.25 的 \`session.maxAge\` 默认 30d，但 callback 触发时机跟 5.0 final 不一样。
我们的 staging 出 5xx 抖动很可能就是这个 —— 老 token 在 callback 里被刷成空。

## prisma adapter 注意
- \`@auth/prisma-adapter\` 跟 \`@prisma/client@6\` 兼容
- 但 schema 必须用 NextAuth 推荐的字段名（不能改 \`Account.userId\` → \`Account.user_id\`）

## TODO
等 5.0 final release，重测 callback 行为。`,
    backlinks: [],
  },
  "memory/weekly-snapshot-2026-05-09.md": {
    frontmatter: { tags: ["memory"], updated: "3h", driver: "ai" },
    body: `# Weekly Snapshot · 2026-05-09

> coo 自动整理。每周日生成。

## 这周做了什么

- prototype hi-fi 4 tab 主体完成（simpx）
  - Loop / Focus / Chat / Context 都跑通核心交互
  - Focus 改成纯派生 view（删 archive 视图）
  - Chat tab：channel ↔ loop 双向引用
- loopat-ts spike 推进（panlilu）
  - prisma schema 完成 9 个 model
  - trpc routers 进行中
  - staging.loopat.ai 部署成功
- opencode fork spike（simpx）
  - 加完 driver / rfd 字段
  - attach SSE → ws 设计中

## 决策

- ChatMount 走 mutate（不做 versioning）
- pi.dev 否决，只剩 opencode-fork vs 自建
- 周末面对面 close 取舍

## 风险

- opencode upstream v0.7 重构 hooks，fork rebase 成本上升
- next-auth beta 的 callback 行为引起 staging 5xx 抖动`,
    backlinks: [],
  },
  "memory/spike-comparison.md": {
    frontmatter: { tags: ["memory"], updated: "1d", driver: "ai" },
    body: `# Spike Comparison

> coo 整理。两条 MVP spike 的实时对照。

| 维度 | fork opencode (simpx) | 自建 ts (panlilu) |
|---|---|---|
| 时间预估 | 3-4w | 8-12w |
| 风险 | upstream 撕裂 | 时间不够 |
| stack | TS / Tauri / SSE | Next.js / tRPC / Prisma / WS |
| driver/rfd | 加在 session metadata | 一等公民 model |
| attach | SSE → ws 改造 | 原生 ws 设计 |
| 当前进度 | driver 字段加完 | schema 完成 + staging 部署 |

## 决策建议

如果 attach 协议**两边对得上**且**Loop semantic 在 fork 上不别扭**，倾向 fork（时间窗口考虑）。
否则走 panlilu 的自建。

> 周末 simpx 出 attach spec 草稿，panlilu 验证可对齐性。`,
    backlinks: [
      { path: "research/opencode-deep-dive.md", preview: "...对照表见 [[memory/spike-comparison.md]]..." },
    ],
  },
  "meeting/2026-05-09-spike-decision.md": {
    frontmatter: { tags: ["meeting"], updated: "5h" },
    body: `# Spike 取舍 weekend session（2026-05-10）

参与：simpx · panlilu · coo (旁听 + 记录)

## 议程
1. 两条 spike 进度同步（30min）
2. attach 协议双向对齐（30min）
3. 决定 phase 2 走哪条（30min）

## 讨论点
- ChatMount 的 versioning：先 mutate，后期再加（已决）
- driver 字段位置：session metadata vs 一等 model
- workspace 隔离边界：先单 workspace，phase 4 再考虑

## 决策待办（周日定）
- [ ] 选 fork or 自建
- [ ] 写 phase 2 文档（架构选型 + 妥协）
- [ ] 各自下周开 phase 3 实现 loop`,
    backlinks: [],
  },
  "meeting/2026-05-02-kickoff.md": {
    frontmatter: { tags: ["meeting"], updated: "1w" },
    body: `# Kickoff 会议（2026-05-02）

参与：simpx · panlilu

## 决议
- 项目 codename **1001**，对外 brand **loopat.ai**
- Phase 1：高保真原型（simpx 主导，2 周）
- Phase 2：架构选型（两人各跑一条 spike，1 周内出对照）
- Phase 3-4：根据 phase 2 结论再排

## 各自分工
- **simpx**: prototype + opencode fork spike
- **panlilu**: loopat-ts 自建 spike

## 工具
- workspace = 1001
- chat = 这个 prototype 的 chat tab（先用 mock）
- knowledge / notes / personal 都放本地，git 同步`,
    backlinks: [],
  },
}

const PERSONAL_CONTENT: Record<string, DocPage> = {
  "secrets/LOOPAT_API_KEY": {
    frontmatter: { tags: ["secret"], updated: "12d" },
    body: "sk-fake-loopat-1a2b3c4d5e6f7g8h9i0j",
    backlinks: [],
  },
  "secrets/GITHUB_TOKEN": {
    frontmatter: { tags: ["secret"], updated: "1mo" },
    body: "ghp_fakeFakeFakeFakeFakeFakeFakeFake1234",
    backlinks: [],
  },
  "secrets/OPENAI_API_KEY": {
    frontmatter: { tags: ["secret"], updated: "2mo" },
    body: "sk-proj-fakeopenai-12345abcdef67890ghijkl",
    backlinks: [],
  },
  "style/voice-tone.md": {
    frontmatter: { tags: ["style"], updated: "5d" },
    body: `# Voice & Tone

中文为主，技术词保留英文（loop / context / driver 不翻）。

- 直接、不啰嗦
- 不写"让我来看看…"这种 stalling
- 代码注释只写 *why*，不解释 *what*
- 不加 emoji（除非用户主动要）`,
    backlinks: [],
  },
  "style/english-style.md": {
    frontmatter: { tags: ["style"], updated: "1mo" },
    body: `# English style

For READMEs / commit messages / public docs:

- short sentences over compound ones
- imperative mood for commits ("add x" not "added x")
- avoid hedging ("might", "perhaps") — be precise instead
- prefer Anglo-Saxon over Latinate ("use" > "utilize")`,
    backlinks: [],
  },
  "vault/1001-自己想法.md": {
    frontmatter: { tags: ["1001"], updated: "2h" },
    body: `# 1001 — 自己想法（unfiltered）

(这层就是无压力素材层 — 写完就放，没结构没归类)

- Loop 移交后的 context leak 其实不应该完全避免，反而是协作的"信号"
- Personal notes 用 obsidian + git，可能比自己造轮子靠谱
- secrets 暂时明文存，先跑起来再说；以后上 sops/age
- "knowledge distill" 这个动作要不要 AI 主动 propose？还是用户主动？倾向前者 —— 但蒸馏本身只能人来做，AI 只 propose 候选
- 三种 context source 之外，还有 "tool source" — MCP servers 之类，但这是另一轴`,
    backlinks: [],
  },
  "vault/random-2026-05-05.md": {
    frontmatter: { tags: ["random"], updated: "6h" },
    body: `# random · 2026-05-05

随手记一些片段。

- 看到 obsidian 的 backlink graph，1001 也应该有
- "Loop 是注意力的边界" — 这句话能不能写进 vision？
- chat 不属于稀缺资源轴，但 chat 仍然是最常用的接口 — 这个矛盾要怎么处理`,
    backlinks: [],
  },
  "private-todo.md": {
    frontmatter: { tags: ["personal"], updated: "1h" },
    body: `# Private todo

- [ ] 把 ccx/notes/memory 整理一下，过期的删掉
- [ ] 周末写 1001 blog 第一篇
- [ ] 报销提交
- [ ] 跟 lead 1:1 聊 Q3 重心`,
    backlinks: [],
  },
  "vault/career-thoughts.md": {
    frontmatter: { tags: ["personal"], updated: "2w" },
    body: `# Career thoughts

(完全个人，不给任何人看)

最近在想：

- 3 年内做出一个能被外界看到的"作品级"东西。1001 是候选
- 不想再做纯 backend infra，太工具化；想做 AI × 协作这种交叉
- 老板最近的 ask 跟我个人方向是 60% overlap，剩下 40% 怎么办？
- 是不是该开始有意识地做对外影响力——blog、talk`,
    backlinks: [],
  },
  "ideas/obsidian-graph-feature.md": {
    frontmatter: { tags: ["idea"], updated: "3d" },
    body: `# 想法：1001 加 obsidian-style 关系图

backlink 已经有了，下一步：

- knowledge / notes / personal 三层都进图
- 边权 = 引用次数 + 最近访问时间
- click 节点 → 跳到 path
- AI 给热门子图打标签 (e.g. "gateway 子图"、"ai-org 子图")

参考：obsidian graph view、roam research`,
    backlinks: [],
  },
  "ideas/loop-pricing-model.md": {
    frontmatter: { tags: ["idea", "biz"], updated: "1w" },
    body: `# 定价想法（脑洞）

- 个人版：免费，本地跑，personal notes 加密
- 团队版：按 active loop 数 / 月
- 企业版：on-prem + audit log + permission 系统

定价的关键是：**loop 是不是真有 work-output measurable**。如果有，按 loop 计价就成立`,
    backlinks: [],
  },
  "daily/2026-05-05.md": {
    frontmatter: { tags: ["personal", "daily"], updated: "30m" },
    body: `# 2026-05-05 (个人 daily)

## 上午
- 在跑 1001 phase1 的 Context tab
- 跟自己拉齐了"notes 是无压力素材层"这个 frame——挺关键

## 下午
- 准备晚上写 blog draft

## 杂感
- "可被 AI 检索 ≠ 沉淀"——这个洞察可能值得写一篇
- 跟 panlilu DM 里聊到 attach 协议，他偏向走 ws 而不是 SSE，我倾向同意`,
    backlinks: [],
  },
  "daily/2026-05-04.md": {
    frontmatter: { tags: ["personal", "daily"], updated: "1d" },
    body: `# 2026-05-04 (个人)

- fork opencode 起 1001 prototype，4-tab 拉通了
- Focus tab 重构感觉对了
- 晚上跟 lead 聊：他对 1001 比较支持，但希望 phase1 做完前别 over-spec
- TODO：明天把 Context tab 三层落地`,
    backlinks: [],
  },
  "daily/2026-05-03.md": {
    frontmatter: { tags: ["personal", "daily"], updated: "2d" },
    body: `# 2026-05-03 (个人)

- 跟 [[ai-org/vision.md]] 拉齐了"三种稀缺资源"哲学
- 想清楚 Focus 不是稀缺资源本身，是注意力的具象`,
    backlinks: [],
  },
  "style/code-aesthetics.md": {
    frontmatter: { tags: ["style"], updated: "3w" },
    body: `# Code aesthetics

(给 AI 看的)

- 短函数 > 长函数。但不为了短而拆，要拆出有名字的概念
- 早 return，扁平 > 嵌套
- 不写防御性代码，trust internal callers
- 注释只写 *why*，不解释 *what*
- 不做"为未来"的抽象，三遍重复才考虑抽

代码读起来像散文，不像合同。`,
    backlinks: [],
  },
  "drafts/1001-blog-part-1.md": {
    frontmatter: { tags: ["draft", "blog"], updated: "1d" },
    body: `# 1001 blog · part 1: 当 AI 是同事，工作空间该长什么样

(草稿，未发)

## 开篇

我们今天用的所有"协作工具"——Slack、Notion、Linear、Github——都是为
**人和人协作**设计的。AI 进来之后，这些工具的形状对吗？

我的判断：不对。

## 三种稀缺资源

人贡献的稀缺资源是三件事——驱动力、注意力、熵减能力。1001 围绕这
三件事建一级概念：Loop / Focus / Context。

## Loop 是基本单位

(展开...)

---

TODO: 改 hook，第一段太硬。`,
    backlinks: [],
  },
  "drafts/loop-talk-outline.md": {
    frontmatter: { tags: ["draft", "talk"], updated: "5d" },
    body: `# "Loop is everything" — talk outline

(35 min, 内部分享)

1. 现状：协作工具是给人设计的 (5min)
2. AI 同事 vs 人同事的区别 (5min)
3. Loop 模型 (10min)
4. 1001 demo (10min)
5. Q&A (5min)`,
    backlinks: [],
  },
}

const VAULT_CONTENT: Record<VaultId, Record<string, DocPage>> = {
  knowledge: KNOWLEDGE_CONTENT,
  notes: NOTES_CONTENT,
  personal: PERSONAL_CONTENT,
}

function VaultPane(props: {
  vault: VaultId
  urlPath: () => string
  onNavigate: (path: string) => void
}) {
  const meta = () => VAULT_META[props.vault]
  const docs = () => VAULT_DOCS[props.vault]
  const content = () => VAULT_CONTENT[props.vault]
  const path = () => {
    const p = props.urlPath()
    return p && findFile(docs(), p) ? p : meta().initialPath
  }
  const setPath = (p: string) => props.onNavigate(p)
  const [openFolders, setOpenFolders] = createSignal(new Set(meta().defaultOpen))
  const [overrides, setOverrides] = createSignal<Record<string, string>>({})
  const [editingPath, setEditingPath] = createSignal<string | null>(null)
  const [draftBody, setDraftBody] = createSignal<string>("")
  const toggle = (name: string) => {
    const next = new Set(openFolders())
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpenFolders(next)
  }
  const startEdit = (p: string) => {
    // secrets: start with empty buffer — old value never re-shown, save overwrites.
    const body = isSecretPath(p)
      ? ""
      : overrides()[p] ?? content()[p]?.body ?? `# ${p}\n\n_(no content yet — mock placeholder)_`
    setDraftBody(body)
    setEditingPath(p)
  }
  const saveEdit = () => {
    const p = editingPath()
    if (!p) return
    setOverrides({ ...overrides(), [p]: draftBody() })
    setEditingPath(null)
  }
  const cancelEdit = () => setEditingPath(null)
  return (
    <div class="flex h-full w-full">
      <aside class="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-9 flex items-center justify-end border-b border-gray-200">
          <button class="text-gray-500 hover:text-gray-900 p-0.5 rounded hover:bg-gray-100">
            <Icon name="magnifying-glass" />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-auto py-2">
          <For each={docs()}>
            {(node) => (
              <DocTreeNode
                node={node}
                depth={0}
                selected={path}
                onSelect={(p) => {
                  if (editingPath()) cancelEdit()
                  setPath(p)
                }}
                openFolders={openFolders}
                toggleFolder={toggle}
              />
            )}
          </For>
        </div>
        <div class="px-3 h-9 border-t border-gray-200 flex items-center text-[11px] text-gray-500 gap-2">
          <span>{meta().footer}</span>
        </div>
      </aside>
      <main class="flex-1 min-w-0 flex flex-col bg-white">
        <DocView
          vault={props.vault}
          path={path()}
          onSelect={setPath}
          content={content()}
          overrides={overrides}
          editingPath={editingPath}
          draftBody={draftBody}
          setDraftBody={setDraftBody}
          startEdit={startEdit}
          saveEdit={saveEdit}
          cancelEdit={cancelEdit}
        />
      </main>
    </div>
  )
}

function findFile(nodes: DocNode[], path: string): boolean {
  for (const n of nodes) {
    if (n.kind === "file" && n.path === path) return true
    if (n.kind === "folder" && findFile(n.children, path)) return true
  }
  return false
}

function isSecretPath(path: string): boolean {
  return path.startsWith("secrets/")
}

function DocTreeNode(props: {
  node: DocNode
  depth: number
  selected: () => string
  onSelect: (path: string) => void
  openFolders: () => Set<string>
  toggleFolder: (name: string) => void
}) {
  if (props.node.kind === "folder") {
    const opened = () => props.openFolders().has(props.node.name)
    const folder = props.node
    return (
      <>
        <button
          type="button"
          class={
            folder.marker === "ai-write"
              ? "w-full py-1 flex items-center gap-1 hover:bg-cyan-50/70 text-left bg-cyan-50/40"
              : "w-full py-1 flex items-center gap-1 hover:bg-gray-50 text-left"
          }
          style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
          onClick={() => props.toggleFolder(folder.name)}
        >
          <Icon name={opened() ? "chevron-down" : "chevron-right"} class="text-gray-500" />
          <Show
            when={folder.marker === "secrets"}
            fallback={<Icon name="folder" class="text-gray-500" />}
          >
            <span class="text-[12px]">🔐</span>
          </Show>
          <span
            class={
              folder.marker === "ai-write"
                ? "text-[13px] text-cyan-900 font-medium"
                : "text-[13px] text-gray-900"
            }
          >
            {folder.name}
          </span>
          <Show when={folder.marker === "ai-write"}>
            <span class="ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800">
              ai
            </span>
          </Show>
        </button>
        <Show when={opened()}>
          <For each={folder.children}>
            {(child) => (
              <DocTreeNode
                node={child}
                depth={props.depth + 1}
                selected={props.selected}
                onSelect={props.onSelect}
                openFolders={props.openFolders}
                toggleFolder={props.toggleFolder}
              />
            )}
          </For>
        </Show>
      </>
    )
  }
  const file = props.node
  const sel = () => props.selected() === file.path
  return (
    <button
      type="button"
      class={
        sel()
          ? "w-full py-1 flex items-center gap-2 text-left bg-gray-100"
          : "w-full py-1 flex items-center gap-2 text-left hover:bg-gray-50"
      }
      style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
      onClick={() => props.onSelect(file.path)}
    >
      <span class="w-4" />
      <Show when={file.secret} fallback={<Icon name="file-tree" class="text-gray-500 shrink-0" />}>
        <span class="text-amber-600 shrink-0 text-[12px]" title="secret · 仅可注入">🔒</span>
      </Show>
      <span class="flex-1 min-w-0 truncate text-[13px] text-gray-900">{file.name}</span>
      {file.updatedAgo && <span class="text-[11px] text-gray-500">{file.updatedAgo}</span>}
    </button>
  )
}

function DocView(props: {
  vault: VaultId
  path: string
  onSelect: (path: string) => void
  content: Record<string, DocPage>
  overrides: () => Record<string, string>
  editingPath: () => string | null
  draftBody: () => string
  setDraftBody: (v: string) => void
  startEdit: (p: string) => void
  saveEdit: () => void
  cancelEdit: () => void
}) {
  const navigate = useNavigate()
  const page = (): DocPage => {
    const base = props.content[props.path] ?? {
      frontmatter: {},
      body: `# ${props.path}\n\n_(no content yet — mock placeholder)_`,
      backlinks: [],
    }
    const overlay = props.overrides()[props.path]
    return overlay !== undefined ? { ...base, body: overlay } : base
  }
  const isEditing = () => props.editingPath() === props.path
  const isSecret = () => isSecretPath(props.path)
  const allowDirectEdit = () => props.vault !== "knowledge"
  const allowLoopEdit = () => !isSecret()
  const allowDistill = () => props.vault === "notes" && !isSecret()
  const bodyWithLinks = () => {
    const body = page().body
    return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, p, alias) => {
      const label = alias ?? p
      return `[${label}](#wiki:${p})`
    })
  }
  const handleEditByLoop = () => {
    const id = createEditLoop(props.path)
    navigate(`/loop/${id}`)
  }
  const handleDistill = () => {
    const id = createDistillLoop(props.path)
    navigate(`/loop/${id}`)
  }
  return (
    <>
      <header class="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[13px]">
          <Show when={isSecret()} fallback={<Icon name="file-tree" class="text-gray-500" />}>
            <span class="text-amber-600">🔒</span>
          </Show>
          <span class="text-gray-500">{props.path}</span>
          <Show when={props.overrides()[props.path] !== undefined && !isEditing()}>
            <span class="text-[11px] text-orange-600" title="locally edited">●</span>
          </Show>
        </div>
        <div class="flex items-center gap-2 text-xs text-gray-500">
          <Show when={isEditing()}>
            <button
              type="button"
              onClick={() => props.cancelEdit()}
              class="px-2.5 h-7 rounded text-xs text-gray-600 hover:bg-gray-100"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => props.saveEdit()}
              class="px-2.5 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700"
            >
              save
            </button>
          </Show>
          <Show when={!isEditing() && allowDistill()}>
            <button
              type="button"
              onClick={handleDistill}
              class="px-2.5 h-7 rounded text-xs bg-amber-100 text-amber-900 hover:bg-amber-200 flex items-center gap-1"
              title="open a loop to distill this notes file into knowledge — entropy reduction is human work"
            >
              <span>↑</span>
              <span>distill</span>
            </button>
          </Show>
          <Show when={!isEditing() && allowLoopEdit()}>
            <button
              type="button"
              onClick={handleEditByLoop}
              class={
                allowDistill()
                  ? "px-2.5 h-7 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-900 flex items-center gap-1"
                  : "px-2.5 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700 flex items-center gap-1"
              }
              title="open a new loop with AI assist for this file"
            >
              <span>↻</span>
              <span>edit by loop</span>
            </button>
          </Show>
          <Show when={!isEditing() && allowDirectEdit()}>
            <button
              type="button"
              onClick={() => props.startEdit(props.path)}
              class="px-2.5 h-7 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-900"
              title="direct edit (fastpath)"
            >
              edit
            </button>
          </Show>
        </div>
      </header>
      <Show when={isEditing()}>
        <div class="flex-1 min-h-0 min-w-0 flex">
          <div class="flex-1 min-w-0 min-h-0 border-r border-gray-200 flex flex-col">
            <div class="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
              source · markdown
            </div>
            <div class="flex-1 min-h-0">
              <CodeEditor
                path={props.path}
                value={props.draftBody()}
                onChange={(v) => props.setDraftBody(v)}
              />
            </div>
          </div>
          <div class="flex-1 min-w-0 min-h-0 flex flex-col">
            <div class="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
              preview
            </div>
            <div class="flex-1 min-h-0 overflow-auto px-6 py-4">
              <div class="max-w-[760px]">
                <Markdown text={props.draftBody()} />
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={!isEditing()}>
      <div class="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <article
          class="flex-1 min-h-0 overflow-auto px-8 py-6"
          onClick={(e) => {
            const target = (e.target as HTMLElement).closest("a")
            if (!target) return
            const href = target.getAttribute("href") ?? ""
            if (href.startsWith("#wiki:")) {
              e.preventDefault()
              props.onSelect(href.slice(6))
            }
          }}
        >
          <Show when={page().frontmatter.tags?.length || page().frontmatter.driver}>
            <div class="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
              <Show when={page().frontmatter.driver}>
                <span class="flex items-center gap-1">
                  <span class="w-2 h-2 rounded-full bg-emerald-500" />
                  <span>{page().frontmatter.driver}</span>
                </span>
              </Show>
              <Show when={page().frontmatter.updated}>
                <span>updated {page().frontmatter.updated}</span>
              </Show>
              <For each={page().frontmatter.tags ?? []}>
                {(tag) => <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-900">#{tag}</span>}
              </For>
            </div>
          </Show>
          <div class="max-w-[760px]">
            <Show
              when={!isSecret()}
              fallback={
                <div class="font-mono text-[14px] text-gray-400 select-none">
                  ••••••••••••••••••••••••
                  <div class="mt-2 text-[12px] not-italic text-gray-500 font-sans">
                    点 edit 编辑（值不显示）
                  </div>
                </div>
              }
            >
              <Markdown text={bodyWithLinks()} />
            </Show>
          </div>
        </article>
        <aside class="w-64 shrink-0 border-l border-gray-200 bg-gray-50 overflow-auto">
          <div class="px-3 h-9 flex items-center border-b border-gray-200">
            <span class="text-[11px] text-gray-500">Backlinks</span>
            <span class="ml-auto text-[11px] text-gray-500">{page().backlinks.length}</span>
          </div>
          <Show
            when={page().backlinks.length > 0}
            fallback={
              <div class="px-3 py-4 text-xs text-gray-500">No documents link here yet.</div>
            }
          >
            <ul class="py-2">
              <For each={page().backlinks}>
                {(b) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => props.onSelect(b.path)}
                      class="w-full px-3 py-2 text-left hover:bg-gray-100"
                    >
                      <div class="text-xs font-medium text-gray-900 truncate">{b.path}</div>
                      <div class="text-[11px] text-gray-500 mt-0.5 leading-snug line-clamp-2">{b.preview}</div>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </aside>
      </div>
      </Show>
    </>
  )
}

// ============================================================================
// Agents
// ============================================================================

export type Agent = {
  id: string
  name: string
  emoji: string
  charter: string
  status: "running" | "idle" | "error"
  runsOn: string
  tools: string[]
  subscribesTo: string[]
  trigger: "mention" | "schedule" | "event"
  lastActivityAgo: string
  systemPrompt: string
  recentInvocations: { when: string; channel: string; preview: string }[]
}

export const AGENTS: Agent[] = [
  {
    id: "coo",
    name: "coo",
    emoji: "🎩",
    charter:
      "Team's secretary. Channel triage + context distill + loop spawn. 任何成员都可以 DM 它问问题、让它整理、让它创建 loop。",
    status: "running",
    runsOn: "loopat staging · python loop · since 2026-04-19",
    tools: ["chat.read", "chat.post", "loop.create", "focus.update", "knowledge.write", "loop.read"],
    subscribesTo: ["#all", "#dev", "#ops"],
    trigger: "mention",
    lastActivityAgo: "12m",
    systemPrompt:
      "你是 coo，1001 团队的秘书。任务：1）整理混乱（chat → loop / knowledge）2）回答信息检索类问题 3）被 @ 时 spawn loop。简洁、不啰嗦。\n\n规则：\n- 听到讨论开始变深入，主动 dm 当事人建议 spawn loop\n- 重大决策同步进 knowledge/loopat/ 对应文档的'已决问题'段\n- 不主动评价，只整理 + 引用",
    recentInvocations: [
      { when: "12m", channel: "dm-simpx", preview: "Pulled panlilu's #dev message at 15:02 about prisma schema..." },
      { when: "26m", channel: "#dev", preview: "记到 knowledge/loopat/architecture.md 的'已决问题'段" },
      { when: "2h", channel: "#all", preview: "@simpx 同步 panlilu trpc routers 进展到 #all 摘要" },
      { when: "8h", channel: "memory/", preview: "✓ generated weekly-snapshot-2026-05-09.md" },
    ],
  },
  {
    id: "ops-bot",
    name: "ops-bot",
    emoji: "🛠",
    charter:
      "Watches loopat.ai uptime. Deploys staging / prod on push. Pages on 5xx spike, latency degradation, or build failure. Spawns rfd-loops for unclaimed incidents.",
    status: "running",
    runsOn: "github actions + cloudflare workers · since 2026-05-02",
    tools: ["sls.query", "chat.post", "loop.create", "deploy.trigger", "rollback.trigger"],
    subscribesTo: ["#dev", "#ops"],
    trigger: "event",
    lastActivityAgo: "8m",
    systemPrompt:
      "Monitor metrics + deployment. Be quiet when normal. On anomaly, post structured alert to #ops; if no human claims in 10min, also @simpx in #dev. Always include grafana link + suggest rollback if recent deploy.",
    recentInvocations: [
      { when: "8m", channel: "#ops", preview: "🚨 5xx spike on loopat.ai (342 errors / 7min) — spawn site-uptime-spike rfd loop" },
      { when: "26m", channel: "#dev", preview: "🚀 deploy: panlilu/loopat-ts main → staging (87s)" },
      { when: "1d", channel: "#ops", preview: "📊 weekly site report: uptime 99.94%, p99 142ms" },
    ],
  },
  {
    id: "growth-bot",
    name: "growth-bot",
    emoji: "📡",
    charter:
      "Watches HN / Twitter / Reddit / Producthunt for 'AI org' / 'AI for teams' / 'loop / focus' related discussions. Posts daily digest to #all. Tracks loopat.ai mentions and signups.",
    status: "running",
    runsOn: "cron @ 09:00, 17:00 · ergo host",
    tools: ["hn.search", "twitter.search", "reddit.search", "chat.post", "knowledge.read"],
    subscribesTo: ["#all"],
    trigger: "schedule",
    lastActivityAgo: "2h",
    systemPrompt:
      "Track discussions about AI organization, team productivity tools, loop / focus / context concepts. Filter signal from noise. Post 3-5 most relevant items per digest. Skip if nothing interesting.",
    recentInvocations: [
      {
        when: "2h",
        channel: "#all",
        preview: "📡 'show hn: a unified todo + chat hybrid' (37pts/12c) — overlap with our Loop / Focus 哲学",
      },
      { when: "8h", channel: "#all", preview: "📡 daily digest: 2 mentions of 'AI org', 0 loopat.ai signups today" },
      { when: "1d", channel: "#all", preview: "📡 reddit /r/programming: 'why slack channels rot' — relevant to our spawn-from-chat skill" },
    ],
  },
]

function AgentsPane(props: { urlId: () => string; onNavigate: (id: string) => void }) {
  const selectedId = () =>
    AGENTS.find((a) => a.id === props.urlId())?.id ?? "coo"
  const setSelected = (id: string) => props.onNavigate(id)
  const current = () => AGENTS.find((a) => a.id === selectedId()) ?? AGENTS[0]
  return (
    <div class="flex h-full w-full">
      <aside class="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-9 flex items-center justify-between border-b border-gray-200">
          <span class="text-[11px] text-gray-500">agents</span>
          <button class="text-gray-500 hover:text-gray-900 p-0.5 rounded hover:bg-gray-100">
            <Icon name="enter" />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-auto py-2">
          <For each={AGENTS}>
            {(agent) => {
              const sel = () => selectedId() === agent.id
              return (
                <button
                  type="button"
                  onClick={() => setSelected(agent.id)}
                  class={
                    sel()
                      ? "w-full px-3 py-2 flex items-center gap-2 text-left bg-gray-100"
                      : "w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                  }
                >
                  <span class="text-[15px] shrink-0">{agent.emoji}</span>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] text-gray-900 truncate">{agent.name}</div>
                    <div class="text-[11px] text-gray-500 truncate flex items-center gap-1.5">
                      <span
                        class={
                          agent.status === "running"
                            ? "w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500"
                            : agent.status === "error"
                              ? "w-1.5 h-1.5 rounded-full shrink-0 bg-red-500"
                              : "w-1.5 h-1.5 rounded-full shrink-0 bg-gray-300"
                        }
                      />
                      <span>{agent.lastActivityAgo}</span>
                    </div>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
        <button class="m-3 px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-xs text-gray-500 hover:text-gray-900 flex items-center gap-2">
          <Icon name="enter" />
          <span>new agent</span>
        </button>
      </aside>

      <main class="flex-1 min-w-0 flex flex-col bg-white overflow-auto">
        <header class="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center gap-2">
          <span class="text-[15px]">{current().emoji}</span>
          <span class="text-[15px] font-medium text-gray-900">{current().name}</span>
          <span
            class={
              current().status === "error"
                ? "text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-red-600"
                : current().status === "running"
                  ? "text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-900"
                  : "text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"
            }
          >
            {current().status}
          </span>
          <span class="ml-auto text-xs text-gray-500">last activity {current().lastActivityAgo}</span>
        </header>

        <div class="flex-1 min-h-0 overflow-auto px-8 py-6 max-w-[860px]">
          <section class="mb-6">
            <p class="text-[13px] text-gray-900 leading-relaxed">{current().charter}</p>
          </section>

          <section class="mb-6 grid grid-cols-2 gap-4">
            <Card label="runs on">
              <span class="text-[13px] text-gray-900">{current().runsOn}</span>
            </Card>
            <Card label="trigger">
              <span class="text-[13px] text-gray-900">{current().trigger}</span>
            </Card>
            <Card label="tools">
              <div class="flex flex-wrap gap-1">
                <For each={current().tools}>
                  {(t) => (
                    <span class="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-900 font-mono">{t}</span>
                  )}
                </For>
              </div>
            </Card>
            <Card label="subscribed to">
              <div class="flex flex-wrap gap-1">
                <For each={current().subscribesTo}>
                  {(c) => <span class="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-900">{c}</span>}
                </For>
              </div>
            </Card>
          </section>

          <section class="mb-6">
            <h3 class="text-[13px] font-medium text-gray-900 mb-2">system prompt</h3>
            <div class="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 whitespace-pre-wrap leading-relaxed font-mono">
              {current().systemPrompt}
            </div>
            <button class="mt-2 text-[11px] text-gray-500 hover:text-gray-900">edit prompt</button>
          </section>

          <section>
            <h3 class="text-[13px] font-medium text-gray-900 mb-2">recent invocations</h3>
            <ul class="flex flex-col gap-1">
              <For each={current().recentInvocations}>
                {(inv) => (
                  <li class="px-3 py-2 rounded hover:bg-gray-50 flex items-start gap-3 text-[13px]">
                    <span class="text-[11px] text-gray-500 shrink-0 mt-0.5">{inv.when}</span>
                    <span class="text-[11px] text-gray-900 shrink-0 mt-0.5">{inv.channel}</span>
                    <span class="text-gray-900 flex-1 min-w-0 truncate">{inv.preview}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </div>
      </main>
    </div>
  )
}

function Card(props: { label: string; children: any }) {
  return (
    <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
      <div class="text-[11px] text-gray-500 mb-1">{props.label}</div>
      <div>{props.children}</div>
    </div>
  )
}

// ============================================================================
// Repos
// ============================================================================

export type Repo = {
  id: string
  name: string
  remote: string
  branch: string
  status: "online" | "offline"
  recentLoops: { name: string; branch: string; driver: string; ago: string }[]
  readme: string
}

export const REPOS: Repo[] = [
  {
    id: "loopat",
    name: "loopat",
    remote: "github.com/simpx/loopat",
    branch: "main",
    status: "online",
    recentLoops: [
      { name: "prototype-hifi", branch: "main", driver: "simpx", ago: "just now" },
      { name: "loopat-runtime-spike", branch: "feat/runtime-spike", driver: "simpx", ago: "1h" },
      { name: "loopat-ts-mvp", branch: "main", driver: "panlilu", ago: "26m" },
    ],
    readme:
      "# loopat\n\nThe team's home repo. Contains:\n\n- `phase1-prototype/` — 高保真原型（Vite + Solid + Tailwind）\n- `1001-mvp.md` — 内部 MVP 工作文档\n- `1001-story.md` — 对外故事\n- `thoughts/` — 早期思考脉络\n- `loopat-ts/` — panlilu 的自建 spike (将合入)\n\n## Phase\n\n- [x] Phase 1: hi-fi prototype\n- [ ] Phase 2: 架构选型 (opencode-fork vs 自建 ts spike, 周末 close)\n- [ ] Phase 3: 0.1 单人版\n- [ ] Phase 4: 0.2 多人协作",
  },
]

function ReposPane(props: { urlId: () => string; onNavigate: (id: string) => void }) {
  const selectedId = () =>
    REPOS.find((r) => r.id === props.urlId())?.id ?? "loopat"
  const setSelected = (id: string) => props.onNavigate(id)
  const current = () => REPOS.find((r) => r.id === selectedId()) ?? REPOS[0]
  return (
    <div class="flex h-full w-full">
      <aside class="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-9 flex items-center justify-between border-b border-gray-200">
          <span class="text-[11px] text-gray-500">repos</span>
          <button class="text-gray-500 hover:text-gray-900 p-0.5 rounded hover:bg-gray-100">
            <Icon name="enter" />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-auto py-2">
          <For each={REPOS}>
            {(repo) => {
              const sel = () => selectedId() === repo.id
              return (
                <button
                  type="button"
                  onClick={() => setSelected(repo.id)}
                  class={
                    sel()
                      ? "w-full px-3 py-2 flex items-center gap-2 text-left bg-gray-100"
                      : "w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                  }
                >
                  <span
                    class={
                      repo.status === "online"
                        ? "w-2 h-2 rounded-full shrink-0 bg-emerald-500"
                        : "w-2 h-2 rounded-full shrink-0 bg-gray-300"
                    }
                  />
                  <span class="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{repo.name}</span>
                </button>
              )
            }}
          </For>
        </div>
        <button class="m-3 px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-xs text-gray-500 hover:text-gray-900 flex items-center gap-2">
          <Icon name="enter" />
          <span>add repo</span>
        </button>
      </aside>
      <main class="flex-1 min-w-0 flex flex-col bg-white">
        <RepoView repo={current()} />
      </main>
    </div>
  )
}

function RepoView(props: { repo: Repo }) {
  return (
    <>
      <header class="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[13px]">
          <span
            class={
              props.repo.status === "online"
                ? "w-2 h-2 rounded-full bg-emerald-500"
                : "w-2 h-2 rounded-full bg-gray-300"
            }
          />
          <span class="text-gray-900 font-medium">{props.repo.name}</span>
          <span class="text-gray-500">· {props.repo.remote}</span>
        </div>
        <div class="text-xs text-gray-500">default branch: {props.repo.branch}</div>
      </header>
      <article class="flex-1 min-h-0 overflow-auto px-8 py-6 max-w-[820px]">
        <section class="mb-6">
          <h3 class="text-[13px] font-medium text-gray-900 mb-2">Recent loops on this repo</h3>
          <Show
            when={props.repo.recentLoops.length > 0}
            fallback={<p class="text-[13px] text-gray-500">No active loops yet.</p>}
          >
            <ul class="flex flex-col gap-1">
              <For each={props.repo.recentLoops}>
                {(loop) => (
                  <li class="px-3 py-2 rounded hover:bg-gray-100 flex items-center gap-3 text-[13px]">
                    <Icon name="fork" class="text-gray-500" />
                    <span class="text-gray-900">{loop.name}</span>
                    <span class="text-gray-500">{loop.branch}</span>
                    <span class="text-gray-500 ml-auto">
                      {loop.driver} · {loop.ago}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <button class="mt-3 px-3 py-1.5 rounded bg-gray-200 text-gray-900 text-xs hover:bg-gray-300 flex items-center gap-2">
            <Icon name="enter" />
            <span>spawn new loop on a branch</span>
          </button>
        </section>
        <section>
          <h3 class="text-[13px] font-medium text-gray-900 mb-2">README</h3>
          <div class="max-w-[760px]">
            <Markdown text={props.repo.readme} />
          </div>
        </section>
      </article>
    </>
  )
}
