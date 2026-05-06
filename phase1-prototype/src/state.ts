/**
 * Module-level signals for the prototype. Pure mock — no backend, no
 * persistence. Mutations (fork, RFD release, claim, edit) update signals.
 */
import { createSignal } from "solid-js"

export const ME = "simpx"

export type LoopStatus = "active" | "idle" | "archived"

export type LoopContext = {
  // Knowledge + notes are public, default-all. We carry the field so future
  // private/scoped overrides have somewhere to land, but for now both stay "all".
  knowledge: "all" | string[]
  notes: "all" | string[]
  // Personal is private — only injects what the driver explicitly picks.
  personal?: string[]
  // future: skills, mcp servers
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
  workdir: string              // every loop has a workdir
  branch?: string
  driver: string
  participants: number
  lastActivityAgo: string
  status: LoopStatus
  inFocus?: ("pinned" | "listed")[]
  focuses?: string[]           // names of focus items this loop belongs to
  forkedFrom?: string
  rfd?: boolean                // true = driver has released; anyone can claim
  context: LoopContext
  createdAt: string            // display string
  createdBy: string
  timeline: TimelineEvent[]    // sorted oldest → newest
}

export type DiffLine = {
  kind: "ctx" | "add" | "del" | "hunk"
  text: string
  ln?: number  // display line number (single column, optional)
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
    id: "gateway-launch",
    name: "gateway-launch",
    archetype: "code",
    workdir: "~/workspace/loopey-runtime",
    branch: "feat/gateway",
    driver: "阿尔萨斯",
    participants: 4,
    lastActivityAgo: "14m",
    status: "active",
    inFocus: ["pinned"],
    focuses: ["上线 gateway"],
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-04-28 09:12",
    createdBy: "阿尔萨斯",
    timeline: [
      { time: "2026-04-28 09:12", kind: "create", by: "阿尔萨斯" },
      { time: "2026-04-28 10:30", kind: "focus-pin", by: "阿尔萨斯", note: "上线 gateway" },
      { time: "2026-05-05 08:42", kind: "driver-change", by: "system", from: "阿尔萨斯", to: "simpx" },
      { time: "2026-05-05 14:32", kind: "driver-change", by: "system", from: "simpx", to: "阿尔萨斯" },
      { time: "2026-05-05 16:00", kind: "driver-change", by: "system", from: "阿尔萨斯", to: "simpx" },
    ],
  },
  {
    id: "loopctl",
    name: "loopctl",
    archetype: "code",
    workdir: "~/workspace/loopctl",
    branch: "feat/fleet-shards",
    driver: ME,
    participants: 1,
    lastActivityAgo: "3h",
    status: "active",
    context: {
      knowledge: "all",
      notes: "all",
      personal: ["secrets/LOOPEY_API_KEY", "secrets/OPENAI_API_KEY", "style/voice-tone.md"],
    },
    createdAt: "2026-05-05 13:02",
    createdBy: ME,
    timeline: [
      { time: "2026-05-05 13:02", kind: "create", by: ME },
    ],
  },
  {
    id: "mirror-llama-3",
    name: "mirror-llama-3-70b",
    archetype: "online",
    workdir: "~/workspace/shadow-llama-3-70b",
    branch: "main",
    driver: ME,
    participants: 3,
    lastActivityAgo: "1h",
    status: "active",
    inFocus: ["listed"],
    focuses: ["调研 llama-3"],
    rfd: true,
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-05 10:11",
    createdBy: ME,
    timeline: [
      { time: "2026-05-05 10:11", kind: "create", by: ME },
      { time: "2026-05-05 10:16", kind: "rfd", by: ME, note: "我有个会先 release" },
    ],
  },
  {
    id: "llama-research",
    name: "llama-research",
    archetype: "research",
    workdir: "~/workspace/llama_research",
    driver: ME,
    participants: 2,
    lastActivityAgo: "8h",
    status: "active",
    inFocus: ["listed"],
    focuses: ["调研 llama-3"],
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-04 16:20",
    createdBy: "伊利丹",
    timeline: [
      { time: "2026-05-04 16:20", kind: "create", by: "伊利丹" },
      { time: "2026-05-04 17:30", kind: "rfd", by: "伊利丹", note: "下周再看，先放着" },
      { time: "2026-05-05 08:00", kind: "claim", by: ME, note: "我接手 prefill 优化方向" },
    ],
  },
  {
    id: "knowledge-refine",
    name: "knowledge-refine",
    archetype: "context-refine",
    workdir: "~/workspace/ccx",
    driver: ME,
    participants: 1,
    lastActivityAgo: "2h",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-05 11:00",
    createdBy: ME,
    timeline: [
      { time: "2026-05-05 11:00", kind: "create", by: ME },
    ],
  },
  {
    id: "1001-design",
    name: "1001-design",
    archetype: "design",
    workdir: "~/workspace/1001",
    driver: ME,
    participants: 2,
    lastActivityAgo: "26m",
    status: "active",
    inFocus: ["pinned"],
    focuses: ["1001 系统设计"],
    context: { knowledge: "all", notes: "all" },
    createdAt: "2026-05-03 20:48",
    createdBy: ME,
    timeline: [
      { time: "2026-05-03 20:48", kind: "create", by: ME },
      { time: "2026-05-04 09:00", kind: "focus-pin", by: ME, note: "1001 系统设计" },
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
  // Only personal needs explicit picking; knowledge + notes are public/all.
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

export function createPromoteLoop(filePath: string): string {
  const basename = filePath.split("/").pop()?.replace(/\.md$/, "") || filePath
  const id = uniqueSlug(`promote-${basename}`)
  const ts = nowDisplay()
  const newLoop: Loop = {
    id,
    name: `promote ${basename}`,
    archetype: "context-refine",
    workdir: "(vault)",
    driver: ME,
    participants: 1,
    lastActivityAgo: "just now",
    status: "active",
    context: { knowledge: "all", notes: "all" },
    createdAt: ts,
    createdBy: ME,
    timeline: [{ time: ts, kind: "create", by: ME, note: `把 ${filePath} 提炼到 knowledge` }],
  }
  setLoops([newLoop, ...loops()])
  const time = ts.split(" ")[1] ?? ts
  chats[id] = [
    {
      kind: "user",
      text: `把 \`${filePath}\` 提炼一下放进 knowledge。先读一遍当前内容，给一个目标路径建议（loop/ / ai-org/ / gateway/ / ml/ / conventions/ / skills/ 选一个），再讨论怎么 restructure。`,
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

// Per-mount revisions tracked in this loop's view of context.
// Sync = git pull --rebase semantics; updates the visible revision.
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
  // RFD strips personal context — driver-specific secrets / paths shouldn't
  // hand over to whoever claims next.
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

const GATEWAY_CHAT: ChatItem[] = [
  { kind: "user", text: "trace 已上传 S3，重点看 mr_register 那段", time: "08:42" },
  {
    kind: "ai",
    text:
      "已分析 trace.log（120k 行）。`mr_register` 平均耗时 110s，主因是 cuda alignment 跟 RDMA page size 不匹配。建议把 buffer 对齐到 4096 字节再 register。",
    time: "08:46",
  },
  { kind: "user", text: "我们今晚试一下", time: "08:50" },
  { kind: "driver-change", from: "simpx", to: "阿尔萨斯", time: "14:32" },
  { kind: "user", text: "我先看看 cuda alignment 那块", time: "14:35" },
  {
    kind: "ai",
    text: "alignment 通常是 4096 字节。dump 一下 page 表对照看，重点是 ibv_reg_mr 调用前 buffer 的对齐情况。",
    time: "14:36",
  },
  { kind: "driver-change", from: "阿尔萨斯", to: "simpx", time: "16:00" },
  { kind: "user", text: "我接手了。试着把 buffer pin 到 4K 边界看看", time: "16:01" },
]

const LOOPCTL_CHAT: ChatItem[] = [
  {
    kind: "user",
    text: "Runtime 控制台命令我加进去了 — `loopctl fleet list-shards`。返回值要不要加分页？",
    time: "13:02",
  },
  { kind: "ai", text: "先看下当前实现，再决定怎么改。", time: "13:02" },
  {
    kind: "read",
    path: "api/runtime/list.go",
    startLine: 1,
    total: 88,
    time: "13:02",
    lines: [
      "package runtime",
      "",
      "import (",
      '\t"context"',
      '\t"fmt"',
      "",
      '\t"loopctl/internal/api"',
      ")",
      "",
      "// Shard 表示一个 runtime 数据分片",
      "type Shard struct {",
      "\tID       string",
      "\tRegion   string",
      "\tStatus   string",
      "}",
      "",
      "// ListShards 列出指定 region 下所有 shard",
      "func ListShards(region string) ([]Shard, error) {",
      "\treturn legacyListShards(region)",
      "}",
      "",
      "// legacyListShards 直接返回完整列表",
      "func legacyListShards(region string) ([]Shard, error) {",
      "\treq := &api.FleetReq{Region: region}",
      "\tresp, err := api.FleetClient.ListShards(context.Background(), req)",
      '\tif err != nil { return nil, fmt.Errorf("list shards: %w", err) }',
      "\treturn resp.Shards, nil",
      "}",
    ],
  },
  {
    kind: "ai",
    text: "确认现在没有分页 —— `ListShards` 直接返回完整 `[]Shard`。再看 CLI 包装：",
    time: "13:03",
  },
  {
    kind: "read",
    path: "cmd/runtime.go",
    startLine: 38,
    total: 142,
    time: "13:03",
    lines: [
      "func ListShards(c *cli.Context) error {",
      '\tregion := c.String("region")',
      "\tshards, err := api.ListShards(region)",
      "\tif err != nil { return err }",
      "\treturn render.Table(shards)",
      "}",
    ],
  },
  {
    kind: "ai",
    text: "CLI 也没传 cursor。shard 数量在生产能到几千 —— 加分页有必要。先扫一下所有调用方：",
    time: "13:03",
  },
  {
    kind: "command",
    cmd: 'rg "api\\.ListShards" --type go',
    ok: true,
    time: "13:04",
    output: [
      "api/runtime/list.go:17:func ListShards(region string) ([]Shard, error) {",
      "cmd/runtime.go:40:\tshards, err := api.ListShards(region)",
      'tests/e2e/runtime/list_test.go:42:\tshards, err := api.ListShards("cn-hz")',
      "tests/e2e/region/migrate_test.go:118:\tshards, _ := api.ListShards(src)",
      'tests/e2e/quota/audit_test.go:61:\tall, _ := api.ListShards("cn-bj")',
      "tests/e2e/router/route_test.go:88:\tshards, _ := api.ListShards(region)",
      "contrib/scripts/dump_shards.go:23:\tshards, err := api.ListShards(*region)",
      "",
      "7 matches in 7 files",
    ],
  },
  {
    kind: "ai",
    text:
      "7 处调用 — 4 个 e2e 测试 + 1 个 contrib 脚本 + CLI 主流程 + 实现本身。先动主流程，加 cursor-based 分页；e2e + scripts 后面用 deprecation 处理（不强制 break）。改 `cmd/runtime.go`：",
    time: "13:05",
  },
  {
    kind: "diff",
    file: "cmd/runtime.go",
    time: "13:05",
    lines: [
      { kind: "hunk", text: "@@ -38,8 +38,15 @@ func ListShards(c *cli.Context) error {" },
      { kind: "ctx", ln: 38, text: "func ListShards(c *cli.Context) error {" },
      { kind: "ctx", ln: 39, text: '\tregion := c.String("region")' },
      { kind: "del", ln: 40, text: "\tshards, err := api.ListShards(region)" },
      { kind: "add", ln: 40, text: '\tcursor := c.String("cursor")' },
      { kind: "add", ln: 41, text: '\tlimit := c.Int("limit")' },
      { kind: "add", ln: 42, text: "\tif limit == 0 { limit = 100 }" },
      { kind: "add", ln: 43, text: "\tshards, next, err := api.ListShardsCursor(region, cursor, limit)" },
      { kind: "ctx", ln: 44, text: "\tif err != nil { return err }" },
      { kind: "add", ln: 45, text: '\tif next != "" {' },
      { kind: "add", ln: 46, text: '\t\tfmt.Fprintln(os.Stderr, "next-cursor:", next)' },
      { kind: "add", ln: 47, text: "\t}" },
      { kind: "ctx", ln: 48, text: "\treturn render.Table(shards)" },
      { kind: "ctx", ln: 49, text: "}" },
    ],
  },
  {
    kind: "ai",
    text:
      "再加一个 `ListShardsCursor` 实现到 `api/runtime/list.go`，旧 `ListShards` 保留并代理到新实现：",
    time: "13:06",
  },
  {
    kind: "diff",
    file: "api/runtime/list.go",
    time: "13:06",
    lines: [
      { kind: "hunk", text: "@@ -16,5 +16,9 @@ func ListShards(region string) ([]Shard, error) {" },
      { kind: "ctx", ln: 16, text: "// ListShards 列出指定 region 下所有 shard" },
      { kind: "add", ln: 17, text: "// Deprecated: 使用 ListShardsCursor。下个 release 会移除。" },
      { kind: "ctx", ln: 18, text: "func ListShards(region string) ([]Shard, error) {" },
      { kind: "del", ln: 19, text: "\treturn legacyListShards(region)" },
      { kind: "add", ln: 19, text: '\tdeprecation.Warn("api.ListShards", "use ListShardsCursor instead")' },
      { kind: "add", ln: 20, text: '\tshards, _, err := ListShardsCursor(region, "", 0)' },
      { kind: "add", ln: 21, text: "\treturn shards, err" },
      { kind: "ctx", ln: 22, text: "}" },
      { kind: "hunk", text: "@@ -22,0 +30,12 @@" },
      { kind: "add", ln: 30, text: "// ListShardsCursor 是分页版的 ListShards。" },
      { kind: "add", ln: 31, text: "// limit=0 时由服务端默认（当前 100）。" },
      { kind: "add", ln: 32, text: "func ListShardsCursor(region, cursor string, limit int) ([]Shard, string, error) {" },
      { kind: "add", ln: 33, text: "\treq := &api.FleetReq{" },
      { kind: "add", ln: 34, text: "\t\tRegion: region," },
      { kind: "add", ln: 35, text: "\t\tCursor: cursor," },
      { kind: "add", ln: 36, text: "\t\tLimit:  int32(limit)," },
      { kind: "add", ln: 37, text: "\t}" },
      { kind: "add", ln: 38, text: "\tresp, err := api.FleetClient.ListShards(context.Background(), req)" },
      { kind: "add", ln: 39, text: '\tif err != nil { return nil, "", fmt.Errorf("list shards: %w", err) }' },
      { kind: "add", ln: 40, text: "\treturn resp.Shards, resp.NextCursor, nil" },
      { kind: "add", ln: 41, text: "}" },
    ],
  },
  { kind: "user", text: "改之前先跑测试", time: "13:08" },
  {
    kind: "command",
    cmd: "go test ./cmd/... ./api/...",
    ok: true,
    time: "13:08",
    output: [
      "ok  \tloopctl/cmd/fleet\t0.184s",
      "ok  \tloopctl/cmd/router\t0.221s",
      "ok  \tloopctl/cmd/quota\t0.097s",
      "ok  \tloopctl/api/fleet\t0.412s",
      "PASS",
    ],
  },
  { kind: "user", text: "OK，commit", time: "13:10" },
  {
    kind: "command",
    cmd: 'git commit -am "runtime: paginate list-shards (cursor + limit)"',
    ok: true,
    time: "13:10",
    output: [
      "[feat/fleet-shards 4f2c19a] runtime: paginate list-shards (cursor + limit)",
      " 2 files changed, 38 insertions(+), 4 deletions(-)",
    ],
  },
  {
    kind: "todo",
    title: "post-commit checklist",
    time: "13:10",
    items: [
      { done: true, text: "go test ./..." },
      { done: true, text: "git commit -m 'runtime: paginate list-shards'" },
      { done: false, text: "处理 e2e 4 个 deprecated callers" },
      { done: false, text: "起草 CHANGELOG" },
      { done: false, text: "git push + open MR" },
    ],
  },
  {
    kind: "ai",
    text:
      "现在处理 e2e 调用方 — 跑一遍看 deprecation log 出不出来：",
    time: "13:12",
  },
  {
    kind: "command",
    cmd: "go test ./tests/e2e/...",
    ok: true,
    time: "13:13",
    output: [
      "DEPRECATION  api.ListShards: use ListShardsCursor instead",
      "  → tests/e2e/runtime/list_test.go:42",
      "  → tests/e2e/region/migrate_test.go:118",
      "  → tests/e2e/quota/audit_test.go:61",
      "  → tests/e2e/router/route_test.go:88",
      "(4 callers, will be removed in v0.7)",
      "",
      "ok  \tloopctl/tests/e2e/fleet\t1.24s",
      "ok  \tloopctl/tests/e2e/region\t0.92s",
      "ok  \tloopctl/tests/e2e/quota\t1.17s",
      "ok  \tloopctl/tests/e2e/router\t0.81s",
      "PASS",
    ],
  },
  { kind: "user", text: "deprecation log 看着 OK。CHANGELOG 帮我起草一下", time: "13:15" },
  {
    kind: "artifact",
    path: "CHANGELOG.md",
    lines: 18,
    time: "13:16",
    preview:
      "## [Unreleased]\n\n### Added\n- `loopctl fleet list-shards` 支持 `--cursor` / `--limit` 参数\n- `api.ListShardsCursor` — paginated 版本的 ListShards\n\n### Deprecated\n- `api.ListShards` (无分页版) — v0.7 将移除，建议改用 `ListShardsCursor`",
  },
  {
    kind: "user",
    text: "再确认一件事 — quota 那条命令也是同样形态对吧？要不要顺手把它也改了？",
    time: "13:19",
  },
  { kind: "ai", text: "扫一下 quota 那边的实现：", time: "13:19" },
  {
    kind: "read",
    path: "api/quota/list.go",
    startLine: 12,
    total: 64,
    time: "13:19",
    lines: [
      "// ListQuotas 列出 region 下所有 quota 项",
      "func ListQuotas(region string) ([]Quota, error) {",
      "\treq := &api.QuotaReq{Region: region}",
      "\tresp, err := api.QuotaClient.List(context.Background(), req)",
      '\tif err != nil { return nil, fmt.Errorf("list quotas: %w", err) }',
      "\treturn resp.Items, nil",
      "}",
    ],
  },
  {
    kind: "ai",
    text:
      "签名一致，但 quota 数据规模比 shards 小一个数量级（每 region ~200 条），分页收益不大。\n\n建议**只标记 deprecation 不动逻辑**，等 v0.7 跟 `ListShards` 一起统一升级。",
    time: "13:20",
  },
  { kind: "user", text: "同意。这次只改 runtime，quota 列入下个迭代", time: "13:21" },
  {
    kind: "command",
    cmd: "git push origin feat/fleet-shards",
    ok: true,
    time: "13:24",
    output: [
      "Enumerating objects: 14, done.",
      "Counting objects: 100% (14/14), done.",
      "Writing objects: 100% (8/8), 2.41 KiB | 2.41 MiB/s, done.",
      "remote: Create MR for branch feat/fleet-shards:",
      "remote:   https://git.example.com/loopctl/-/merge_requests/new",
      "To git.example.com:loopctl/loopctl.git",
      " * [new branch]      feat/fleet-shards -> feat/fleet-shards",
    ],
  },
  {
    kind: "todo",
    title: "next iteration (v0.7)",
    time: "13:25",
    items: [
      { done: false, text: "迁移 quota list 到 cursor 分页" },
      { done: false, text: "正式删除 api.ListShards (legacy)" },
      { done: false, text: "更新 README 命令说明" },
      { done: false, text: "通知 contrib/scripts 维护者升级" },
    ],
  },
]

const MIRROR_CHAT: ChatItem[] = [
  { kind: "user", text: "mirror env p99 latency 突然跳到 240ms（baseline 120ms）", time: "10:11" },
  {
    kind: "ai",
    text:
      "拉了 SLS：\n\n| metric | 1h ago | now |\n|---|---|---|\n| p99 | 124ms | 238ms |\n| qps | 410 | 408 |\n| cache_hit | 0.78 | 0.41 |\n\n看起来是 cache 命中率掉了。10:00 有过一次 model swap，怀疑是 warmup 没生效。",
    time: "10:12",
  },
  { kind: "user", text: "swap log 在哪", time: "10:13" },
  {
    kind: "command",
    cmd: "kubectl logs deploy/mirror-llama -c sidecar | grep -i swap",
    ok: true,
    time: "10:14",
    output: [
      "10:01:22 INFO  swap_request received: model=v4-pro -> v4-pro-quant",
      "10:01:24 WARN  cache_warmup skipped (flag --warm-on-swap=false)",
      "10:01:25 INFO  swap committed",
    ],
  },
  { kind: "ai", text: "原因坐实 — `--warm-on-swap=false`。打 patch 改回 true：", time: "10:14" },
  {
    kind: "diff",
    file: "deploy/mirror-llama.yaml",
    time: "10:15",
    lines: [
      { kind: "hunk", text: "@@ -23,7 +23,7 @@ args:" },
      { kind: "ctx", text: '  - "--port=8080"' },
      { kind: "del", text: '  - "--warm-on-swap=false"' },
      { kind: "add", text: '  - "--warm-on-swap=true"' },
      { kind: "ctx", text: '  - "--mirror-pct=10"' },
    ],
  },
  { kind: "user", text: "我有个会，先 release 一下让别人接手 rollout", time: "10:16" },
  { kind: "rfd", by: ME, time: "10:16" },
]

const LLAMA_RESEARCH_CHAT: ChatItem[] = [
  // ----- 伊利丹 phase (creator + initial driver) -----
  { kind: "user", text: "调研一下 llama-3 long-context 表现", time: "yesterday 16:20" },
  {
    kind: "ai",
    text:
      "查了官方 tech report + recent papers。要点：\n- 32k 长度上 needle-in-haystack 95%+\n- 128k 长度 attention IO 是瓶颈\n- 超过 64k 后 quality 缓慢下降",
    time: "yesterday 16:21",
  },
  {
    kind: "artifact",
    path: "knowledge/llama-3-long-context.md",
    lines: 84,
    time: "yesterday 16:23",
    preview:
      "# Llama-3 Long Context\n\n## 关键发现\n- 32k 内表现稳定，95%+ recall\n- 64k–128k 长度上 attention IO bound\n- ...",
  },
  { kind: "user", text: "attention 部分单独写一篇 deeper", time: "yesterday 17:02" },
  {
    kind: "artifact",
    path: "knowledge/llama-3-attention.md",
    lines: 132,
    time: "yesterday 17:30",
    preview:
      "# Llama-3 Attention 实现\n\nMLA (Multi-head Latent Attention) 把 KV cache 压缩成 latent vector...",
  },
  { kind: "user", text: "下周开会再看 prefill 优化空间。先 release，谁先有空谁接", time: "yesterday 17:35" },
  { kind: "rfd", by: "伊利丹", time: "yesterday 17:35" },

  // ----- claim transition: simpx takes over -----
  { kind: "claim", by: ME, time: "today 08:00" },

  // ----- simpx phase (current driver) -----
  { kind: "user", text: "伊利丹说让我接 prefill。先看下现在 prefill 在 64k 上的 tps", time: "today 08:01" },
  {
    kind: "ai",
    text: "扫一下 traces 里的 prefill 数据：",
    time: "today 08:02",
  },
  {
    kind: "command",
    cmd: "jq '.[] | select(.phase==\"prefill\") | {len, ms, gpu_util}' traces/long_context_eval.json | head -20",
    ok: true,
    time: "today 08:02",
    output: [
      '{"len": 65536, "ms": 4820, "gpu_util": 0.41}',
      '{"len": 65536, "ms": 4910, "gpu_util": 0.39}',
      '{"len": 98304, "ms": 8240, "gpu_util": 0.36}',
      '{"len": 131072, "ms": 12940, "gpu_util": 0.33}',
      '{"len": 131072, "ms": 13110, "gpu_util": 0.32}',
    ],
  },
  {
    kind: "ai",
    text:
      "Prefill 阶段 GPU util 只有 30-40%，明显 IO bound。结合伊利丹写的 attention 文档，瓶颈在 attention IO，不是 compute。\n\n几个可能方向：\n1. **chunked prefill** —— 切 block 流水化\n2. **shared prefix cache** —— 同 prompt 前缀复用\n3. **flash-attention v3 + paged kv** —— 减 IO trip 数",
    time: "today 08:05",
  },
  { kind: "user", text: "把这些写进 follow-up notes，我下午再深入看 #1", time: "today 08:08" },
  {
    kind: "artifact",
    path: "knowledge/llama-3-prefill-followups.md",
    lines: 38,
    time: "today 08:10",
    preview:
      "# Llama-3 Prefill 优化方向\n\n基于伊利丹的 attention 调研 + 今天的 trace 分析。\n\n## 候选方向\n1. chunked prefill\n2. shared prefix cache\n3. flash-attention v3 + paged kv",
  },
]

const KNOWLEDGE_REFINE_CHAT: ChatItem[] = [
  { kind: "user", text: "帮我把 docs/loopey/ 下的 12 个 md 重新分类，太乱了", time: "11:00" },
  {
    kind: "ai",
    text:
      "扫了一遍 12 个文件，按主题归并大致是 4 类：\n\n| 主题 | 文件数 |\n|---|---|\n| introduction | 3 |\n| sls (日志服务) | 4 |\n| runtime (管控) | 3 |\n| modelboard | 2 |\n\n建议每类一个目录。",
    time: "11:01",
  },
  {
    kind: "todo",
    title: "context refine plan",
    time: "11:01",
    items: [
      { done: true, text: "读取 docs/loopey/* (12 files)" },
      { done: true, text: "提议分类：introduction / sls / runtime / modelboard" },
      { done: false, text: "执行 git mv" },
      { done: false, text: "扫 broken 链接，修内部引用" },
      { done: false, text: "更新 docs/loopey/CLAUDE.md 索引" },
      { done: false, text: "verify: rg 旧路径无残留" },
    ],
  },
  { kind: "user", text: "go", time: "11:03" },
  {
    kind: "diff",
    file: "docs/loopey/ (renames)",
    time: "11:04",
    lines: [
      { kind: "hunk", text: "@@ rename plan @@" },
      { kind: "del", text: "- docs/loopey/intro-llm.md" },
      { kind: "add", text: "+ docs/loopey/introduction/llm.md" },
      { kind: "del", text: "- docs/loopey/sls-overview.md" },
      { kind: "add", text: "+ docs/loopey/sls/overview.md" },
      { kind: "del", text: "- docs/loopey/fleet-quota.md" },
      { kind: "add", text: "+ docs/loopey/fleet/quota.md" },
      { kind: "ctx", text: "  …(6 more renames)" },
    ],
  },
  {
    kind: "command",
    cmd: "git status -s",
    ok: true,
    time: "11:05",
    output: [
      "R  docs/loopey/intro-llm.md -> docs/loopey/introduction/llm.md",
      "R  docs/loopey/sls-overview.md -> docs/loopey/sls/overview.md",
      "R  docs/loopey/fleet-quota.md -> docs/loopey/fleet/quota.md",
      "R  …(6 more)",
      " M docs/loopey/CLAUDE.md",
    ],
  },
  {
    kind: "ai",
    text: "扫了一下文件**内部**引用，发现 4 处指向旧路径的 broken link。要不要一起修？",
    time: "11:07",
  },
  {
    kind: "artifact",
    path: "_audit/broken-links-2026-05-05.md",
    lines: 24,
    time: "11:07",
    preview:
      "# Broken internal links (after rename)\n\n- docs/loopey/introduction/llm.md L42 → `[SLS](../sls-overview.md)` (旧)\n- docs/loopey/sls/overview.md L8 → `[Fleet quota](../fleet-quota.md)` (旧)\n- docs/loopey/fleet/quota.md L31 → `[introduction](../intro-llm.md)` (旧)\n- docs/loopey/modelboard/draft.md L19 → `[SLS](../sls-overview.md)` (旧)",
  },
  { kind: "user", text: "修，但保留 redirect 注释方便我以后追溯", time: "11:09" },
  {
    kind: "diff",
    file: "docs/loopey/introduction/llm.md",
    time: "11:10",
    lines: [
      { kind: "hunk", text: "@@ -40,7 +40,8 @@" },
      { kind: "ctx", text: "## SLS 集成" },
      { kind: "ctx", text: "" },
      { kind: "del", text: "日志通过 [SLS](../sls-overview.md) 上报。" },
      { kind: "add", text: "<!-- moved: ../sls-overview.md → ../sls/overview.md -->" },
      { kind: "add", text: "日志通过 [SLS](../sls/overview.md) 上报。" },
    ],
  },
  {
    kind: "ai",
    text: "另外 3 个文件同样修了。再更新 CLAUDE.md 索引：",
    time: "11:12",
  },
  {
    kind: "diff",
    file: "docs/loopey/CLAUDE.md",
    time: "11:13",
    lines: [
      { kind: "hunk", text: "@@ -3,12 +3,18 @@ # Loopey Knowledge Index" },
      { kind: "del", text: "- intro-llm.md — LLM 介绍" },
      { kind: "del", text: "- sls-overview.md — SLS 日志" },
      { kind: "del", text: "- fleet-quota.md — Fleet 配额" },
      { kind: "ctx", text: "" },
      { kind: "add", text: "## introduction/" },
      { kind: "add", text: "- llm.md — LLM 介绍" },
      { kind: "add", text: "" },
      { kind: "add", text: "## sls/" },
      { kind: "add", text: "- overview.md — SLS 日志" },
      { kind: "add", text: "" },
      { kind: "add", text: "## runtime/" },
      { kind: "add", text: "- quota.md — Fleet 配额" },
      { kind: "ctx", text: "  …(同样 3 类目录展开)" },
    ],
  },
  {
    kind: "command",
    cmd: "rg -l 'intro-llm.md|sls-overview.md|fleet-quota.md' docs/",
    ok: true,
    time: "11:15",
    output: [
      "(no matches)",
      "✓ 旧路径在 docs/ 内已无残留",
    ],
  },
  { kind: "user", text: "齐了，commit", time: "11:16" },
  {
    kind: "command",
    cmd: "git add -A && git commit -m 'docs/loopey: reorg by topic + fix internal links'",
    ok: true,
    time: "11:17",
    output: [
      "[main 7c4a812] docs/loopey: reorg by topic + fix internal links",
      " 17 files changed, 84 insertions(+), 71 deletions(-)",
      " rename docs/loopey/{intro-llm.md => introduction/llm.md} (84%)",
      " rename docs/loopey/{sls-overview.md => sls/overview.md} (91%)",
      " rename docs/loopey/{fleet-quota.md => runtime/quota.md} (88%)",
      " …(6 more renames)",
    ],
  },
  {
    kind: "ai",
    text:
      "顺手提一个：这次 refine 的 layout（**主题目录 + CLAUDE.md 索引 + 内部链接用相对路径**）其实是一个可复用约定。要不要抽成 `knowledge/conventions/loopey-style-knowledge-layout.md`，让其他 workspace 的 docs 也照这个走？",
    time: "11:18",
  },
  {
    kind: "user",
    text: "好主意 — 但这个属于跨 workspace 的事，单独开个 loop 推。先在这条 loop 里 close。",
    time: "11:19",
  },
  {
    kind: "todo",
    title: "follow-ups (out of this loop)",
    time: "11:19",
    items: [
      { done: false, text: "spawn loop: knowledge-layout-convention" },
      { done: false, text: "在 1001 docs 里加'约定 = 减熵'示例" },
      { done: false, text: "巡检其他 workspace 的 docs/ 是否也乱" },
    ],
  },
]

const DESIGN_CHAT: ChatItem[] = [
  { kind: "user", text: "再过一遍 4 个一级概念跟稀缺资源的对应", time: "10:30" },
  {
    kind: "ai",
    text:
      "驱动力 ↔ Loop（决定做 X + 过程判断力 feedback）。\n注意力 ↔ Focus（识别什么重要、什么不该做）。\n熵减能力 ↔ Context（把混乱整理成清晰）。\nChat 是 sync 协调通道，不在稀缺资源轴上。",
    time: "10:31",
  },
  { kind: "user", text: "Focus 那条要不要叫 vision/品位？", time: "10:35" },
  {
    kind: "ai",
    text: "讨论过 — 最后保留'注意力'，因为呼应 Focus 这个词；但描述里强调它是'主动取舍'而不是'被动稀缺'。",
    time: "10:35",
  },
  {
    kind: "artifact",
    path: "knowledge/ai-org/1001-philosophy.md",
    lines: 47,
    time: "10:38",
    preview:
      "# 1001 Philosophy\n\n## Driver = human\n\nAI has no autonomous desire. The driver — the source of intent — must be human.",
  },
]

export const chats: Record<string, ChatItem[]> = {
  "gateway-launch": GATEWAY_CHAT,
  loopctl: LOOPCTL_CHAT,
  "mirror-llama-3": MIRROR_CHAT,
  "llama-research": LLAMA_RESEARCH_CHAT,
  "knowledge-refine": KNOWLEDGE_REFINE_CHAT,
  "1001-design": DESIGN_CHAT,
}
