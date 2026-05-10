/**
 * Chat tab — channel/DM rail + conversation pane.
 *
 * Channels and DMs are ephemeral context. The "channel info" bar shows
 * which loops have ingested this channel (loop.context.chats[]).
 */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "../components/icon"
import { loops } from "../state"
import { AGENTS } from "./context"

type ChannelId = string

type Message = {
  id: string
  author: string
  isAi?: boolean
  isMe?: boolean
  text: string
  time: string
}

type Conversation = {
  id: ChannelId
  kind: "channel" | "dm"
  name: string
  unread?: number
  active?: boolean
  topic?: string
  members?: string[]
  messages: Message[]
}

const CHANNELS: Conversation[] = [
  {
    id: "all",
    kind: "channel",
    name: "all",
    topic: "workspace 全员频道 · 也是成员目录",
    members: ["simpx", "panlilu", "coo", "ops-bot", "growth-bot"],
    messages: [
      {
        id: "m0a",
        author: "growth-bot",
        isAi: true,
        text:
          "📡 daily digest（昨天）：\n- 0 loopat.ai 注册\n- HN 4 条相关讨论（attached）\n- twitter 8 mentions（'AI org' / 'context engineering'）\n- 没看到直接竞争对手发布",
        time: "yesterday 09:00",
      },
      {
        id: "m0b",
        author: "coo",
        isAi: true,
        text:
          "📊 weekly snapshot 已生成 → notes/memory/weekly-snapshot-2026-05-09.md\n要点：prototype 4 tab 完成、loopat-ts staging 部署、attach 协议草稿（待 panlilu review）",
        time: "yesterday 18:00",
      },
      { id: "m0c", author: "simpx", isMe: true, text: "@panlilu 我把 attach spec 单开 loop 让你 review，rfd 模式，明早接", time: "yesterday 22:00" },
      { id: "m0d", author: "panlilu", text: "👀 收到，明早第一件事", time: "yesterday 22:14" },

      { id: "m1", author: "panlilu", text: "早。今天准备把 trpc routers 写完，attach spec 也看了一下，回头单开 loop 回复 simpx", time: "09:02" },
      { id: "m2", author: "simpx", isMe: true, text: "我这边重写一下 prototype 的 mock 数据，让它更真实，今天的会就用它 demo", time: "09:08" },
      {
        id: "m3",
        author: "coo",
        isAi: true,
        text:
          "@simpx 同步：\n- panlilu 已 claim attach-spec-review loop\n- prototype-hifi 改动量大，需要我帮你拆 mvp doc 同步吗？\n- growth-bot 昨晚抓到 1 条 hn 帖子（下条 message）",
        time: "09:30",
      },
      {
        id: "m6",
        author: "growth-bot",
        isAi: true,
        text:
          "📡 监测到 hn 上一条相关讨论：'show hn: a unified todo + chat hybrid'（37 points, 12 comments）\n— 跟我们的 Loop / Focus 哲学有交集，要不要看一眼对方怎么吃这个市场\nlink: https://news.ycombinator.com/item?id=...",
        time: "10:42",
      },
      { id: "m7", author: "panlilu", text: "看了，他们走的是 todo+chat 合并，没有 driver 单人语义。跟我们方向不同", time: "10:55" },
      { id: "m4", author: "panlilu", text: "👍 周末我们要不要面对面把两条 spike 取舍 close 掉？", time: "11:14" },
      { id: "m5", author: "simpx", isMe: true, text: "可以。本周末，咖啡馆", time: "11:18" },
      {
        id: "m8",
        author: "ops-bot",
        isAi: true,
        text: "🚨 staging.loopat.ai 5xx spike, 已 spawn loop site-uptime-spike (rfd)",
        time: "09:42",
      },
      {
        id: "m9",
        author: "coo",
        isAi: true,
        text:
          "@panlilu 你昨天 staging 部署后接的次新接口（auth callback）疑似在 5xx 风暴名单里。要不要先 rollback 看看？",
        time: "09:45",
      },
      {
        id: "m10",
        author: "panlilu",
        text: "我手头上有事，先 rollback。simpx 你看下 next-auth beta callback 的事，notes/research/next-auth-beta-notes.md 我刚写完",
        time: "09:48",
      },
    ],
  },
  {
    id: "dev",
    kind: "channel",
    name: "dev",
    unread: 2,
    active: true,
    topic: "loopat 开发协作 · 两条 spike 进度同步",
    members: ["simpx", "panlilu", "coo", "ops-bot"],
    messages: [
      { id: "d0a", author: "simpx", isMe: true, text: "今早跑了 opencode 的 monorepo benchmark，bun install 38s，tsc -b 12s。可接受", time: "yesterday 09:14" },
      { id: "d0b", author: "panlilu", text: "我这边 next dev cold start 4.2s，不算慢。trpc 类型推导很爽", time: "yesterday 09:30" },
      { id: "d0c", author: "simpx", isMe: true, text: "@panlilu schema 你打算把 ChatMount 当 first-class 还是 join model？", time: "yesterday 13:00" },
      {
        id: "d0d",
        author: "panlilu",
        text: "first-class，跟 Focus 一样。后期 attach 协议要 ref 它就方便",
        time: "yesterday 13:15",
      },
      {
        id: "d0e",
        author: "coo",
        isAi: true,
        text:
          "我把 'ChatMount = first-class model' 这个决定记到 knowledge/loopat/architecture.md。`已决问题` 段现在 3 条：\n1. ChatMount 走 first-class\n2. driver 字段挂 session metadata\n3. attach SSE → ws",
        time: "yesterday 13:20",
      },
      { id: "d1", author: "simpx", isMe: true, text: "fork opencode 那边 driver 字段加完了，下一步 attach SSE → ws", time: "14:50" },
      {
        id: "d2",
        author: "panlilu",
        text:
          "我这边 prisma schema 写完了 —— Loop / TimelineEvent / ChatMount / Focus / Contact 都建了 model。今天写 trpc routers。",
        time: "15:02",
      },
      {
        id: "d3",
        author: "simpx",
        isMe: true,
        text: "你 schema 里 ChatMount 怎么处理 upTo？ 我们说好了 mount 是 immutable 快照，sync 创建新 mount 还是 mutate？",
        time: "15:12",
      },
      {
        id: "d4",
        author: "panlilu",
        text:
          "现在是 mutate（@@id([loopId, channelId])），sync 就 update upTo。我倾向保留历史会复杂，先不做 versioning。",
        time: "15:15",
      },
      { id: "d5", author: "simpx", isMe: true, text: "OK 同意。先 mutate，需要历史再加", time: "15:16" },
      {
        id: "d6",
        author: "coo",
        isAi: true,
        text: "提醒：刚刚 simpx 跟 panlilu 关于 ChatMount 的取舍我已经记到 knowledge/loopat/architecture.md 的'已决问题'段。",
        time: "15:18",
      },
      {
        id: "d7",
        author: "ops-bot",
        isAi: true,
        text: "🚀 deploy: panlilu/loopat-ts main → staging.loopat.ai \n  build ✓  migrate ✓  health-check ✓ (87s)",
        time: "16:30",
      },
      { id: "d8", author: "panlilu", text: "staging 上去看看 loop list 那个页", time: "16:32" },
      {
        id: "d9",
        author: "simpx",
        isMe: true,
        text:
          "loop list 在 staging 看了。两个建议：\n1. RFD loop 顶部应该有 'incident' 视觉提示，跟 prototype 对齐\n2. driver 字段右侧加个小色点，跟 prototype 一致",
        time: "16:42",
      },
      { id: "d10", author: "panlilu", text: "👌 加入 backlog。这两个还简单", time: "16:45" },
      {
        id: "d11",
        author: "simpx",
        isMe: true,
        text:
          "@panlilu attach spec 我刚单开 loop，rfd 给你了：[attach-spec-review](#)\n你明早接，看完出意见，重点关心 ws envelope / recover / auth 三个问题",
        time: "22:00",
      },
      {
        id: "d12",
        author: "panlilu",
        text: "claim 了。今天 review 完，10:14 写完意见 push 到 spec/attach-v0",
        time: "today 10:14",
      },
      {
        id: "d13",
        author: "coo",
        isAi: true,
        text:
          "@simpx panlilu 把 attach-spec-review 推进到决议阶段，等你 confirm 三件事：\n1. envelope 走 JSON 不上 protobuf\n2. recover 用 lastEventId\n3. auth 在 sub 层一次性\n\n要我帮你拉 simpx 看 → confirm 流程吗？",
        time: "today 10:15",
      },
      { id: "d14", author: "simpx", isMe: true, text: "confirm，三个我都同意。close 那条 loop，结论沉淀进 knowledge/loopat/attach-protocol-spec.md", time: "today 10:42" },
    ],
  },
  {
    id: "ops",
    kind: "channel",
    name: "ops",
    topic: "loopat.ai 站点运维告警 · 自动派单",
    members: ["simpx", "panlilu", "ops-bot"],
    messages: [
      {
        id: "o0a",
        author: "ops-bot",
        isAi: true,
        text:
          "📊 weekly site report (week 19):\n- uptime: 99.94%\n- p99 latency: 142ms\n- 流量峰值：周二 21:30 (412 req/s)\n- 主要错误：next-auth callback (transient)\n- staging deploys: 14 次 (1 rollback)",
        time: "周一 09:00",
      },
      {
        id: "o0b",
        author: "ops-bot",
        isAi: true,
        text:
          "🚀 deploy: simpx/loopat phase1-prototype → preview.loopat.ai/p1\n  build ✓  health-check ✓ (42s)\n  preview url: https://preview.loopat.ai/p1/index.html",
        time: "yesterday 16:14",
      },
      {
        id: "o0c",
        author: "ops-bot",
        isAi: true,
        text:
          "🚀 deploy: panlilu/loopat-ts main → staging.loopat.ai\n  build ✓  migrate ✓ (3 new migrations)  health-check ✓ (87s)\n  → next-auth schema fields: 6 added",
        time: "yesterday 23:15",
      },
      {
        id: "o0d",
        author: "ops-bot",
        isAi: true,
        text:
          "⚠ build warning: \`bun-types@latest\` introduced 2 type errors in src/server/api/loopRouter.ts\n建议：pin 到 1.1.42 或修 import",
        time: "yesterday 23:20",
      },
      {
        id: "o1",
        author: "ops-bot",
        isAi: true,
        text:
          "🚨 5xx 抖动：\n- 09:35–09:42 (7min)\n- 5xx 总量：342 (baseline 8/min)\n- 受影响：/api/auth/callback (78%) · /api/loop (12%)\n- region: cn-shanghai\n- spawn loop `site-uptime-spike` (rfd, 等人接)",
        time: "09:42",
      },
      {
        id: "o2",
        author: "ops-bot",
        isAi: true,
        text:
          "🔄 auto-rollback triggered (10min 内 spike 持续) → staging 回到 \`a2f81b\`\n  健康指标恢复 (p99: 89ms · 5xx: 4/min)",
        time: "09:55",
      },
      {
        id: "o3",
        author: "panlilu",
        text: "rollback 后看了 deploy diff，问题大概率是 next-auth 5.0-beta.25 的 callback 行为变更。我先把它 pin 到 beta.21",
        time: "10:30",
      },
    ],
  },
]

const DMS: Conversation[] = [
  {
    id: "dm-coo",
    kind: "dm",
    name: "coo",
    messages: [
      { id: "c1", author: "simpx", isMe: true, text: "/summarize 今天 #dev 的进展", time: "16:35" },
      {
        id: "c2",
        author: "coo",
        isAi: true,
        text:
          "**今天 #dev 摘要**\n\n- simpx：fork opencode 的 driver 字段加完，下一步 attach SSE→ws\n- panlilu：prisma schema 完成（Loop / TimelineEvent / ChatMount / Focus / Contact），开始写 trpc routers\n- 已决：ChatMount 走 mutate，不做 versioning（先简单）\n- ops-bot：staging.loopat.ai 部署成功（87s）\n\n要不要 spawn 一个 loop 跟踪 attach 协议落地？",
        time: "16:35",
      },
      {
        id: "c3",
        author: "simpx",
        isMe: true,
        text: "暂时不用，已经在 loopat-runtime-spike 里跟踪。帮我拉一下今早 panlilu 关于 ChatMount 的发言原文",
        time: "16:38",
      },
      {
        id: "c4",
        author: "coo",
        isAi: true,
        text:
          "panlilu 在 #dev 15:02 的原文：\n\n> 我这边 prisma schema 写完了 —— Loop / TimelineEvent / ChatMount / Focus / Contact 都建了 model。今天写 trpc routers。\n\n以及 15:15 关于 mutate vs versioning 的取舍：\n\n> 现在是 mutate（@@id([loopId, channelId])），sync 就 update upTo。我倾向保留历史会复杂，先不做 versioning。",
        time: "16:39",
      },
    ],
  },
  {
    id: "dm-panlilu",
    kind: "dm",
    name: "panlilu",
    unread: 1,
    messages: [
      { id: "p0a", author: "panlilu", text: "今天 next-auth 5.0-beta 升 25 之后 callback 行为有变，注意一下", time: "yesterday 11:30" },
      { id: "p0b", author: "simpx", isMe: true, text: "好，我没碰 auth 那块，留意", time: "yesterday 11:35" },
      {
        id: "p0c",
        author: "panlilu",
        text:
          "你在 prototype 里把 contacts 跟 dm 合并那个改动我看了下，#all members 当 directory 这思路挺好。我自建那边照抄了",
        time: "yesterday 14:20",
      },
      { id: "p0d", author: "simpx", isMe: true, text: "你那边 trpc 的 loop.list 怎么处理 RFD 过滤？", time: "yesterday 14:25" },
      {
        id: "p0e",
        author: "panlilu",
        text: "router 接 scope: enum('mine'|'all'|'rfd')，过滤逻辑跟 prototype 完全一致。代码已 push staging",
        time: "yesterday 14:30",
      },
      {
        id: "p1",
        author: "simpx",
        isMe: true,
        text:
          "周末聊两条 spike 取舍前先把数据表对一下 —— 你那边 prisma 的 Loop schema 跟我 fork 这边在 session metadata 上加的 driver/rfd 字段，未来要 merge 还是各自独立？",
        time: "20:14",
      },
      {
        id: "p2",
        author: "panlilu",
        text: "倾向 merge —— 但前提是 attach 协议两边一致。你这周能出 attach spec 草稿吗？",
        time: "20:30",
      },
      { id: "p3", author: "simpx", isMe: true, text: "可以，明天发你", time: "20:32" },
      { id: "p4", author: "panlilu", text: "另外 demo 视频别忘了，hn 那条快定下来", time: "今天 11:02" },
      {
        id: "p5",
        author: "simpx",
        isMe: true,
        text:
          "demo 视频今早开了 loop \`demo-video-script\`，结构搭出来了。0:45-1:30 那段想用今天的工作做 self-referential demo —— prototype 自己就是 demo subject",
        time: "今天 11:15",
      },
      { id: "p6", author: "panlilu", text: "👏 这个钩子很妙。要不要我那边 staging 帮配一个 attach demo 双屏？", time: "今天 11:18" },
      { id: "p7", author: "simpx", isMe: true, text: "要！1:30-1:50 那段就指着你那边接的 ws", time: "今天 11:20" },
      { id: "p8", author: "panlilu", text: "OK 我下午弄。另外你那个 react fork eval loop 我看到了，结论同意短期不动", time: "今天 11:25" },
    ],
  },
]

function agentToConversation(a: typeof AGENTS[number]): Conversation {
  return {
    // agents 跟 humans 共享 dm- 命名空间，name 是 workspace 唯一标识符
    // (跟 mvp doc §1.4 "agent 跟人完全平起" 一致 —— @mention 不分人 / agent)
    id: `dm-${a.id}`,
    kind: "dm",
    name: a.name,
    topic: a.charter,
    messages: a.recentInvocations.map((inv, i) => ({
      id: `${a.id}-inv-${i}`,
      author: a.name,
      isAi: true,
      text: `${inv.preview}\n\n_in ${inv.channel} · ${inv.when}_`,
      time: inv.when,
    })),
  }
}

// DM list = workspace humans + agents merged. Existing detailed DM threads
// (with messages / unread) override the synthesized empty ones.
type DmEntry = {
  conv: Conversation
  kind: "human" | "agent"
  status?: "running" | "idle" | "error"  // agents only
  hasActivity: boolean
}

const HUMAN_MEMBERS = ["panlilu"]

function buildDmList(): DmEntry[] {
  const seen = new Map<string, Conversation>()
  for (const d of DMS) seen.set(d.name, d)

  const entries: DmEntry[] = []
  for (const name of HUMAN_MEMBERS) {
    const existing = seen.get(name)
    const conv: Conversation = existing ?? { id: `dm-${name}`, kind: "dm", name, messages: [] }
    entries.push({ conv, kind: "human", hasActivity: (existing?.messages.length ?? 0) > 0 })
    seen.delete(name)
  }
  for (const a of AGENTS) {
    const existing = seen.get(a.name)
    const conv = existing ?? agentToConversation(a)
    entries.push({
      conv,
      kind: "agent",
      status: a.status,
      hasActivity: (existing?.messages.length ?? 0) > 0,
    })
    seen.delete(a.name)
  }
  // Active threads first, then alphabetical empties
  return entries.sort((a, b) => {
    if (a.hasActivity !== b.hasActivity) return a.hasActivity ? -1 : 1
    return a.conv.name.localeCompare(b.conv.name)
  })
}

export function ChatPage() {
  // URL 模式：
  //   channel: /chat/:id      → params.id 直接用
  //   dm:      /chat/dm/:name → 内部 id 是 dm-<name>
  const params = useParams<{ id?: string; name?: string }>()
  const navigate = useNavigate()
  const active = () => (params.name ? `dm-${params.name}` : params.id ?? "all")
  const setActive = (id: string) => {
    if (id.startsWith("dm-")) navigate(`/chat/dm/${id.slice(3)}`)
    else navigate(`/chat/${id}`)
  }
  const [refExpanded, setRefExpanded] = createSignal(false)
  const dmList = buildDmList()
  const activeDms = () => dmList.filter((e) => e.hasActivity)
  const allConvos = () => [...CHANNELS, ...dmList.map((e) => e.conv)]
  const conversation = () => allConvos().find((c) => c.id === active()) ?? CHANNELS[0]
  const [memberFilter, setMemberFilter] = createSignal("")
  const [membersOpen, setMembersOpen] = createSignal(false)
  const filteredMembers = () => {
    const q = memberFilter().toLowerCase()
    return (conversation().members ?? []).filter((m) => m.toLowerCase().includes(q))
  }
  const memberKind = (name: string): "human" | "agent" =>
    AGENTS.some((a) => a.name === name) ? "agent" : "human"
  // 命名空间统一：humans + agents 都是 `dm-<name>`
  // (workspace 内 name 唯一即可，agent 跟人不区分)
  const memberDmId = (name: string) => `dm-${name}`

  // Loops that have this conversation in their context.chats[].
  const referencedBy = createMemo(() =>
    loops().filter((l) =>
      (l.context.chats ?? []).some((c) => c.id === active()),
    ),
  )

  return (
    <div class="flex h-full w-full">
      {/* Channels rail */}
      <aside class="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 mt-3 mb-1 text-xs text-gray-500 flex items-center justify-between">
          <span>Channels</span>
          <button class="text-gray-500 hover:text-gray-900">
            <Icon name="enter" />
          </button>
        </div>
        <div class="flex flex-col gap-0.5">
          <For each={CHANNELS}>
            {(c) => <ConversationRow conv={c} active={active() === c.id} onClick={() => setActive(c.id)} />}
          </For>
        </div>
        <div class="px-3 mt-3 mb-1 text-xs text-gray-500" title="找新人请去 #all 频道的成员列表">
          Direct messages
        </div>
        <div class="flex flex-col gap-0.5">
          <For each={activeDms()}>
            {(e) => (
              <DmRow
                entry={e}
                active={active() === e.conv.id}
                onClick={() => setActive(e.conv.id)}
              />
            )}
          </For>
          <Show when={activeDms().length === 0}>
            <div class="mx-2 px-2 py-1 text-[11px] text-gray-400">
              没有 active DM · 去 #all 找人
            </div>
          </Show>
        </div>
        <div class="flex-1" />
      </aside>

      {/* Conversation pane */}
      <main class="flex-1 min-w-0 flex flex-col bg-white">
        <header class="px-5 h-12 shrink-0 border-b border-gray-200 flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-[15px] font-medium text-gray-900">
                {conversation().kind === "channel" ? `#${conversation().name}` : `@${conversation().name}`}
              </span>
              <Show when={conversation().topic}>
                <span class="text-xs text-gray-500">— {conversation().topic}</span>
              </Show>
            </div>
            <Show when={conversation().members}>
              <button
                type="button"
                onClick={() => setMembersOpen(!membersOpen())}
                class="text-[11px] text-gray-500 hover:text-gray-700 mt-0.5 flex items-center gap-1"
                title="点击展开成员列表 · 可搜索 · 点名字开 DM"
              >
                <span>{conversation().members!.length} members</span>
                <span class="text-gray-400">{membersOpen() ? "▴" : "▾"}</span>
              </button>
            </Show>
          </div>
          <div class="flex items-center gap-2 text-xs text-gray-500">
            <button class="px-2 py-1 rounded hover:bg-gray-100 hover:text-gray-900 flex items-center gap-1">
              <Icon name="brain" />
              <span>summarize</span>
            </button>
            <button class="px-2 py-1 rounded hover:bg-gray-100 hover:text-gray-900 flex items-center gap-1">
              <Icon name="fork" />
              <span>spawn loop</span>
            </button>
          </div>
        </header>

        <Show when={membersOpen() && conversation().members}>
          <div class="shrink-0 border-b border-gray-200 bg-gray-50/30 px-5 py-3">
            <div class="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={memberFilter()}
                onInput={(e) => setMemberFilter(e.currentTarget.value)}
                placeholder={`搜索 ${conversation().members!.length} 个成员…`}
                class="flex-1 px-2 py-1 text-[12px] rounded border border-gray-200 bg-white outline-none focus:border-gray-400"
              />
              <span class="text-[11px] text-gray-500">{filteredMembers().length} match</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <For each={filteredMembers()}>
                {(name) => {
                  const kind = memberKind(name)
                  const isMe = name === "simpx"
                  return (
                    <button
                      type="button"
                      disabled={isMe}
                      onClick={() => {
                        setActive(memberDmId(name))
                        setMembersOpen(false)
                        setMemberFilter("")
                      }}
                      class={
                        isMe
                          ? "px-2 py-1 rounded text-[12px] flex items-center gap-1.5 bg-gray-100 text-gray-500 cursor-default"
                          : "px-2 py-1 rounded text-[12px] flex items-center gap-1.5 bg-white border border-gray-200 hover:border-gray-400 hover:bg-gray-50 text-gray-900"
                      }
                      title={isMe ? "(you)" : `DM ${name}`}
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      <span>{name}</span>
                      <Show when={isMe}>
                        <span class="text-[10px] text-gray-400">you</span>
                      </Show>
                      <Show when={kind === "agent"}>
                        <span class="text-[10px] text-gray-400">🤖</span>
                      </Show>
                    </button>
                  )
                }}
              </For>
              <Show when={filteredMembers().length === 0}>
                <span class="text-[12px] text-gray-500">no match</span>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={referencedBy().length > 0}>
          <div class="shrink-0 border-b border-gray-200 bg-gray-50/40">
            <button
              type="button"
              onClick={() => setRefExpanded(!refExpanded())}
              class="w-full px-5 py-1.5 flex items-center gap-2 text-[12px] text-gray-600 hover:bg-gray-100/60"
            >
              <span>📤</span>
              <span>
                <b class="text-gray-900">{referencedBy().length} loops</b> 把这条 chat 作为 context
              </span>
              <span class="text-gray-400">{refExpanded() ? "▴" : "▾"}</span>
            </button>
            <Show when={refExpanded()}>
              <ul class="px-5 pb-2 flex flex-col gap-0.5">
                <For each={referencedBy()}>
                  {(loop) => {
                    const mount = loop.context.chats?.find((c) => c.id === active())
                    return (
                      <li>
                        <button
                          type="button"
                          onClick={() => navigate(`/loop/${loop.id}`)}
                          class="w-full text-left px-2 py-1 rounded hover:bg-white flex items-center gap-2 text-[12px]"
                        >
                          <span class="text-gray-400">⑂</span>
                          <span class="text-gray-900">{loop.name}</span>
                          <Show when={loop.rfd}>
                            <span class="text-amber-600 text-[10px]">RFD</span>
                          </Show>
                          <span class="text-gray-500">·</span>
                          <span class="text-gray-500">{loop.driver}</span>
                          <span class="text-gray-500">·</span>
                          <span class="text-gray-500">{loop.lastActivityAgo}</span>
                          <Show when={mount}>
                            <span class="ml-auto text-gray-400 font-mono text-[11px]">
                              up to msg #{mount!.upTo}
                            </span>
                          </Show>
                        </button>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </Show>
          </div>
        </Show>

        <div class="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-3">
          <For each={conversation().messages}>{(m) => <MessageRow message={m} />}</For>
          <Show when={conversation().messages.length === 0}>
            <div class="text-[13px] text-gray-500">No messages yet · say hi</div>
          </Show>
        </div>

        <div class="px-5 pb-4 pt-2 shrink-0">
          <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 flex items-center gap-2">
            <Icon name="prompt" class="text-gray-500" />
            <input
              type="text"
              class="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-500"
              placeholder={`Message ${
                conversation().kind === "channel" ? "#" + conversation().name : "@" + conversation().name
              }…`}
            />
            <span class="text-[11px] text-gray-500">/ commands · @ mentions</span>
            <button class="px-3 py-1 rounded bg-gray-200 text-gray-900 text-xs hover:bg-gray-300">send</button>
          </div>
        </div>
      </main>
    </div>
  )
}

function DmRow(props: { entry: DmEntry; active: boolean; onClick: () => void }) {
  const e = props.entry
  const statusDot = () => {
    if (e.kind !== "agent") return "bg-emerald-500"
    if (e.status === "running") return "bg-emerald-500"
    if (e.status === "error") return "bg-red-500"
    return "bg-gray-300"
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={
        props.active
          ? "mx-2 px-2 py-1 rounded text-[13px] flex items-center gap-2 bg-gray-100 text-gray-900"
          : "mx-2 px-2 py-1 rounded text-[13px] flex items-center gap-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      }
      title={e.kind === "agent" ? "agent · 配置在 Context tab" : "human"}
    >
      <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot()}`} />
      <span class="truncate flex-1 text-left">{e.conv.name}</span>
      <Show when={e.kind === "agent"}>
        <span class="text-[10px] text-gray-400 shrink-0" title="agent">🤖</span>
      </Show>
      <Show when={e.conv.unread}>
        <span class="text-[11px] px-1.5 rounded-full bg-gray-200 text-gray-700">{e.conv.unread}</span>
      </Show>
    </button>
  )
}

function ConversationRow(props: { conv: Conversation; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={
        props.active
          ? "mx-2 px-2 py-1 rounded text-[13px] flex items-center justify-between bg-gray-100 text-gray-900"
          : "mx-2 px-2 py-1 rounded text-[13px] flex items-center justify-between text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      }
    >
      <span class="flex items-center gap-2 min-w-0">
        <span class="text-gray-400">{props.conv.kind === "channel" ? "#" : "@"}</span>
        <span class="truncate">{props.conv.name}</span>
      </span>
      <Show when={props.conv.unread}>
        <span class="text-[11px] px-1.5 rounded-full bg-gray-200">{props.conv.unread}</span>
      </Show>
    </button>
  )
}

function MessageRow(props: { message: Message }) {
  const m = props.message
  return (
    <div class="flex gap-3">
      <div
        class={
          m.isAi
            ? "w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-medium bg-gray-100 text-gray-900 ring-1 ring-gray-200"
            : "w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-medium bg-gray-200 text-gray-900"
        }
        title={m.author}
      >
        {m.isAi ? "🤖" : m.author.slice(0, 1).toUpperCase()}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-medium text-gray-900">{m.author}</span>
          <Show when={m.isAi}>
            <span class="text-[10px] px-1 rounded bg-gray-100 text-gray-500">AI</span>
          </Show>
          <Show when={m.isMe}>
            <span class="text-[10px] text-gray-500">you</span>
          </Show>
          <span class="text-[11px] text-gray-500">{m.time}</span>
        </div>
        <div class="text-[13px] text-gray-900 whitespace-pre-wrap leading-relaxed">{m.text}</div>
      </div>
    </div>
  )
}
