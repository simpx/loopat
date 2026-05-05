/**
 * Context tab — sub-nav (Knowledge / Agents / Repos), each owns
 * sidebar+main below the sub-nav.
 *
 * Ported from opencode prototype loop-tab-context.tsx; markdown render
 * uses local Markdown component (marked-based). Wikilinks `[[X]]`
 * transform to `[X](#wiki:X)` then click handler navigates.
 */
import { createSignal, For, Show } from "solid-js"
import { Icon } from "../components/icon"
import { Markdown } from "../components/markdown"

type SubTab = "knowledge" | "agents" | "repos"

const SUB_TABS: Array<{ id: SubTab; label: string; sub?: string; count?: number }> = [
  { id: "knowledge", label: "Knowledge", sub: "passive · markdown", count: 9 },
  { id: "agents", label: "Agents", sub: "active · executable", count: 4 },
  { id: "repos", label: "Repos", sub: "passive · code", count: 4 },
]

export function ContextPage() {
  const [sub, setSub] = createSignal<SubTab>("knowledge")
  return (
    <div class="flex flex-col h-full w-full">
      <nav class="flex items-center gap-1 px-3 h-9 shrink-0 border-b border-gray-200 bg-white">
        <span class="text-xs text-gray-500 mr-2">Context</span>
        <span class="text-[11px] text-gray-400">team's distilled materials</span>
        <span class="w-px h-4 bg-gray-200 mx-2" />
        <For each={SUB_TABS}>
          {(t) => (
            <button
              type="button"
              onClick={() => setSub(t.id)}
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
          <KnowledgePane />
        </Show>
        <Show when={sub() === "agents"}>
          <AgentsPane />
        </Show>
        <Show when={sub() === "repos"}>
          <ReposPane />
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Knowledge
// ============================================================================

type DocNode =
  | { kind: "folder"; name: string; children: DocNode[] }
  | { kind: "file"; name: string; path: string; updatedAgo?: string }

const DOCS: DocNode[] = [
  {
    kind: "folder",
    name: "loop",
    children: [
      { kind: "file", name: "overview.md", path: "loop/overview.md", updatedAgo: "2h" },
      { kind: "file", name: "lifecycle.md", path: "loop/lifecycle.md", updatedAgo: "1d" },
    ],
  },
  {
    kind: "folder",
    name: "ai-org",
    children: [
      { kind: "file", name: "vision.md", path: "ai-org/vision.md", updatedAgo: "5d" },
      { kind: "file", name: "1001-philosophy.md", path: "ai-org/1001-philosophy.md", updatedAgo: "3d" },
    ],
  },
  {
    kind: "folder",
    name: "inbox",
    children: [
      { kind: "file", name: "2026-05-04.md", path: "inbox/2026-05-04.md", updatedAgo: "12m" },
      { kind: "file", name: "2026-05-03.md", path: "inbox/2026-05-03.md", updatedAgo: "1d" },
    ],
  },
  {
    kind: "folder",
    name: "knowledge",
    children: [
      { kind: "file", name: "gateway-cache-strategies.md", path: "knowledge/gateway-cache-strategies.md", updatedAgo: "1w" },
      { kind: "file", name: "rdma-mr-register.md", path: "knowledge/rdma-mr-register.md", updatedAgo: "2w" },
    ],
  },
]

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

const DOC_CONTENT: Record<string, DocPage> = {
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
      { path: "inbox/2026-05-04.md", preview: "...refactored [[loop/overview.md]] to add lifecycle table..." },
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
  "inbox/2026-05-04.md": {
    frontmatter: { tags: ["daily"], updated: "12m" },
    body: `# 2026-05-04

- ✅ 验证 opencode TUI 多客户端共享 work
- ✅ Fork opencode 起 1001 prototype
- 📌 完成 4-tab + Focus zen 重构
- 💡 Doc 升级为 Context（含 docs + agents + repos）— 拉通了
- 💡 加 wikilink + backlinks，向 [[loop/overview.md]] 看齐`,
    backlinks: [],
  },
  "inbox/2026-05-03.md": {
    frontmatter: { tags: ["daily"], updated: "1d" },
    body: `# 2026-05-03

- 跟 [[ai-org/vision.md]] 拉齐了"三种稀缺资源"哲学
- focus tab zen 化讨论`,
    backlinks: [],
  },
  "knowledge/gateway-cache-strategies.md": {
    frontmatter: { title: "KV Cache Strategies", tags: ["knowledge", "gateway"], updated: "1w" },
    body: `# KV Cache Strategies

(WIP — picking up from [[knowledge/rdma-mr-register.md]])

## SLRU + Ghost

Two-tier admission with a ghost queue for re-admission. Helps with cache
thrashing under workload shifts.

## Eviction

LRU baseline, then SLRU+G overlay. See vllm fork for impl.`,
    backlinks: [],
  },
  "knowledge/rdma-mr-register.md": {
    frontmatter: { title: "RDMA mr_register", tags: ["knowledge", "rdma"], updated: "2w" },
    body: `# RDMA mr_register

\`mr_register\` is the bottleneck for RDMA-backed cache. Page alignment must
match cuda alignment.

See loops: gateway-launch, rdma-fix.`,
    backlinks: [
      { path: "knowledge/gateway-cache-strategies.md", preview: "picking up from [[knowledge/rdma-mr-register.md]]" },
    ],
  },
}

function KnowledgePane() {
  const [path, setPath] = createSignal("ai-org/vision.md")
  const [openFolders, setOpenFolders] = createSignal(new Set(["loop", "ai-org", "inbox"]))
  const toggle = (name: string) => {
    const next = new Set(openFolders())
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpenFolders(next)
  }
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
          <For each={DOCS}>
            {(node) => (
              <DocTreeNode
                node={node}
                depth={0}
                selected={path}
                onSelect={setPath}
                openFolders={openFolders}
                toggleFolder={toggle}
              />
            )}
          </For>
        </div>
        <div class="px-3 h-9 border-t border-gray-200 flex items-center text-[11px] text-gray-500 gap-2">
          <Icon name="archive" />
          <span>inbox · 3 unread</span>
        </div>
      </aside>
      <main class="flex-1 min-w-0 flex flex-col bg-white">
        <DocView path={path()} onSelect={setPath} />
      </main>
    </div>
  )
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
          class="w-full py-1 flex items-center gap-1 hover:bg-gray-50 text-left"
          style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
          onClick={() => props.toggleFolder(folder.name)}
        >
          <Icon name={opened() ? "chevron-down" : "chevron-right"} class="text-gray-500" />
          <Icon name="folder" class="text-gray-500" />
          <span class="text-[13px] text-gray-900">{folder.name}</span>
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
      <Icon name="file-tree" class="text-gray-500 shrink-0" />
      <span class="flex-1 min-w-0 truncate text-[13px] text-gray-900">{file.name}</span>
      {file.updatedAgo && <span class="text-[11px] text-gray-500">{file.updatedAgo}</span>}
    </button>
  )
}

function DocView(props: { path: string; onSelect: (path: string) => void }) {
  const page = (): DocPage =>
    DOC_CONTENT[props.path] ?? {
      frontmatter: {},
      body: `# ${props.path}\n\n_(no content yet — mock placeholder)_`,
      backlinks: [],
    }
  const bodyWithLinks = () => {
    const body = page().body
    return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, p, alias) => {
      const label = alias ?? p
      return `[${label}](#wiki:${p})`
    })
  }
  return (
    <>
      <header class="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[13px]">
          <Icon name="file-tree" class="text-gray-500" />
          <span class="text-gray-500">{props.path}</span>
        </div>
        <div class="flex items-center gap-3 text-xs text-gray-500">
          <span>read-only · main · 2 ahead</span>
          <button class="px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-100 text-gray-900">
            edit
          </button>
        </div>
      </header>
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
            <Markdown text={bodyWithLinks()} />
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

function AgentsPane() {
  const [selectedId, setSelected] = createSignal("coo-bot")
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

type Repo = {
  id: string
  name: string
  remote: string
  branch: string
  status: "online" | "offline"
  recentLoops: { name: string; branch: string; driver: string; ago: string }[]
  readme: string
}

const REPOS: Repo[] = [
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

function ReposPane() {
  const [selectedId, setSelected] = createSignal("loopey-runtime")
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
