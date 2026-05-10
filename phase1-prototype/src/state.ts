/**
 * Module-level signals for the prototype. Pure mock — no backend, no
 * persistence. Mutations (fork, RFD release, claim, edit) update signals.
 */
import { createSignal } from "solid-js"

export const ME = "simpx"

export type LoopStatus = "active" | "idle" | "archived"

export type ChatMount = {
  id: string
  upTo: number
}

export type LoopContext = {
  knowledge: "all" | string[]
  notes: "all" | string[]
  personal?: string[]
  chats?: ChatMount[]
}

export type TimelineEvent = {
  time: string
  kind: "create" | "driver-change" | "rfd" | "claim" | "fork" | "focus-pin"
  by: string
  from?: string
  to?: string
  note?: string
}

export type Loop = {
  id: string
  name: string
  archetype: "code" | "research" | "online" | "context-refine" | "design"
  workdir: string
  branch?: string
  driver: string
  participants: number
  lastActivityAgo: string
  status: LoopStatus
  focuses?: string[]
  forkedFrom?: string
  rfd?: boolean
  context: LoopContext
  createdAt: string
  createdBy: string
  timeline: TimelineEvent[]
}

export type DiffLine = {
  kind: "ctx" | "add" | "del" | "hunk"
  text: string
  ln?: number
}

export type ChatItem =
  | { kind: "user"; text: string; time: string }
  | { kind: "ai"; text: string; time: string }
  | { kind: "driver-change"; from: string; to: string; time: string }
  | { kind: "rfd"; by: string; time: string }
  | { kind: "claim"; by: string; time: string }
  | { kind: "diff"; file: string; lines: DiffLine[]; time: string }
  | {
      kind: "read"
      path: string
      startLine?: number
      total?: number
      lines: string[]
      time: string
    }
  | { kind: "todo"; title?: string; items: { done: boolean; text: string }[]; time: string }
  | { kind: "artifact"; path: string; preview: string; lines: number; time: string }
  | { kind: "command"; cmd: string; output: string[]; ok?: boolean; time: string }

const initialLoops: Loop[] = [
  {
    id: "prototype-hifi",
    name: "prototype-hifi",
    archetype: "design",
    workdir: "~/workspace/1001/phase1-prototype",
    branch: "main",
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    focuses: ["产品侧高保真原型"],
    context: {
      knowledge: "all",
      notes: "all",
      chats: [
        { id: "all", upTo: 12 },
        { id: "dm-coo", upTo: 24 },
      ],
    },
    createdAt: "2026-05-05 16:20",
    createdBy: ME,
    timeline: [
      { time: "2026-05-05 16:20", kind: "create", by: ME },
      { time: "2026-05-05 16:25", kind: "focus-pin", by: ME, note: "产品侧高保真原型" },
    ],
  },
  {
    id: "loopat-runtime-spike",
    name: "loopat-runtime-spike",
    archetype: "research",
    workdir: "~/workspace/loopat",
    branch: "feat/runtime-spike",
    driver: ME,
    participants: 2,
    lastActivityAgo: "1h",
    status: "active",
    focuses: ["可自举的MVP"],
    context: {
      knowledge: "all",
      notes: "all",
      chats: [
        { id: "dev", upTo: 86 },
        { id: "dm-panlilu", upTo: 38 },
      ],
    },
    createdAt: "2026-05-04 14:00",
    createdBy: ME,
    timeline: [
      { time: "2026-05-04 14:00", kind: "create", by: ME },
      { time: "2026-05-04 14:30", kind: "focus-pin", by: ME, note: "可自举的MVP" },
    ],
  },
  {
    id: "loopat-ts-mvp",
    name: "loopat-ts-mvp",
    archetype: "code",
    workdir: "~/workspace/loopat-ts",
    branch: "main",
    driver: "panlilu",
    participants: 1,
    lastActivityAgo: "26m",
    status: "active",
    focuses: ["可自举的MVP"],
    context: {
      knowledge: "all",
      notes: "all",
      chats: [
        { id: "dev", upTo: 86 },
        { id: "dm-panlilu", upTo: 38 },
      ],
    },
    createdAt: "2026-05-02 10:00",
    createdBy: "panlilu",
    timeline: [
      { time: "2026-05-02 10:00", kind: "create", by: "panlilu" },
      { time: "2026-05-02 10:30", kind: "focus-pin", by: "panlilu", note: "可自举的MVP" },
    ],
  },
  {
    id: "research-opencode",
    name: "research-opencode",
    archetype: "research",
    workdir: "~/workspace/opencode-fork",
    branch: "1001-prototype",
    driver: ME,
    participants: 1,
    lastActivityAgo: "5h",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-03 11:00",
    createdBy: ME,
    timeline: [{ time: "2026-05-03 11:00", kind: "create", by: ME }],
  },
  {
    id: "research-claude-code",
    name: "research-claude-code",
    archetype: "research",
    workdir: "~/workspace/claude-code-internals",
    driver: ME,
    participants: 1,
    lastActivityAgo: "2d",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-07 09:30",
    createdBy: ME,
    timeline: [{ time: "2026-05-07 09:30", kind: "create", by: ME }],
  },
  {
    id: "site-uptime-spike",
    name: "site-uptime-spike",
    archetype: "online",
    workdir: "(待认领)",
    driver: "(未认领)",
    participants: 0,
    lastActivityAgo: "8m",
    status: "active",
    rfd: true,
    context: {
      knowledge: "all",
      notes: "all",
      chats: [{ id: "ops", upTo: 6 }],
    },
    createdAt: "2026-05-09 09:42",
    createdBy: "ops-bot",
    timeline: [
      { time: "2026-05-09 09:42", kind: "create", by: "ops-bot", note: "loopat.ai 5xx 抖动告警" },
      { time: "2026-05-09 09:42", kind: "rfd", by: "ops-bot", note: "等人接" },
    ],
  },
  {
    id: "demo-video-script",
    name: "demo-video-script",
    archetype: "design",
    workdir: "~/workspace/loopat/demo",
    branch: "main",
    driver: ME,
    participants: 1,
    lastActivityAgo: "30m",
    status: "active",
    focuses: ["初版上线"],
    context: {
      knowledge: "all",
      notes: "all",
      chats: [{ id: "all", upTo: 12 }, { id: "dm-coo", upTo: 24 }],
    },
    createdAt: "2026-05-10 08:30",
    createdBy: ME,
    timeline: [
      { time: "2026-05-10 08:30", kind: "create", by: ME, note: "HN show video draft" },
      { time: "2026-05-10 09:15", kind: "focus-pin", by: ME, note: "初版上线" },
    ],
  },
  {
    id: "attach-spec-review",
    name: "attach-spec-review",
    archetype: "design",
    workdir: "~/workspace/loopat",
    branch: "spec/attach-v0",
    driver: "panlilu",
    participants: 2,
    lastActivityAgo: "3h",
    status: "active",
    context: {
      knowledge: "all",
      notes: "all",
      chats: [{ id: "dev", upTo: 86 }],
    },
    createdAt: "2026-05-09 22:00",
    createdBy: ME,
    timeline: [
      { time: "2026-05-09 22:00", kind: "create", by: ME, note: "把 attach spec 草稿单开 loop 让 panlilu review" },
      { time: "2026-05-09 22:30", kind: "rfd", by: ME, note: "我先睡了，明早 panlilu 看完接" },
      { time: "2026-05-10 09:18", kind: "claim", by: "panlilu", from: ME, note: "我接，今天 review 完出意见" },
    ],
  },
  {
    id: "feature-pricing-sketch",
    name: "feature-pricing-sketch",
    archetype: "research",
    workdir: "~/workspace/loopat-pricing",
    driver: ME,
    participants: 1,
    lastActivityAgo: "4d",
    status: "idle",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-06 14:20",
    createdBy: ME,
    timeline: [
      { time: "2026-05-06 14:20", kind: "create", by: ME, note: "猜个大概的定价模型，看 Linear / Notion 怎么收的" },
    ],
  },
  {
    id: "naming-brainstorm",
    name: "naming-brainstorm",
    archetype: "design",
    workdir: "(vault)",
    driver: ME,
    participants: 1,
    lastActivityAgo: "1d",
    status: "archived",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-08 21:00",
    createdBy: ME,
    timeline: [
      { time: "2026-05-08 21:00", kind: "create", by: ME, note: "brand 名 brainstorm" },
      { time: "2026-05-09 02:00", kind: "create", by: ME, note: "decision: loopat.ai" },
    ],
  },
  {
    id: "prototype-hifi-fork-test",
    name: "prototype-hifi-fork-test",
    archetype: "design",
    workdir: "~/workspace/1001/phase1-prototype-fork",
    branch: "main-fork",
    driver: "panlilu",
    participants: 1,
    lastActivityAgo: "5h",
    status: "active",
    forkedFrom: "prototype-hifi",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-10 04:30",
    createdBy: "panlilu",
    timeline: [
      { time: "2026-05-10 04:30", kind: "fork", by: "panlilu", note: "forked from prototype-hifi · 想试 react 改写看可行性" },
    ],
  },
]

export const [loops, setLoops] = createSignal<Loop[]>(initialLoops)

export const [newLoopDialogOpen, setNewLoopDialogOpen] = createSignal(false)

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function randHex(n: number): string {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function uniqueSlug(base: string): string {
  const baseSlug = slugify(base)
  if (!baseSlug) return randHex(4)
  const taken = new Set(loops().map((l) => l.id))
  if (!taken.has(baseSlug)) return baseSlug
  return `${baseSlug}-${randHex(2)}`
}

const updateLoop = (id: string, patch: Partial<Loop>) => {
  setLoops(loops().map((l) => (l.id === id ? { ...l, ...patch } : l)))
}

function nowDisplay() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const appendTimeline = (id: string, ev: TimelineEvent) => {
  const loop = loops().find((l) => l.id === id)
  if (!loop) return
  updateLoop(id, { timeline: [...loop.timeline, ev] })
}

export function forkLoop(sourceId: string): string {
  const source = loops().find((l) => l.id === sourceId)
  if (!source) return sourceId
  const newId = uniqueSlug(`${source.name}-fork`)
  const ts = nowDisplay()
  const newLoop: Loop = {
    ...source,
    id: newId,
    name: `${source.name}-fork`,
    branch: source.branch ? `${source.branch}-fork` : undefined,
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    forkedFrom: source.id,
    rfd: false,
    createdAt: ts,
    createdBy: ME,
    timeline: [{ time: ts, kind: "fork", by: ME, note: `forked from ${source.name}` }],
  }
  setLoops([newLoop, ...loops()])
  return newId
}

export type CreateLoopOpts = {
  name?: string
  repo?: string
  injectPersonal?: string[]
}

export function createLoop(opts: CreateLoopOpts = {}): string {
  const base = opts.name?.trim() || opts.repo?.trim() || ""
  const id = uniqueSlug(base)
  const ts = nowDisplay()
  const newLoop: Loop = {
    id,
    name: opts.name?.trim() || opts.repo?.trim() || "untitled",
    archetype: "code",
    workdir: opts.repo ? `~/workspace/${opts.repo}` : "~/workspace",
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    context: {
      knowledge: "all",
      notes: "all",
      personal: opts.injectPersonal?.length ? opts.injectPersonal : undefined,
    },
    createdAt: ts,
    createdBy: ME,
    timeline: [{ time: ts, kind: "create", by: ME }],
  }
  setLoops([newLoop, ...loops()])
  return id
}

export function createDistillLoop(filePath: string): string {
  const basename = filePath.split("/").pop()?.replace(/\.md$/, "") || filePath
  const id = uniqueSlug(`distill-${basename}`)
  const ts = nowDisplay()
  const newLoop: Loop = {
    id,
    name: `distill ${basename}`,
    archetype: "context-refine",
    workdir: "(vault)",
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: ts,
    createdBy: ME,
    timeline: [{ time: ts, kind: "create", by: ME, note: `把 ${filePath} 蒸馏到 knowledge` }],
  }
  setLoops([newLoop, ...loops()])
  const time = ts.split(" ")[1] ?? ts
  chats[id] = [
    {
      kind: "user",
      text: `把 \`${filePath}\` 蒸馏一下放进 knowledge。先读一遍当前内容，给一个目标路径建议（loopat/ / ai-org/ / conventions/ / skills/ 选一个），再讨论怎么 restructure。`,
      time,
    },
  ]
  return id
}

export function createEditLoop(filePath: string): string {
  const basename = filePath.split("/").pop()?.replace(/\.md$/, "") || filePath
  const id = uniqueSlug(`edit-${basename}`)
  const ts = nowDisplay()
  const newLoop: Loop = {
    id,
    name: `edit ${basename}`,
    archetype: "context-refine",
    workdir: "(vault)",
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: ts,
    createdBy: ME,
    timeline: [{ time: ts, kind: "create", by: ME, note: `编辑 ${filePath}` }],
  }
  setLoops([newLoop, ...loops()])
  const time = ts.split(" ")[1] ?? ts
  chats[id] = [
    {
      kind: "user",
      text: `准备编辑 \`${filePath}\`，先帮我读一下当前内容，待会我说要改什么。`,
      time,
    },
  ]
  return id
}

export const [mountRevisions, setMountRevisions] = createSignal<Record<string, string>>({
  knowledge: "@8a4c1b",
  notes: "@c2e174",
  personal: "@f0b385",
})

export function syncMount(source: string) {
  const next = new Uint8Array(3)
  crypto.getRandomValues(next)
  const hex = Array.from(next, (b) => b.toString(16).padStart(2, "0")).join("")
  setMountRevisions({ ...mountRevisions(), [source]: `@${hex}` })
}

export function setLoopPersonal(id: string, paths: string[]) {
  const loop = loops().find((l) => l.id === id)
  if (!loop) return
  updateLoop(id, {
    context: { ...loop.context, personal: paths.length > 0 ? paths : undefined },
  })
}

export function previewSlug(opts: CreateLoopOpts): string {
  const base = opts.name?.trim() || opts.repo?.trim() || ""
  if (!base) return "<random-hex>"
  return slugify(base) || "<random-hex>"
}

export function releaseRfd(id: string) {
  const loop = loops().find((l) => l.id === id)
  if (!loop) return
  updateLoop(id, {
    rfd: true,
    context: { ...loop.context, personal: undefined },
  })
  appendTimeline(id, { time: nowDisplay(), kind: "rfd", by: ME })
}

export function claimDrive(id: string) {
  const prev = loops().find((l) => l.id === id)?.driver
  updateLoop(id, { driver: ME, rfd: false })
  appendTimeline(id, { time: nowDisplay(), kind: "claim", by: ME, from: prev })
}

// ============================================================================
// Chat content per loop
// ============================================================================

const PROTOTYPE_HIFI_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "我们现在的目标是把 1001 想要的 4 个一级概念（loop / focus / context / chat）做成一个 hi-fi 原型，可以走通 fork / spawn / driver-transfer / context-mount 等核心交互，但全是 mock。",
    time: "16:20",
  },
  {
    kind: "ai",
    text: "已读完根目录 1001-mvp.md 和 1001-story.md。建议技术栈 Vite + SolidJS + Tailwind，4 个一级概念各占一个 tab。先做架子，再细化每个 tab 内部。",
    time: "16:21",
  },
  { kind: "user", text: "OK，先把目录结构和 4 tab shell 起起来", time: "16:22" },
  {
    kind: "command",
    cmd: "bun create vite phase1-prototype --template solid-ts",
    ok: true,
    time: "16:24",
    output: [
      "Scaffolding project in ~/workspace/1001/phase1-prototype...",
      "Done. Now run:",
      "  cd phase1-prototype",
      "  bun install",
      "  bun run dev",
    ],
  },
  {
    kind: "artifact",
    path: "src/App.tsx",
    lines: 88,
    time: "16:30",
    preview:
      "// 4-tab shell with router + workspace dropdown\nconst TABS = [\n  { id: 'loop', label: 'Loop' },\n  { id: 'focus', label: 'Focus' },\n  { id: 'chat', label: 'Chat' },\n  { id: 'context', label: 'Context' },\n]",
  },
  {
    kind: "user",
    text: "Focus tab 改成纯派生 view —— 只有 notes/focus.md 是真存，pinned/listed override；其他全部从 loops().focuses[] 算出来",
    time: "18:14",
  },
  {
    kind: "ai",
    text:
      "已重构 focus.tsx：\n- 删除 PINNED / FOCUS_ITEMS 三个 hardcoded 数组\n- 加 deriveFocuses(loops, pinned, listed) helper\n- 新增 sections：📌 Pinned / focus / 未归类 / inbox preview",
    time: "18:25",
  },
  {
    kind: "user",
    text: "未认领（rfd）从 Focus 段拿掉 —— rfd 是 automatic incoming，Focus 是 curated attention，方向相反不该混",
    time: "18:33",
  },
  { kind: "ai", text: "明白。删了 unclaimed 段，rfd loops 通过 Loop tab 的 RFD filter 档暴露。mvp doc §1.2 同步。", time: "18:34" },
  {
    kind: "user",
    text: "Chat tab：channel 的 metadata（spawn 出去的 loop）反向引用要做。loop 也要看到 chats 作为 context source",
    time: "23:01",
  },
  {
    kind: "ai",
    text:
      "做了 4 件事：\n1. LoopContext 加 chats: ChatMount[]，每个 mount 是 {id, upTo}\n2. chat conversation header 下方：📤 N loops 把这条 chat 作为 context（可折叠）\n3. loop header chips 加 chat: #channel:upTo 系列\n4. chatActive signal 跨 tab 共享，点 chip 跳到对应 channel",
    time: "23:18",
  },
  { kind: "user", text: "好，去掉 dm 段的 + 号，因为 #all 就是成员目录，找新人去那里搜", time: "00:14" },
  { kind: "ai", text: "已删。channel header 加可展开 + 搜索的成员面板，点名直接开 DM。", time: "00:18" },
]

const LOOPAT_RUNTIME_SPIKE_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "正式开始 runtime spike。两条候选路：\n1. fork opencode（TS、Tauri 桌面、SSE multi-client）\n2. 完全自建（按我们的 attach 协议）\n\n你帮我列对照表，决定 1-2 个月窗口里哪条能 ship。",
    time: "14:00",
  },
  {
    kind: "ai",
    text:
      "| 维度 | fork opencode | 完全自建 |\n|---|---|---|\n| 起点 | 现成 session/project/SSE | 0 |\n| 改动量 | 加 driver / focus / chat-mount 语义 | 全部 |\n| 风险 | 跟 upstream 撕裂 | 时间不够 |\n| 时间预估（1人） | 3-4w | 8-12w |\n| 学习曲线 | 看懂 ts 全栈 monorepo | 控制自己定的边界 |\n\n窗口期 1-2 月，单看时间 fork 占优。但要先确认 attach / driver 这些能否优雅塞进 opencode 的 session 模型。",
    time: "14:08",
  },
  {
    kind: "command",
    cmd: "git clone https://github.com/sst/opencode ~/workspace/opencode-fork && cd ~/workspace/opencode-fork && git checkout -b 1001-prototype",
    ok: true,
    time: "14:12",
    output: [
      "Cloning into '~/workspace/opencode-fork'...",
      "Receiving objects: 100% (12483/12483), 8.42 MiB | 4.1 MiB/s, done.",
      "Switched to a new branch '1001-prototype'",
    ],
  },
  {
    kind: "read",
    path: "packages/server/src/session.ts",
    startLine: 1,
    total: 412,
    time: "14:15",
    lines: [
      "// opencode session = chat + project + working file state",
      "export class Session {",
      "  id: string",
      "  projectId: string",
      "  messages: Message[]",
      "  // ...",
      "}",
      "",
      "// session 跟 project 是 1:N；project = workdir。",
      "// 没有 driver 概念；没有 focus 概念；attach 走 SSE 但只单 client。",
    ],
  },
  {
    kind: "ai",
    text:
      "看完核心。结论：\n- session = 我们 loop 里 'context + ai' 那部分（已有）\n- project = workdir（已有）\n- driver / focus / chat-as-context / multi-client attach —— **要加**\n\ndriver 字段加在 session metadata 里；focus 是 workspace 级 derived view（不动 session model）；attach multi-client 要把 SSE 改成 ws + 多 subscriber。\n\n可行，但 attach 那块改动不小。",
    time: "14:30",
  },
  { kind: "user", text: "panlilu 那边走完全自建 + Next.js + tRPC + Prisma。我们各跑一周看哪边先出活的 demo", time: "14:35" },
  { kind: "ai", text: "OK。我先在 fork 上加 driver 字段 + workspace-level focus 派生。一周后跟 panlilu 同步。", time: "14:36" },
  {
    kind: "diff",
    file: "packages/server/src/session.ts",
    time: "14:50",
    lines: [
      { kind: "hunk", text: "@@ -8,6 +8,8 @@ export class Session {" },
      { kind: "ctx", ln: 8, text: "  id: string" },
      { kind: "ctx", ln: 9, text: "  projectId: string" },
      { kind: "add", ln: 10, text: "  driver: string  // 1001 extension: who drives this loop" },
      { kind: "add", ln: 11, text: "  rfd: boolean    // 1001 extension: released for drive" },
      { kind: "ctx", ln: 12, text: "  messages: Message[]" },
      { kind: "ctx", ln: 13, text: "}" },
    ],
  },
  {
    kind: "todo",
    title: "spike checklist",
    time: "15:30",
    items: [
      { done: true, text: "clone fork opencode" },
      { done: true, text: "读懂 session / project model" },
      { done: true, text: "加 driver / rfd 字段（spike）" },
      { done: false, text: "workspace-level focus 派生" },
      { done: false, text: "改 SSE → ws + multi-subscriber" },
      { done: false, text: "attach 协议 spec" },
      { done: false, text: "跟 panlilu 周末同步进度" },
    ],
  },
]

const LOOPAT_TS_MVP_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "[panlilu] 我打算从零起 Next.js + tRPC + Prisma + Postgres + WebSocket 全栈。理由：opencode 模型不太对（session 不等于 loop），改 fork 会一直被 upstream 拉。自建慢但语义干净。",
    time: "10:00",
  },
  {
    kind: "ai",
    text:
      "理由站得住 —— attach + driver + focus 这三件事 opencode 都没有，硬塞进去会伪。\n\n建议起手 stack：\n- Next.js 15 (app router) + React 19\n- tRPC 11 + react-query\n- Prisma + Postgres（domain models）\n- next-auth (beta) + Prisma adapter\n- ws 跨 client attach\n\n先写 schema 再写 UI，先类型再 query。",
    time: "10:02",
  },
  {
    kind: "command",
    cmd: "npx create-t3-app@latest loopat-ts --noInstall --tailwind --trpc --prisma --nextAuth",
    ok: true,
    time: "10:04",
    output: [
      "✓ scaffolded loopat-ts/",
      "✓ prisma schema with NextAuth tables",
      "✓ tRPC root router",
      "next steps: bun install && bun db:push",
    ],
  },
  {
    kind: "artifact",
    path: "prisma/schema.prisma",
    lines: 162,
    time: "11:30",
    preview:
      "model Loop {\n  id              String        @id @default(cuid())\n  name            String\n  archetype       LoopArchetype @default(code)\n  workdir         String\n  driverName      String\n  rfd             Boolean       @default(false)\n  forkedFrom      String?\n  // ...\n}\n\nenum LoopArchetype { code research online context_refine design }",
  },
  {
    kind: "user",
    text: "把 timeline event / focus / chat-mount 的 schema 也写完，然后 bun db:push 起 postgres",
    time: "13:18",
  },
  {
    kind: "diff",
    file: "prisma/schema.prisma",
    time: "13:45",
    lines: [
      { kind: "hunk", text: "@@ +103,30 @@ model Loop" },
      { kind: "add", text: "model TimelineEvent {" },
      { kind: "add", text: "  id      String            @id @default(cuid())" },
      { kind: "add", text: "  loopId  String" },
      { kind: "add", text: "  kind    TimelineEventKind" },
      { kind: "add", text: "  byName  String" },
      { kind: "add", text: "  fromVal String?" },
      { kind: "add", text: "  toVal   String?" },
      { kind: "add", text: "  note    String?" },
      { kind: "add", text: "  loop    Loop @relation(fields: [loopId], references: [id])" },
      { kind: "add", text: "}" },
      { kind: "add", text: "" },
      { kind: "add", text: "model ChatMount {" },
      { kind: "add", text: "  loopId    String" },
      { kind: "add", text: "  channelId String" },
      { kind: "add", text: "  upTo      Int" },
      { kind: "add", text: "  @@id([loopId, channelId])" },
      { kind: "add", text: "}" },
    ],
  },
  {
    kind: "command",
    cmd: "./start-database.sh && bun db:push",
    ok: true,
    time: "14:02",
    output: [
      "🐘 starting postgres on docker...",
      "✓ container loopat-ts-postgres ready",
      "Datasource \"db\": PostgreSQL database \"loopat-ts\"",
      "🚀  Your database is now in sync with your Prisma schema. Done in 2.84s",
    ],
  },
  {
    kind: "user",
    text: "trpc routers 写了 loopRouter.list / .get / .create / .fork。WebSocket attach 走 src/server/ws，每个 loop 一个 channel，subscribe 收 timeline 增量",
    time: "16:20",
  },
  {
    kind: "ai",
    text: "attach 协议草稿：\n- ws topic: `/loop/<id>`\n- 客户端 sub 后立刻收 snapshot + 增量 event stream\n- driver-transfer 也是事件，所有 client 同步\n- close 是 send-only event，不影响 sub 状态",
    time: "16:25",
  },
  {
    kind: "todo",
    title: "本周 panlilu 这条线",
    time: "23:01",
    items: [
      { done: true, text: "scaffold + prisma schema" },
      { done: true, text: "bun db:push + seed mock data" },
      { done: false, text: "trpc routers (loop / focus / contact)" },
      { done: false, text: "ws attach 协议 + 多 client mirror demo" },
      { done: false, text: "Next.js dashboard 页面（list / detail）" },
      { done: false, text: "周末跟 simpx 同步两条线进展" },
    ],
  },
]

const RESEARCH_OPENCODE_CHAT: ChatItem[] = [
  {
    kind: "user",
    text: "纯调研 —— 把 opencode 内部架构摸清，不一定要 fork。看完写到 knowledge/loopat/ 下",
    time: "yesterday 11:00",
  },
  {
    kind: "ai",
    text:
      "opencode = monorepo（packages/server + packages/desktop + packages/cli）+ Tauri 桌面壳。核心 model 是 session（chat history + tool calls）和 project（workdir）。\n\n关键观察：\n- session 跟 project 是 1:N\n- 没 driver 概念，单人语义\n- attach 用 SSE 但单 subscriber",
    time: "yesterday 11:08",
  },
  {
    kind: "command",
    cmd: "git clone https://github.com/sst/opencode ~/workspace/opencode-fork --depth=1",
    ok: true,
    time: "yesterday 11:10",
    output: [
      "Cloning into '~/workspace/opencode-fork'...",
      "remote: Enumerating objects: 1284, done.",
      "remote: Counting objects: 100% (1284/1284), done.",
      "Receiving objects: 100% (1284/1284), 5.18 MiB | 4.7 MiB/s, done.",
      "Resolving deltas: 100% (382/382), done.",
    ],
  },
  {
    kind: "read",
    path: "packages/server/src/session.ts",
    startLine: 1,
    total: 412,
    time: "yesterday 11:18",
    lines: [
      "export class Session {",
      "  id: string",
      "  projectId: string",
      "  messages: Message[]",
      "  // 没有 driver / rfd / multi-client subscriber 概念",
      "}",
    ],
  },
  {
    kind: "ai",
    text:
      "session 模型很轻，加 driver / rfd 字段不难。难的是 attach —— 现在的 SSE 只支持单 client，要改成 ws + 多 subscriber broadcast。\n\n继续读 cli + desktop 包，看用户视角的 'session' 怎么暴露。",
    time: "yesterday 11:30",
  },
  {
    kind: "todo",
    title: "调研 checklist",
    time: "yesterday 12:00",
    items: [
      { done: true, text: "读 server/src/session.ts" },
      { done: true, text: "读 server/src/project.ts" },
      { done: true, text: "扫 cli + desktop 包，看 session 怎么暴露给用户" },
      { done: true, text: "整理对照表（1001 概念 vs opencode 现状）" },
      { done: false, text: "看 v0.7 hooks 重构会不会影响我们的 fork" },
      { done: false, text: "估改造 attach 的工作量（1人）" },
    ],
  },
  {
    kind: "artifact",
    path: "knowledge/loopat/opencode-architecture.md",
    lines: 96,
    time: "yesterday 12:14",
    preview:
      "# opencode 架构摘要\n\n## 核心 model\n- session = chat history + tool calls + working state\n- project = git repo / workdir，1:N session\n\n## 1001 想加的语义\n- driver / rfd → 加在 session metadata\n- focus → workspace-level 派生\n- chat-mount → session.contextSources 扩展\n- attach multi-client → SSE 改 ws",
  },
  {
    kind: "user",
    text: "v0.7 release notes 我刚看了眼，hooks 系统重构了。fork 的话每次 rebase 可能都要重新对一遍 hooks 注册。注意",
    time: "5h",
  },
  {
    kind: "ai",
    text: "记到 inbox.md 了。也加进 spike-comparison.md 的 '风险' 段。",
    time: "5h",
  },
]

const RESEARCH_CLAUDE_CODE_CHAT: ChatItem[] = [
  {
    kind: "user",
    text: "claude code SDK 的 agent loop / tool dispatch 流程读一下，对比 opencode",
    time: "2d 09:30",
  },
  {
    kind: "ai",
    text:
      "claude code 的核心是 hook 系统 + skill 系统 —— 不是把 agent 框死在某个 loop 模型里，而是通过 hooks 让用户在每个生命周期点（pre-tool / post-tool / on-stop）注入自定义行为。\n\n比 opencode 灵活，但**没有 multi-client attach** —— 它就是单进程 CLI。",
    time: "2d 09:42",
  },
  {
    kind: "read",
    path: "settings.json (claude code config)",
    startLine: 1,
    total: 32,
    time: "2d 10:00",
    lines: [
      "{",
      '  "hooks": {',
      '    "pre-tool": [{ "matcher": "Edit", "command": "echo $TOOL_INPUT > /tmp/last-edit.json" }],',
      '    "on-stop": [{ "command": "git status --short | head -3" }]',
      "  },",
      '  "skills": {',
      '    "enabled": ["./skills/distill-to-knowledge"]',
      "  }",
      "}",
    ],
  },
  {
    kind: "ai",
    text:
      "skill 加载机制很优雅 — SKILL.md frontmatter 描述触发条件，AI 加载时只读元信息，需要时再 inline。\n\n这套对 1001 的 \`knowledge/skills/\` 子目录直接照抄就行。",
    time: "2d 10:08",
  },
  {
    kind: "artifact",
    path: "knowledge/loopat/claude-code-vs-opencode.md",
    lines: 54,
    time: "2d 10:18",
    preview:
      "# claude code vs opencode（对 1001 的启发）\n\n| 维度 | claude code | opencode |\n|---|---|---|\n| 部署形态 | CLI 单进程 | desktop + server |\n| multi-client attach | ✗ | SSE 单 subscriber |\n| 扩展机制 | hooks / skills | tools |\n| session 持久化 | 文件 jsonl | postgres |",
  },
  {
    kind: "user",
    text: "结论：不 fork，但抄 skills 系统。回头给 conventions/ 加一条 'SKILL.md 怎么写'",
    time: "2d 10:30",
  },
]

const SITE_UPTIME_SPIKE_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "[ops-bot] 🚨 loopat.ai 5xx 抖动告警\n\n- 检查窗口：09:35 – 09:42 (7min)\n- 5xx 总量：342 (baseline 8/min)\n- 受影响路径：/api/auth/callback (78%) · /api/loop (12%)\n- region: cn-shanghai\n- grafana: https://ops.loopat.ai/d/site-overview\n\n等人接 + 看是否需要 rollback。",
    time: "09:42",
  },
  { kind: "rfd", by: "ops-bot", time: "09:42" },
]

const DEMO_VIDEO_SCRIPT_CHAT: ChatItem[] = [
  { kind: "user", text: "HN show 视频先录第一版，2 分钟。帮我先列结构。", time: "08:30" },
  {
    kind: "ai",
    text:
      "建议结构：\n\n0:00–0:15 — hook：'AI 工具像 Slack 频道，但工作不该像聊天'\n0:15–0:45 — 4 一级概念扫一遍（Loop / Focus / Chat / Context）\n0:45–1:30 — 真实场景：从 chat spawn loop → driver transfer → 沉淀 knowledge 一镜到底\n1:30–1:50 — c/s 协议 + multi-client attach 演示\n1:50–2:00 — call-to-action（loopat.ai · early access）",
    time: "08:31",
  },
  { kind: "user", text: "0:45-1:30 那段用今天我们做 prototype 这条 loop 当 demo —— self-referential", time: "08:35" },
  { kind: "ai", text: "👍 self-referential 是好钩子。要不要把 chat → loop spawn 那段录得稍长一些（30s+），因为 reviewer 第一次看到这个动作会愣两秒。", time: "08:36" },
  {
    kind: "artifact",
    path: "demo/script-v0.md",
    lines: 42,
    time: "09:02",
    preview:
      "# loopat 2-min demo · v0\n\n## Hook (0:00-0:15)\n> AI 工具像 Slack 频道，但工作不该像聊天。\n>\n> loopat 是一个让 AI 协作不再'频道化'的工具 —— 工作有 driver、有 context、有沉淀。",
  },
  { kind: "user", text: "找 panlilu 帮录 attach demo 那段，他自建那条 ws 接好了正合适", time: "09:14" },
]

const ATTACH_SPEC_REVIEW_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "[simpx] 把 attach spec 草稿单开 loop 让 panlilu review。我先睡了。\n\n关键问题：\n1. ws message envelope 格式（用 protobuf 还是纯 JSON？）\n2. reconnect 时 client 状态怎么 recover\n3. loop visibility check 放 ws auth 还是每条 message",
    time: "yesterday 22:00",
  },
  { kind: "rfd", by: "simpx", time: "yesterday 22:30" },
  { kind: "claim", by: "panlilu", time: "today 09:18" },
  { kind: "user", text: "[panlilu] 接了。先回 1 / 2 / 3：", time: "09:18" },
  {
    kind: "ai",
    text:
      "好。我把 simpx 的 spec 草稿调出来，你边读边写：\n\n**spec/attach-v0** branch ready @ \`d8f3e2a\`",
    time: "09:18",
  },
  {
    kind: "read",
    path: "ATTACH-SPEC.md",
    startLine: 1,
    total: 48,
    time: "09:19",
    lines: [
      "# Attach 协议草稿",
      "",
      "## Topic",
      "/loop/<id> — ws subscription",
      "",
      "## Events (server → client)",
      "- snapshot — 完整 loop state",
      "- message — 新 chat 增量",
      "- timeline — driver-change / rfd / claim / fork",
      "- tool-call — AI 调工具中间状态",
    ],
  },
  {
    kind: "user",
    text:
      "[panlilu] 我的意见：\n1. 用纯 JSON，protobuf 增加部署复杂度，p1 先不引入\n2. recover 走 'event id since' query，server 拉时间窗内 events 重放\n3. visibility check 在 sub auth 时一次性做，每条 message 不重复检查（trust the topic）",
    time: "09:42",
  },
  { kind: "ai", text: "记下：JSON / event-id 增量 recover / topic-level auth。要不要写到 spec 里？", time: "09:43" },
  {
    kind: "diff",
    file: "ATTACH-SPEC.md",
    time: "10:14",
    lines: [
      { kind: "hunk", text: "@@ +25,15 @@ ## 待办" },
      { kind: "add", text: "## 决议（panlilu review @ 2026-05-10）" },
      { kind: "add", text: "" },
      { kind: "add", text: "1. **Envelope** — 纯 JSON。protobuf 推迟到 p1 之后" },
      { kind: "add", text: "2. **Recover** — client 带 lastEventId，server 重放窗内事件" },
      { kind: "add", text: "3. **Auth** — sub 时 workspace token + visibility check；每条 message 不重复" },
    ],
  },
  { kind: "user", text: "[panlilu] 等 simpx 醒了 confirm 一下我直接 close。@coo 帮我 ping", time: "10:20" },
  { kind: "ai", text: "已 dm simpx。会议进 standup queue。", time: "10:20" },
]

const FEATURE_PRICING_SKETCH_CHAT: ChatItem[] = [
  {
    kind: "user",
    text: "猜个 loopat 的定价模型。先看 Linear / Notion / Slack 的对照",
    time: "yesterday 14:20",
  },
  {
    kind: "ai",
    text:
      "拉了三家：\n\n| 工具 | 起步价 | 单位 | 主要 gating |\n|---|---|---|---|\n| Linear | $8/u/mo | seat | 私有 issue / SAML / API |\n| Notion | $10/u/mo | seat | 团队 workspace / version history |\n| Slack | $7.25/u/mo | seat | unlimited history / SSO / connect |\n\n都是 seat-based，不卖额度。",
    time: "yesterday 14:35",
  },
  {
    kind: "artifact",
    path: "pricing-sketch-v0.md",
    lines: 26,
    time: "yesterday 16:00",
    preview:
      "# loopat 定价（草稿 v0）\n\n## tier\n- **Free** — 5 人 workspace，1 active loop / 人，无 attach\n- **Team** — $10/u/mo，无限 loop，attach，agent 配额\n- **Enterprise** — 谈判，SSO/audit/private install",
  },
  { kind: "user", text: "先放着，loop 还没跑通别想这事。Phase 3 之后再 revisit", time: "yesterday 16:05" },
]

const NAMING_BRAINSTORM_CHAT: ChatItem[] = [
  { kind: "user", text: "brand 名 brainstorm。约束：好读 / 好打 / 跟 loop 有关 / .ai 域名能注册", time: "yesterday 21:00" },
  {
    kind: "ai",
    text:
      "拉了一批候选：\n\n- pit 系（pithub / pitops）—— 有 'pithub→pornhub' 切分歧义，否\n- 造词系（melode / klyma）—— 用户嫌怪\n- 1001 系（1001loop / 1001days）—— 累赘\n- 其他：loopey / looped / loopat / loopin\n\n推 \`loopey.ai\` —— 一眼读懂，slack 拼写感（-ey 后缀）。",
    time: "yesterday 21:40",
  },
  {
    kind: "artifact",
    path: "naming-decision-v1.md",
    lines: 18,
    time: "yesterday 22:00",
    preview:
      "# 1001 brand 名（决议）\n\n选 **loopey.ai**\n\n理由：唯一同时满足 .ai TLD / 一眼读懂 / loop 暗扣 / 不需解释。",
  },
  {
    kind: "user",
    text: "今天再过一下，发现 loopat 内嵌 'pat' 很妙 —— pat 可以做 AI 反馈动作（给 AI 一个 pat）",
    time: "today 01:14",
  },
  {
    kind: "ai",
    text:
      "你说服我了。loopat 比 loopey 强：\n- 同样满足 .ai / 好打 / loop 暗扣\n- 多一个 'pat' 隐藏词 —— UX 动词，比 thumbs-up 更具身\n- 'loop at AI' 短语解读虽不顺，但 brand 不靠这个\n\n更新 decision。",
    time: "today 01:18",
  },
  {
    kind: "artifact",
    path: "naming-decision-v2.md",
    lines: 22,
    time: "today 01:30",
    preview:
      "# 1001 brand 名（决议 v2，覆盖 v1）\n\n选 **loopat.ai**\n\n核心：\n1. loop（项目核心）\n2. pat（隐藏词，未来产品 UX 动词）\n\n放弃 'loop at AI' 短语解读 —— 不是英语 idiom。",
  },
  { kind: "user", text: "logo emoji 用 🧶 毛线团 —— loop 的有机/暖感呈现，跟软品牌内核一致", time: "today 01:45" },
  { kind: "ai", text: "已记。准备 close 这条 loop，结论沉淀进 knowledge/loopat/naming.md。", time: "today 01:50" },
  {
    kind: "command",
    cmd: "git mv naming-decision-v2.md ../knowledge/loopat/naming.md && git commit -m 'naming: archive brainstorm, sediment to loopat/naming.md'",
    ok: true,
    time: "today 02:00",
    output: ["[main 7c4a812] naming: archive brainstorm, sediment to loopat/naming.md", " 1 file changed, 22 insertions(+)"],
  },
]

const PROTOTYPE_HIFI_FORK_TEST_CHAT: ChatItem[] = [
  {
    kind: "user",
    text:
      "[panlilu] fork 一份 prototype 试试 React 改写 —— 不是要替代 simpx 这版，只是验证 'Solid 是否值得保留 vs React 一致性' 这个问题",
    time: "04:30",
  },
  {
    kind: "ai",
    text:
      "已 fork。注意几个 react 跟 solid 的语义差异：\n- props 在 react 默认 destructure（解开就行），solid 解开会破坏响应性\n- createSignal vs useState：solid 不重新执行组件\n- For 用 .map 替代\n\n这次 fork 主要为评估改写成本，不要做完整 port。",
    time: "04:32",
  },
  { kind: "user", text: "先把 App.tsx + state.ts + chat.tsx 三个移植了，看看代码量差", time: "04:45" },
  {
    kind: "command",
    cmd: "wc -l src/App.tsx src/state.ts src/pages/chat.tsx (solid version)",
    ok: true,
    time: "04:46",
    output: [
      "  168 src/App.tsx",
      " 1064 src/state.ts",
      "  370 src/pages/chat.tsx",
      " 1602 total",
    ],
  },
  { kind: "user", text: "react 版我估了一下大概会 +20% 行数，主要是 useEffect / useMemo 显式声明。值得吗？", time: "06:18" },
  {
    kind: "ai",
    text:
      "短期：值得性低（codebase 才 1.6k 行，react 一致性收益小）。\n长期：如果未来要写 SSR / 接 react 生态库（react-flow 等），solid 会卡。\n\n我建议先记结论 + 不动。等 phase 3 看 SSR 需求再 revisit。",
    time: "06:21",
  },
  {
    kind: "artifact",
    path: "fork-eval.md",
    lines: 18,
    time: "07:00",
    preview:
      "# Fork eval: solid → react 改写值不值得？\n\n## 当前\n- codebase 1.6k 行 solid\n- 改 react 估计 +20% 行数 (react useEffect/useMemo 显式)\n\n## 决议\n短期不动。phase 3 SSR 需求评估时再看。",
  },
]

export const chats: Record<string, ChatItem[]> = {
  "prototype-hifi": PROTOTYPE_HIFI_CHAT,
  "loopat-runtime-spike": LOOPAT_RUNTIME_SPIKE_CHAT,
  "loopat-ts-mvp": LOOPAT_TS_MVP_CHAT,
  "research-opencode": RESEARCH_OPENCODE_CHAT,
  "research-claude-code": RESEARCH_CLAUDE_CODE_CHAT,
  "site-uptime-spike": SITE_UPTIME_SPIKE_CHAT,
  "demo-video-script": DEMO_VIDEO_SCRIPT_CHAT,
  "attach-spec-review": ATTACH_SPEC_REVIEW_CHAT,
  "feature-pricing-sketch": FEATURE_PRICING_SKETCH_CHAT,
  "naming-brainstorm": NAMING_BRAINSTORM_CHAT,
  "prototype-hifi-fork-test": PROTOTYPE_HIFI_FORK_TEST_CHAT,
}

// ============================================================================
// notes/focus.md — the only "real state" Focus has.
// ============================================================================

export type FocusFile = {
  pinned: string[]
  listed: string[]
}

export const [focusFile, setFocusFile] = createSignal<FocusFile>({
  pinned: ["产品侧高保真原型", "可自举的MVP"],
  listed: ["初版上线"],
})

// ============================================================================
// notes/inbox.md — team scratch prose.
// ============================================================================

export const [inboxItems, setInboxItems] = createSignal<string[]>([
  "看了下 sst/opencode v0.7 release notes，有几个 hook 点变了，回头确认 fork 还能不能 rebase",
  "tweetdeck 上看到一个聊 'AI org' 的 thread，截图存了 personal/inbox/",
  "@panlilu next-auth beta 的 session expire callback 跟 5.0 final 行为不一样，注意",
  "把 1001-mvp.md §3 重写一版，加 c/s 协议的边界",
  "https://github.com/sst/opencode/discussions/482 有人问怎么加 attach，回头看下他们怎么想的",
  "loopat.ai 域名转 cloudflare 的事还没办，等 panlilu 那边 deployment 决定",
  "demo 视频先录第一版（2 分钟），上 hn show 用",
  "周三跟 panlilu 把两条 spike 的取舍讨论 closed，下周二之前定方向",
])
