/**
 * Per-loop workspace mocks: file tree + file contents.
 *
 * Each loop has its own workdir with realistic-looking files. Artifacts
 * created in chat (knowledge/*.md, CHANGELOG.md, etc.) live as actual
 * entries in fileContents, so clicking the artifact card opens the
 * file in the editor with proper content.
 */
export type FileNode =
  | {
      kind: "folder"
      name: string
      children: FileNode[]
      mount?: "ro" | "rw" | "selective"
      revision?: string
      secret?: boolean
      onSync?: () => void
      display?: "section"
      hint?: string
    }
  | {
      kind: "file"
      name: string
      path: string
      modified?: boolean
      staged?: boolean
      readonly?: boolean
      linkTo?: string
    }

export type LoopWorkspace = {
  fileTree: FileNode[]
  fileContents: Record<string, string>
}

// ----- prototype-hifi: simpx 这条 loop 干的事就是这个 prototype 本身 -----

const prototypeHifi: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "src",
      children: [
        { kind: "file", name: "App.tsx", path: "src/App.tsx", modified: true },
        { kind: "file", name: "state.ts", path: "src/state.ts", modified: true },
        {
          kind: "folder",
          name: "pages",
          children: [
            { kind: "file", name: "loop.tsx", path: "src/pages/loop.tsx", modified: true },
            { kind: "file", name: "focus.tsx", path: "src/pages/focus.tsx", modified: true },
            { kind: "file", name: "chat.tsx", path: "src/pages/chat.tsx", modified: true },
            { kind: "file", name: "context.tsx", path: "src/pages/context.tsx", modified: true },
          ],
        },
        {
          kind: "folder",
          name: "components",
          children: [
            { kind: "file", name: "code-editor.tsx", path: "src/components/code-editor.tsx" },
            { kind: "file", name: "icon.tsx", path: "src/components/icon.tsx" },
            { kind: "file", name: "markdown.tsx", path: "src/components/markdown.tsx" },
          ],
        },
        {
          kind: "folder",
          name: "mock",
          children: [{ kind: "file", name: "files.ts", path: "src/mock/files.ts", modified: true }],
        },
        { kind: "file", name: "index.tsx", path: "src/index.tsx" },
        { kind: "file", name: "index.css", path: "src/index.css" },
      ],
    },
    { kind: "file", name: "index.html", path: "index.html" },
    { kind: "file", name: "package.json", path: "package.json" },
    { kind: "file", name: "vite.config.ts", path: "vite.config.ts" },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "README.md": `# 1001 Phase 1 — Hi-Fi Prototype

Phase 1 产出：高保真、可交互（signal 驱动）的 4 一级概念
（Loop / Focus / Chat / Context）UI 原型。

## 跑起来
\`\`\`sh
bun install
bun dev
\`\`\`

## 技术栈
- Vite + SolidJS + Tailwind v4
- 不用 router 之外的库，纯 signal
- 不用后端，module-level signals + 内存 mock`,
    "package.json": `{
  "name": "phase1-prototype",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build"
  },
  "dependencies": {
    "@solidjs/router": "^0.16.1",
    "solid-js": "^1.9.12",
    "@codemirror/lang-javascript": "^6.2.5",
    "marked": "^18.0.3"
  }
}`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>1001 · loopat</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>`,
  },
}

// ----- loopat-runtime-spike: simpx fork 了 opencode，加 driver/rfd 字段 -----

const loopatRuntimeSpike: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "packages",
      children: [
        {
          kind: "folder",
          name: "server",
          children: [
            {
              kind: "folder",
              name: "src",
              children: [
                { kind: "file", name: "session.ts", path: "packages/server/src/session.ts", modified: true, staged: true },
                { kind: "file", name: "project.ts", path: "packages/server/src/project.ts" },
                { kind: "file", name: "attach.ts", path: "packages/server/src/attach.ts", modified: true, staged: true },
                { kind: "file", name: "ws-server.ts", path: "packages/server/src/ws-server.ts" },
              ],
            },
          ],
        },
        {
          kind: "folder",
          name: "desktop",
          children: [{ kind: "file", name: "main.ts", path: "packages/desktop/main.ts" }],
        },
        {
          kind: "folder",
          name: "cli",
          children: [{ kind: "file", name: "index.ts", path: "packages/cli/index.ts" }],
        },
      ],
    },
    { kind: "file", name: "package.json", path: "package.json" },
    { kind: "file", name: "README.md", path: "README.md" },
    { kind: "file", name: "ATTACH-SPEC.md", path: "ATTACH-SPEC.md", modified: true, staged: true },
  ],
  fileContents: {
    "packages/server/src/session.ts": `// opencode session = chat history + tool calls + working state
// 1001 fork: 加 driver / rfd 字段

export class Session {
  id: string
  projectId: string
  driver: string  // 1001 extension: who drives this loop
  rfd: boolean    // 1001 extension: released for drive
  messages: Message[]

  constructor(id: string, projectId: string, driver: string) {
    this.id = id
    this.projectId = projectId
    this.driver = driver
    this.rfd = false
    this.messages = []
  }

  release() {
    this.rfd = true
  }

  claim(by: string) {
    this.driver = by
    this.rfd = false
  }
}`,
    "ATTACH-SPEC.md": `# Attach 协议草稿

## Topic
\`/loop/<id>\` — ws subscription

## Events (server → client)
- \`snapshot\` — 完整 loop state
- \`message\` — 新 chat 增量
- \`timeline\` — driver-change / rfd / claim / fork
- \`tool-call\` — AI 调工具中间状态

## Events (client → server)
- \`user-input\` — 当前 driver 发的消息
- \`claim\` — 非 driver 想 claim drive

明早跟 panlilu 对一遍，看 trpc + ws 那边怎么对应。`,
    "README.md": `# loopat (fork of sst/opencode)

1001 prototype branch — 加 driver / rfd / focus / chat-as-context 等 1001 语义。

\`\`\`sh
bun install
bun run --filter=server dev
\`\`\``,
  },
}

// ----- loopat-ts-mvp: panlilu 的自建路线 (Next.js + tRPC + Prisma + WS) -----

const loopatTsMvp: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "prisma",
      children: [
        { kind: "file", name: "schema.prisma", path: "prisma/schema.prisma", modified: true, staged: true },
        { kind: "file", name: "seed.ts", path: "prisma/seed.ts" },
      ],
    },
    {
      kind: "folder",
      name: "src",
      children: [
        {
          kind: "folder",
          name: "server",
          children: [
            {
              kind: "folder",
              name: "api",
              children: [
                { kind: "file", name: "loopRouter.ts", path: "src/server/api/loopRouter.ts", modified: true, staged: true },
                { kind: "file", name: "focusRouter.ts", path: "src/server/api/focusRouter.ts" },
                { kind: "file", name: "root.ts", path: "src/server/api/root.ts" },
              ],
            },
            {
              kind: "folder",
              name: "ws",
              children: [
                { kind: "file", name: "attach.ts", path: "src/server/ws/attach.ts", modified: true },
              ],
            },
            { kind: "file", name: "db.ts", path: "src/server/db.ts" },
          ],
        },
        {
          kind: "folder",
          name: "app",
          children: [
            {
              kind: "folder",
              name: "dashboard",
              children: [{ kind: "file", name: "page.tsx", path: "src/app/dashboard/page.tsx" }],
            },
            { kind: "file", name: "layout.tsx", path: "src/app/layout.tsx" },
            { kind: "file", name: "page.tsx", path: "src/app/page.tsx" },
          ],
        },
        {
          kind: "folder",
          name: "trpc",
          children: [{ kind: "file", name: "react.tsx", path: "src/trpc/react.tsx" }],
        },
      ],
    },
    { kind: "file", name: "package.json", path: "package.json" },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "prisma/schema.prisma": `model Loop {
  id              String        @id @default(cuid())
  name            String
  archetype       LoopArchetype @default(code)
  workdir         String
  branch          String?
  driverName      String
  rfd             Boolean       @default(false)
  forkedFrom      String?
  status          LoopStatus    @default(active)
  timeline        TimelineEvent[]
  chatMounts      ChatMount[]
  focuses         FocusOnLoop[]
  createdAt       DateTime      @default(now())
}

model TimelineEvent {
  id      String            @id @default(cuid())
  loopId  String
  kind    TimelineEventKind
  byName  String
  fromVal String?
  toVal   String?
  note    String?
  createdAt DateTime @default(now())
  loop    Loop @relation(fields: [loopId], references: [id])
}

model ChatMount {
  loopId    String
  channelId String
  upTo      Int
  loop      Loop @relation(fields: [loopId], references: [id])
  @@id([loopId, channelId])
}

enum LoopArchetype { code research online context_refine design }
enum LoopStatus { active idle archived }
enum TimelineEventKind { create driver_change rfd claim fork focus_pin }`,
    "src/server/api/loopRouter.ts": `import { z } from "zod"
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc"

export const loopRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ scope: z.enum(["mine", "all", "rfd"]).default("mine") }).optional())
    .query(async ({ ctx, input }) => {
      const where = (input?.scope === "mine"
        ? { driverName: ctx.session.user.name }
        : input?.scope === "rfd"
          ? { rfd: true, status: "active" as const }
          : { status: { not: "archived" as const } })
      return ctx.db.loop.findMany({ where, orderBy: { createdAt: "desc" } })
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) =>
      ctx.db.loop.findUnique({
        where: { id: input.id },
        include: { timeline: true, chatMounts: true, focuses: { include: { focus: true } } },
      }),
    ),

  fork: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db.loop.findUniqueOrThrow({ where: { id: input.sourceId } })
      return ctx.db.loop.create({
        data: {
          name: \`\${source.name}-fork\`,
          archetype: source.archetype,
          workdir: source.workdir,
          branch: source.branch ? \`\${source.branch}-fork\` : undefined,
          driverName: ctx.session.user.name!,
          forkedFrom: source.id,
          timeline: { create: { kind: "fork", byName: ctx.session.user.name!, note: \`forked from \${source.name}\` } },
        },
      })
    }),
})`,
    "src/server/ws/attach.ts": `import { WebSocketServer } from "ws"
import type { Loop, TimelineEvent } from "@prisma/client"

// 每个 loop 一个 channel，client subscribe 后立刻收 snapshot + 增量 event。
type LoopChannel = {
  loopId: string
  subscribers: Set<WebSocket>
}

const channels = new Map<string, LoopChannel>()

export function attachToLoop(ws: WebSocket, loopId: string, snapshot: Loop) {
  let ch = channels.get(loopId)
  if (!ch) {
    ch = { loopId, subscribers: new Set() }
    channels.set(loopId, ch)
  }
  ch.subscribers.add(ws)
  ws.send(JSON.stringify({ kind: "snapshot", payload: snapshot }))
  ws.on("close", () => ch!.subscribers.delete(ws))
}

export function broadcastTimeline(loopId: string, event: TimelineEvent) {
  const ch = channels.get(loopId)
  if (!ch) return
  for (const sub of ch.subscribers) {
    sub.send(JSON.stringify({ kind: "timeline", payload: event }))
  }
}`,
    "README.md": `# loopat-ts

panlilu 的自建路线 — Next.js + tRPC + Prisma + Postgres + WS。

并行 simpx 的 opencode-fork spike，周末 close 取舍。

## stack
- Next.js 15 + React 19
- tRPC 11 + react-query
- Prisma + Postgres
- next-auth 5.0-beta + Prisma adapter
- ws 跨 client attach`,
  },
}

// ----- research-opencode: 调研 fork，不一定 commit -----

const researchOpencode: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "packages",
      children: [
        {
          kind: "folder",
          name: "server",
          children: [
            {
              kind: "folder",
              name: "src",
              children: [
                { kind: "file", name: "session.ts", path: "packages/server/src/session.ts", readonly: true },
                { kind: "file", name: "project.ts", path: "packages/server/src/project.ts", readonly: true },
              ],
            },
          ],
        },
      ],
    },
    { kind: "file", name: "ARCHITECTURE.md", path: "ARCHITECTURE.md", readonly: true },
    { kind: "file", name: "README.md", path: "README.md", readonly: true },
  ],
  fileContents: {
    "ARCHITECTURE.md": `# opencode 架构（read-only · clone for study）

## 核心 model
- session = chat history + tool calls + working state
- project = workdir，1:N session
- attach: SSE 单 subscriber

## 适配 1001
见 \`research/opencode-deep-dive.md\` (in notes)`,
  },
}

// ----- research-claude-code: notes-style 调研 -----

const researchClaudeCode: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "claude-code-internals.md", path: "claude-code-internals.md" },
    { kind: "file", name: "skill-system-notes.md", path: "skill-system-notes.md" },
    { kind: "file", name: "hook-points.md", path: "hook-points.md" },
  ],
  fileContents: {
    "claude-code-internals.md": `# Claude Code 内部架构

单进程 CLI，无 multi-client。但扩展机制比 opencode 灵活：
- hooks (pre-tool / post-tool / on-stop)
- skills (SKILL.md 自描述 + 按需加载)
- MCP

不适合直接 fork（跟 1001 c/s 错位），但 skills 系统值得抄。`,
    "skill-system-notes.md": `# Skills System

每个 skill 一个目录，包含 SKILL.md (frontmatter 描述触发条件) + 实现文件。

AI 加载时只读 SKILL.md 元信息；触发时再 inline 加载内容。

我们的 \`knowledge/skills/\` 应该照这个套路走。`,
    "hook-points.md": `# Hook Points

- \`pre-tool\` — 工具调用前
- \`post-tool\` — 工具调用后
- \`on-stop\` — agent loop 结束
- \`user-prompt-submit\` — 用户输入提交时

通过 settings.json 注册 shell command。比 langchain callbacks 简单 + 可编程。`,
  },
}

// ----- site-uptime-spike: rfd-from-birth, 没 workdir 直到有人 claim -----

const siteUptimeSpike: LoopWorkspace = {
  fileTree: [],
  fileContents: {},
}

// ----- demo-video-script: HN show 2-min video draft -----

const demoVideoScript: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "script-v0.md", path: "demo/script-v0.md", modified: true },
    { kind: "file", name: "shot-list.md", path: "demo/shot-list.md" },
    { kind: "file", name: "narration.txt", path: "demo/narration.txt" },
    {
      kind: "folder",
      name: "assets",
      children: [
        { kind: "file", name: "loopat-logo.svg", path: "demo/assets/loopat-logo.svg" },
        { kind: "file", name: "color-palette.png", path: "demo/assets/color-palette.png" },
      ],
    },
  ],
  fileContents: {
    "demo/script-v0.md": `# loopat 2-min demo · v0

## Hook (0:00-0:15)
> AI 工具像 Slack 频道，但工作不该像聊天。
>
> loopat 是一个让 AI 协作不再"频道化"的工具 —— 工作有 driver、有 context、有沉淀。

## 4 一级概念 (0:15-0:45)
- Loop — first-class 工作单元
- Focus — 团队当下注意力 view
- Chat — sync 协调 + ephemeral context
- Context — 团队物料的 distilled 沉淀

## Self-referential demo (0:45-1:30)
打开 prototype-hifi loop。展示：
1. chat → spawn loop 动作（30s）
2. driver release / claim
3. loop 沉淀进 knowledge

## Attach demo (1:30-1:50)
panlilu 端 ws 接好后，多 client mirror。

## CTA (1:50-2:00)
loopat.ai · early access`,
    "demo/shot-list.md": `# Shot list

[Hook]
- A roll: simpx 对着摄像头说 'AI 工具像频道，工作不该像聊天'
- B roll: slack 频道滚动 → 切成 loop 卡片

[4 概念]
- 静态截图扫一遍 4 tab + 文字 overlay

[Self-referential]
- 一镜到底，屏幕录制 prototype 上的真实操作

[Attach]
- 双屏：左边 simpx 操作，右边 panlilu 同步看到

[CTA]
- 全屏 logo + url`,
  },
}

// ----- attach-spec-review: panlilu 接手 review attach spec -----

const attachSpecReview: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "ATTACH-SPEC.md", path: "ATTACH-SPEC.md", modified: true, staged: true },
    { kind: "file", name: "review-notes.md", path: "review-notes.md", modified: true },
    {
      kind: "folder",
      name: "examples",
      children: [
        { kind: "file", name: "client-recover.ts", path: "examples/client-recover.ts" },
        { kind: "file", name: "server-broadcast.ts", path: "examples/server-broadcast.ts" },
      ],
    },
  ],
  fileContents: {
    "ATTACH-SPEC.md": `# Attach 协议草稿

## Topic
\`/loop/<id>\` — ws subscription

## Events (server → client)
- \`snapshot\` — 完整 loop state
- \`message\` — 新 chat 增量
- \`timeline\` — driver-change / rfd / claim / fork
- \`tool-call\` — AI 调工具中间状态

## Events (client → server)
- \`user-input\` — 当前 driver 发的消息
- \`claim\` — 非 driver 想 claim drive

## 决议（panlilu review @ 2026-05-10）

1. **Envelope** — 纯 JSON。protobuf 推迟到 p1 之后
2. **Recover** — client 带 lastEventId，server 重放窗内事件
3. **Auth** — sub 时 workspace token + visibility check；每条 message 不重复

## 待办

- [ ] simpx confirm 决议
- [ ] 写到 knowledge/loopat/attach-protocol-spec.md`,
    "review-notes.md": `# review notes (panlilu)

读 simpx 的草稿，整体方向 OK。三个具体改动建议（已写入 spec 决议段）：

1. envelope 不要 protobuf
2. recover 用 lastEventId
3. auth 在 sub 层，不下沉到 message

## 还没决的

- max replay window: 想了想 24h 应该够，超过这个让 client 重新 sub + snapshot
- ws keep-alive interval: 30s? 跟 cloudflare 默认对齐`,
  },
}

// ----- feature-pricing-sketch: idle 状态，4 天没动 -----

const featurePricingSketch: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "pricing-sketch-v0.md", path: "pricing-sketch-v0.md" },
    { kind: "file", name: "competitor-survey.md", path: "competitor-survey.md" },
  ],
  fileContents: {
    "pricing-sketch-v0.md": `# loopat 定价（草稿 v0）

> 状态：搁置。等 phase 3 之后再 revisit。

## tier
- **Free** — 5 人 workspace，1 active loop / 人，无 attach
- **Team** — $10/u/mo，无限 loop，attach，agent 配额
- **Enterprise** — 谈判，SSO/audit/private install

## 不确定
- 怎么收 agent compute 费用
- workspace 上限 vs seat 上限
- early adopter 永久折扣？`,
    "competitor-survey.md": `# 竞品定价对照

| 工具 | 起步 | 单位 | 主要 gating |
|---|---|---|---|
| Linear | $8/u/mo | seat | 私有 issue / SAML / API |
| Notion | $10/u/mo | seat | team workspace / version history |
| Slack | $7.25/u/mo | seat | unlimited history / SSO |
| Cursor | $20/u/mo | seat | 模型额度 / 高级模型 |

都是 seat-based。Cursor 是个例外：贵 + 含 model usage。

→ 如果 loopat 含 agent compute，可能要走 Cursor 模式？`,
  },
}

// ----- naming-brainstorm: archived，命名史 -----

const namingBrainstorm: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "candidates.md", path: "candidates.md", readonly: true },
    { kind: "file", name: "naming-decision-v1.md", path: "naming-decision-v1.md", readonly: true },
    { kind: "file", name: "naming-decision-v2.md", path: "naming-decision-v2.md", readonly: true },
  ],
  fileContents: {
    "candidates.md": `# brand 名候选 brainstorm

## 否决
- pit 系（pithub / pitops）— 切分歧义
- 造词类（melode / klyma / sheraza）— 怪
- 1001loop / 1001days — 累赘
- loopin — 平凡，记忆点弱
- looped — 暗示"完成"，跟 active loop 反向

## 候选
- loopey.ai — slack 拼写感
- loopat.ai — 内嵌 'pat'

## 决议
loopat.ai (覆盖 v1 的 loopey)`,
    "naming-decision-v2.md": `# 1001 brand 名（决议 v2）

> 覆盖 v1 (loopey.ai)

选 **loopat.ai**

核心：
1. **loop** — 项目核心概念
2. **pat** — 隐藏词，未来产品 UX 动词（给 AI 一个 pat = 反馈）

放弃 'loop at AI' 短语解读 — "loop at" 不是英语 idiom，硬解牵强。

logo: 🧶 (毛线团) — loop 的有机/暖感呈现`,
  },
}

// ----- prototype-hifi-fork-test: panlilu fork 试 react 改写 -----

const prototypeHifiForkTest: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "src",
      children: [
        { kind: "file", name: "App.tsx", path: "src/App.tsx", modified: true },
        { kind: "file", name: "state.ts", path: "src/state.ts", modified: true },
      ],
    },
    { kind: "file", name: "fork-eval.md", path: "fork-eval.md" },
    { kind: "file", name: "package.json", path: "package.json", modified: true },
  ],
  fileContents: {
    "fork-eval.md": `# Fork eval: solid → react 改写值不值得？

## 当前
- codebase 1.6k 行 solid
- 改 react 估计 +20% 行数（react useEffect/useMemo 显式）

## 决议
短期不动。phase 3 SSR 需求评估时再看。`,
    "src/App.tsx": `// React 13 改写尝试 — POC 不完整
import { useState } from "react"

export function App() {
  const [tab, setTab] = useState<"loop" | "focus" | "chat" | "context">("loop")
  // ...
}`,
  },
}

// ============================================================================

export const LOOP_WORKSPACES: Record<string, LoopWorkspace> = {
  "prototype-hifi": prototypeHifi,
  "loopat-runtime-spike": loopatRuntimeSpike,
  "loopat-ts-mvp": loopatTsMvp,
  "research-opencode": researchOpencode,
  "research-claude-code": researchClaudeCode,
  "site-uptime-spike": siteUptimeSpike,
  "demo-video-script": demoVideoScript,
  "attach-spec-review": attachSpecReview,
  "feature-pricing-sketch": featurePricingSketch,
  "naming-brainstorm": namingBrainstorm,
  "prototype-hifi-fork-test": prototypeHifiForkTest,
}

export const EMPTY_WORKSPACE: LoopWorkspace = {
  fileTree: [],
  fileContents: {},
}

export function getWorkspace(loopId: string): LoopWorkspace {
  return LOOP_WORKSPACES[loopId] ?? EMPTY_WORKSPACE
}
