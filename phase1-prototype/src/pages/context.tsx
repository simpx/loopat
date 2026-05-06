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
import { createEditLoop, createPromoteLoop } from "../state"

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
        <span class="text-xs text-gray-500 mr-2">Context</span>
        <span class="w-px h-4 bg-gray-200 mx-2" />
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
    name: "loop",
    children: [
      { kind: "file", name: "overview.md", path: "loop/overview.md", updatedAgo: "2h" },
      { kind: "file", name: "lifecycle.md", path: "loop/lifecycle.md", updatedAgo: "1d" },
      { kind: "file", name: "rfd-and-claim.md", path: "loop/rfd-and-claim.md", updatedAgo: "4d" },
    ],
  },
  {
    kind: "folder",
    name: "ai-org",
    children: [
      { kind: "file", name: "vision.md", path: "ai-org/vision.md", updatedAgo: "5d" },
      { kind: "file", name: "1001-philosophy.md", path: "ai-org/1001-philosophy.md", updatedAgo: "3d" },
      { kind: "file", name: "three-scarce-resources.md", path: "ai-org/three-scarce-resources.md", updatedAgo: "1w" },
    ],
  },
  {
    kind: "folder",
    name: "gateway",
    children: [
      { kind: "file", name: "cache-strategies.md", path: "gateway/cache-strategies.md", updatedAgo: "1w" },
      { kind: "file", name: "rdma-mr-register.md", path: "gateway/rdma-mr-register.md", updatedAgo: "2w" },
    ],
  },
  {
    kind: "folder",
    name: "ml",
    children: [
      { kind: "file", name: "long-context-techniques.md", path: "ml/long-context-techniques.md", updatedAgo: "3w" },
      { kind: "file", name: "speculative-decoding.md", path: "ml/speculative-decoding.md", updatedAgo: "1mo" },
    ],
  },
  {
    kind: "folder",
    name: "conventions",
    children: [
      { kind: "file", name: "git-style.md", path: "conventions/git-style.md", updatedAgo: "2mo" },
      { kind: "file", name: "code-style-go.md", path: "conventions/code-style-go.md", updatedAgo: "2mo" },
      { kind: "file", name: "code-style-python.md", path: "conventions/code-style-python.md", updatedAgo: "2mo" },
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
        name: "promote-to-knowledge",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/promote-to-knowledge/SKILL.md", updatedAgo: "5d" },
        ],
      },
      {
        kind: "folder",
        name: "code-review-checklist",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/code-review-checklist/SKILL.md", updatedAgo: "2w" },
          { kind: "file", name: "examples.md", path: "skills/code-review-checklist/examples.md", updatedAgo: "2w" },
        ],
      },
      {
        kind: "folder",
        name: "incident-triage",
        children: [
          { kind: "file", name: "SKILL.md", path: "skills/incident-triage/SKILL.md", updatedAgo: "1mo" },
          { kind: "file", name: "runbook-template.md", path: "skills/incident-triage/runbook-template.md", updatedAgo: "1mo" },
          { kind: "file", name: "grafana-cheatsheet.md", path: "skills/incident-triage/grafana-cheatsheet.md", updatedAgo: "1mo" },
        ],
      },
    ],
  },
]

// ----- Notes: team · public; 任何人 / AI 都可以写入 -----
const NOTES_DOCS: DocNode[] = [
  {
    kind: "folder",
    name: "memory",
    marker: "ai-write",
    children: [
      { kind: "file", name: "team-conventions-2026-05.md", path: "memory/team-conventions-2026-05.md", updatedAgo: "3h" },
      { kind: "file", name: "1001-design-snapshot.md", path: "memory/1001-design-snapshot.md", updatedAgo: "1d" },
      { kind: "file", name: "llama-3-rollout-status.md", path: "memory/llama-3-rollout-status.md", updatedAgo: "5h" },
    ],
  },
  {
    kind: "folder",
    name: "todo",
    children: [
      { kind: "file", name: "active.md", path: "todo/active.md", updatedAgo: "30m" },
      { kind: "file", name: "blocked.md", path: "todo/blocked.md", updatedAgo: "2d" },
      { kind: "file", name: "this-week.md", path: "todo/this-week.md", updatedAgo: "1d" },
    ],
  },
  {
    kind: "folder",
    name: "meeting",
    children: [
      { kind: "file", name: "2026-05-05-standup.md", path: "meeting/2026-05-05-standup.md", updatedAgo: "5h" },
      { kind: "file", name: "2026-05-04-arch-review.md", path: "meeting/2026-05-04-arch-review.md", updatedAgo: "1d" },
      { kind: "file", name: "2026-05-02-quarterly-plan.md", path: "meeting/2026-05-02-quarterly-plan.md", updatedAgo: "3d" },
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
      { kind: "file", name: "LOOPEY_API_KEY", path: "secrets/LOOPEY_API_KEY", secret: true, updatedAgo: "12d" },
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
    initialPath: "ai-org/vision.md",
    defaultOpen: ["loop", "ai-org", "gateway", "conventions", "skills"],
    footer: "team's distilled materials",
  },
  notes: {
    initialPath: "memory/team-conventions-2026-05.md",
    defaultOpen: ["memory", "meeting"],
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
  "skills/promote-to-knowledge/SKILL.md": {
    frontmatter: { title: "Promote to Knowledge", tags: ["skill"], updated: "5d" },
    body: `---
name: promote-to-knowledge
description: 把 notes / loop 产物里成熟的内容沉淀进 knowledge
trigger: ai-suggest
---

# Promote to Knowledge

## 何时触发

AI 看到一段 notes 内容反复被引用、被多个 loop 命中、被 backlink 多次——提示用户考虑 promote。

## 评估清单

- [ ] 内容稳定（最近 30d 修改 < 2 次）
- [ ] 跨 loop 适用（不是某 loop 局部知识）
- [ ] 有结构（标题、段落、能被引用）
- [ ] 用户认为值得沉淀

## 动作

- 选目标路径（loop/ / ai-org/ / gateway/ / ml/ / conventions/ / skills/）
- 必要时 reorg、加 frontmatter、补 backlinks
- commit \`docs(knowledge): promote <topic> from notes\``,
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
}

const NOTES_CONTENT: Record<string, DocPage> = {
  "memory/team-conventions-2026-05.md": {
    frontmatter: { tags: ["memory"], updated: "3h", driver: "ai" },
    body: `# Team conventions (2026-05 snapshot)

> AI 自主整理。从最近 30d 的 loop 行为里观察到的隐性约定。

- **Loop 命名** 用 kebab-case（gateway-launch、llama-research），不混 camelCase
- **commit 信息** 第一行 ≤ 60 字符，type: scope: subject 风格
- **CHANGELOG.md** 一律放仓库根目录，按 Unreleased / [version] 分段
- **Deprecation** 通过 \`internal/deprecation\` 包做 runtime warn，不靠 README
- **Knowledge promote** 来自 loop 时，AI 会主动建议路径而不是用户选`,
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
- 阻塞：需要 loopey-runtime repo 写权限确认

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
- **M2** (6月中) — Knowledge 自动 promote 跑通
- **M3** (7月) — 多人 loop 协作压测`,
    backlinks: [],
  },
}

const PERSONAL_CONTENT: Record<string, DocPage> = {
  "secrets/LOOPEY_API_KEY": {
    frontmatter: { tags: ["secret"], updated: "12d" },
    body: "sk-fake-loopey-1a2b3c4d5e6f7g8h9i0j",
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
- "knowledge promote" 这个动作要不要 AI 主动 propose？还是用户主动？倾向前者
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
- 团队 standup 里 [[meeting/2026-05-05-standup.md]] 提到的 NUMA 阻塞，跟阿尔萨斯私聊一下能不能我帮忙申请权限`,
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
        <div class="px-3 h-9 flex items-center justify-between border-b border-gray-200">
          <span class="text-[11px] text-gray-500">files</span>
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
  const allowPromote = () => props.vault === "notes" && !isSecret()
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
  const handlePromote = () => {
    const id = createPromoteLoop(props.path)
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
          <Show when={!isEditing() && allowPromote()}>
            <button
              type="button"
              onClick={handlePromote}
              class="px-2.5 h-7 rounded text-xs bg-amber-100 text-amber-900 hover:bg-amber-200 flex items-center gap-1"
              title="open a loop to promote this notes file into knowledge"
            >
              <span>↑</span>
              <span>promote</span>
            </button>
          </Show>
          <Show when={!isEditing() && allowLoopEdit()}>
            <button
              type="button"
              onClick={handleEditByLoop}
              class={
                allowPromote()
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

type Agent = {
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

const AGENTS: Agent[] = [
  {
    id: "coo-bot",
    name: "coo-bot",
    emoji: "🤖",
    charter:
      "Channel triage + work attribution. Reads chat traffic, routes summaries to the right loop / focus, creates loops for serious-looking discussions.",
    status: "running",
    runsOn: "ergo host · python loop · since 2026-04-19",
    tools: ["chat.read", "chat.post", "loop.create", "focus.update"],
    subscribesTo: ["#general", "#gateway-launch", "#1001-design", "#turbo-quant"],
    trigger: "mention",
    lastActivityAgo: "14m",
    systemPrompt:
      "你是 coo-bot，团队的运营官。当被 @ 或检测到讨论开始变深入，主动建议 spawn loop 并归类到 focus。简洁、不啰嗦。",
    recentInvocations: [
      { when: "14m", channel: "#gateway-launch", preview: "✓ 已创建 loop gateway-rdma-fix · driver: simpx" },
      { when: "2h", channel: "#general", preview: "📋 周一站会 reminder · 9:30 · #standup" },
      { when: "1d", channel: "#gateway-launch", preview: "已分析 trace.log（120k 行），mr_register 平均..." },
    ],
  },
  {
    id: "daily-digest",
    name: "daily-digest",
    emoji: "📰",
    charter: "每天早上 9 点发送昨日 channel 摘要到 #general，整理跨 channel 的关键讨论与 loop 进展。",
    status: "idle",
    runsOn: "cron @ 09:00 · 1001 cloud",
    tools: ["chat.read", "chat.post", "focus.read", "loop.read"],
    subscribesTo: ["#general"],
    trigger: "schedule",
    lastActivityAgo: "8h",
    systemPrompt:
      "Generate a 5-bullet digest of yesterday's significant activity across all channels. Skip noise. Highlight: closed loops, new pinned focus, blocking issues.",
    recentInvocations: [
      { when: "8h", channel: "#general", preview: "📊 昨日摘要：3 个 loop 推进，1 个 close（loopctl-deploy），..." },
      { when: "1d8h", channel: "#general", preview: "📊 昨日摘要：gateway trace 上传，rdma-fix loop spawn..." },
    ],
  },
  {
    id: "gateway-monitor",
    name: "gateway-monitor",
    emoji: "📈",
    charter:
      "Watch SLS metrics for KV cache services. Page on cache hit rate < 70% or RDMA register failure rate > 1%.",
    status: "running",
    runsOn: "k8s · loopey cluster · 2 replicas",
    tools: ["sls.query", "chat.post", "loop.create"],
    subscribesTo: ["#gateway-launch"],
    trigger: "event",
    lastActivityAgo: "3h",
    systemPrompt:
      "Monitor metrics. Be quiet when normal. When abnormal, post a structured alert and suggest a loop if recovery isn't auto.",
    recentInvocations: [
      { when: "3h", channel: "#gateway-launch", preview: "⚠ rdma_register fail rate 1.8% (last 5min) — see grafana" },
      { when: "1d", channel: "#gateway-launch", preview: "✓ all green for 24h" },
    ],
  },
  {
    id: "pr-reviewer",
    name: "pr-reviewer",
    emoji: "🔍",
    charter:
      "Auto-review PRs against team's coding standards (from knowledge/coding-style.md). Comments on github + posts summary to relevant channel.",
    status: "error",
    runsOn: "github actions · disabled (auth expired 2d ago)",
    tools: ["github.read", "github.comment", "chat.post"],
    subscribesTo: ["#general"],
    trigger: "event",
    lastActivityAgo: "2d",
    systemPrompt: "...",
    recentInvocations: [{ when: "2d", channel: "#general", preview: "❌ auth token expired, please re-authorize" }],
  },
]

function AgentsPane(props: { urlId: () => string; onNavigate: (id: string) => void }) {
  const selectedId = () =>
    AGENTS.find((a) => a.id === props.urlId())?.id ?? "coo-bot"
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
    id: "loopey-runtime",
    name: "loopey-runtime",
    remote: "git.example.com/.../loopey-runtime",
    branch: "main",
    status: "online",
    recentLoops: [
      { name: "gateway-launch", branch: "feat/gateway", driver: "阿尔萨斯", ago: "14m" },
      { name: "rdma-fix", branch: "feat/rdma-fix", driver: "simpx", ago: "2h" },
    ],
    readme:
      "# loopey-runtime\n\n推理服务主仓。包含 LLM serving runtime、scheduler、MaaS API 等。\n\n关键模块：\n- runtime/    LLM 推理\n- scheduler/  请求调度\n- api/        RESTful + RPC 入口",
  },
  {
    id: "vllm",
    name: "vllm",
    remote: "github.com/vllm-project/vllm",
    branch: "main",
    status: "online",
    recentLoops: [{ name: "kvcache-trace", branch: "kvcache-trace", driver: "simpx", ago: "1w" }],
    readme:
      "# vllm\n\nA high-throughput and memory-efficient inference engine for LLMs.\n\n本地 fork 用于 KV cache 实验和 PD 适配。",
  },
  {
    id: "1001",
    name: "1001",
    remote: "(local only)",
    branch: "main",
    status: "online",
    recentLoops: [{ name: "1001-design", branch: "main", driver: "simpx", ago: "26m" }],
    readme: "# 1001\n\nAI 协作系统的设计仓。本地思考 + blog 系列源材料。",
  },
  {
    id: "openclaw",
    name: "openclaw",
    remote: "github.com/openclaw/openclaw",
    branch: "main",
    status: "offline",
    recentLoops: [],
    readme: "# openclaw\n\n多 channel personal AI gateway。已评估，暂不采用。",
  },
]

function ReposPane(props: { urlId: () => string; onNavigate: (id: string) => void }) {
  const selectedId = () =>
    REPOS.find((r) => r.id === props.urlId())?.id ?? "loopey-runtime"
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
