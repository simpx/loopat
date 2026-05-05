/**
 * Module-level signals for the prototype. Pure mock — no backend, no
 * persistence. Mutations (fork, RFD release, claim, edit) update signals.
 */
import { createSignal } from "solid-js"

export const ME = "simpx"

export type LoopStatus = "active" | "idle" | "archived"

export type LoopContext = {
  knowledge: "all" | string[]   // "all" = full public knowledge; otherwise scoped paths
  repos: string[]               // mounted git repos available as read material
  // future: skills, mcp servers
}

export type Loop = {
  id: string
  name: string
  archetype: "code" | "research" | "online" | "context-refine" | "design"
  workdir?: string             // optional — pure-discussion loops have none
  branch?: string
  driver: string
  participants: number
  lastActivityAgo: string
  status: LoopStatus
  inFocus?: ("pinned" | "listed")[]
  forkedFrom?: string
  rfd?: boolean                // true = driver has released; anyone can claim
  context: LoopContext
}

export type DiffLine = { kind: "ctx" | "add" | "del" | "hunk"; text: string }

export type ChatItem =
  | { kind: "user"; text: string; time: string }
  | { kind: "ai"; text: string; time: string }
  | { kind: "driver-change"; from: string; to: string; time: string }
  | { kind: "rfd"; by: string; time: string }
  | { kind: "claim"; by: string; time: string }
  | { kind: "diff"; file: string; lines: DiffLine[]; time: string }
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
    context: { knowledge: "all", repos: ["loopey-runtime", "vllm"] },
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
    context: { knowledge: "all", repos: ["loopctl"] },
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
    rfd: true,
    context: {
      knowledge: "all",
      repos: ["shadow-llama-3-70b", "loopey-runtime"],
    },
  },
  {
    id: "llama-research",
    name: "llama-research",
    archetype: "research",
    workdir: "~/workspace/llama_research",
    driver: ME,
    participants: 1,
    lastActivityAgo: "1d",
    status: "idle",
    inFocus: ["listed"],
    context: { knowledge: "all", repos: ["llama_research", "vllm"] },
  },
  {
    id: "ccx-refine",
    name: "ccx-refine",
    archetype: "context-refine",
    workdir: "~/workspace/ccx",
    driver: ME,
    participants: 1,
    lastActivityAgo: "2h",
    status: "active",
    context: { knowledge: "all", repos: [] },
  },
  {
    id: "1001-design",
    name: "1001-design",
    archetype: "design",
    // no workdir — pure design discussion drawing on knowledge
    driver: ME,
    participants: 2,
    lastActivityAgo: "26m",
    status: "active",
    inFocus: ["pinned"],
    context: { knowledge: "all", repos: [] },
  },
]

export const [loops, setLoops] = createSignal<Loop[]>(initialLoops)
export const [currentLoopId, setCurrentLoopId] = createSignal<string>("loopctl")

const updateLoop = (id: string, patch: Partial<Loop>) => {
  setLoops(loops().map((l) => (l.id === id ? { ...l, ...patch } : l)))
}

export function forkLoop(sourceId: string): string {
  const source = loops().find((l) => l.id === sourceId)
  if (!source) return sourceId
  const newId = `${source.id}-fork-${Date.now().toString(36).slice(-4)}`
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
  }
  setLoops([newLoop, ...loops()])
  setCurrentLoopId(newId)
  return newId
}

export function releaseRfd(id: string) {
  updateLoop(id, { rfd: true })
}

export function claimDrive(id: string) {
  updateLoop(id, { driver: ME, rfd: false })
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
  {
    kind: "ai",
    text: "shard 数量随集群规模会到几千，建议加 cursor-based 分页。我改一下 cmd/runtime.go。",
    time: "13:02",
  },
  {
    kind: "diff",
    file: "cmd/runtime.go",
    time: "13:03",
    lines: [
      { kind: "hunk", text: "@@ -41,7 +41,12 @@ func ListShards(c *cli.Context) error {" },
      { kind: "ctx", text: '\tregion := c.String("region")' },
      { kind: "del", text: "\tshards, err := api.ListShards(region)" },
      { kind: "add", text: '\tcursor := c.String("cursor")' },
      { kind: "add", text: '\tlimit := c.Int("limit")' },
      { kind: "add", text: "\tshards, next, err := api.ListShards(region, cursor, limit)" },
      { kind: "ctx", text: "\tif err != nil { return err }" },
      { kind: "add", text: '\tfmt.Fprintln(os.Stderr, "next-cursor:", next)' },
      { kind: "ctx", text: "\treturn render.Table(shards)" },
    ],
  },
  { kind: "user", text: "改之前先跑测试", time: "13:05" },
  {
    kind: "command",
    cmd: "go test ./cmd/...",
    ok: true,
    time: "13:05",
    output: [
      "ok  \tloopctl/cmd/fleet\t0.184s",
      "ok  \tloopctl/cmd/router\t0.221s",
      "ok  \tloopctl/cmd/quota\t0.097s",
      "PASS",
    ],
  },
  { kind: "user", text: "OK，commit", time: "13:07" },
  {
    kind: "todo",
    title: "post-commit checklist",
    time: "13:07",
    items: [
      { done: true, text: "go test ./..." },
      { done: true, text: "git commit -m 'runtime: paginate list-shards'" },
      { done: false, text: "git push origin feat/fleet-shards" },
      { done: false, text: "open MR + ping reviewers" },
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
]

const CCX_REFINE_CHAT: ChatItem[] = [
  { kind: "user", text: "帮我把 docs/loopey/ 下的 12 个 md 重新分类，太乱了", time: "11:00" },
  {
    kind: "todo",
    title: "context refine plan",
    time: "11:01",
    items: [
      { done: true, text: "读取 docs/loopey/* (12 files)" },
      { done: true, text: "提议分类：introduction / sls / runtime / modelboard" },
      { done: false, text: "执行 git mv" },
      { done: false, text: "更新 ccx CLAUDE.md 索引" },
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
      "R  …",
      " M docs/loopey/CLAUDE.md",
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
  "loopctl": LOOPCTL_CHAT,
  "mirror-llama-3": MIRROR_CHAT,
  "llama-research": LLAMA_RESEARCH_CHAT,
  "ccx-refine": CCX_REFINE_CHAT,
  "1001-design": DESIGN_CHAT,
}
