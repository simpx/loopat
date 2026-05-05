/**
 * Chat tab — Slack-like channel/DM rail + conversation pane.
 * Ported from opencode prototype loop-tab-chat.tsx.
 */
import { createSignal, For, Show } from "solid-js"
import { Icon } from "../components/icon"

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
    id: "general",
    kind: "channel",
    name: "general",
    topic: "team-wide updates · workspace announcements",
    members: ["simpx", "阿尔萨斯", "泰兰德", "无厚", "coo-bot"],
    messages: [
      { id: "m1", author: "coo-bot", isAi: true, text: "📋 周一站会 reminder · 9:30 · #standup", time: "9:00" },
      { id: "m2", author: "无厚", text: "今天我先离开会议室，需要看一下 RDMA trace", time: "9:15" },
    ],
  },
  {
    id: "gateway-launch",
    kind: "channel",
    name: "gateway-launch",
    unread: 4,
    active: true,
    topic: "gateway 上线 · llama-3 a100 · pd 适配",
    members: ["simpx", "阿尔萨斯", "泰兰德", "coo-bot"],
    messages: [
      { id: "k1", author: "阿尔萨斯", text: "早 ✋ trace 已上传 S3", time: "08:42" },
      { id: "k2", author: "simpx", isMe: true, text: "@coo-bot 看下 trace.log，重点找 mr_register 那段", time: "08:45" },
      {
        id: "k3",
        author: "coo-bot",
        isAi: true,
        text:
          "已分析 trace.log（120k 行）。发现 mr_register 平均耗时 110s，主因是 cuda alignment 跟 RDMA page size 不匹配。\n\n详细分析已写入 [knowledge/rdma-mr-register.md](#)。",
        time: "08:46",
      },
      { id: "k4", author: "泰兰德", text: "我也看到了，跟我之前怀疑的对得上。今天能改吗？", time: "08:50" },
      { id: "k5", author: "simpx", isMe: true, text: "可以，我开个 loop 推这件事", time: "08:51" },
      {
        id: "k6",
        author: "coo-bot",
        isAi: true,
        text: "✓ 已创建 loop `gateway-rdma-fix` · driver: simpx · 关联 todo #1a",
        time: "08:51",
      },
    ],
  },
  {
    id: "1001-design",
    kind: "channel",
    name: "1001-design",
    topic: "1001 系统设计讨论",
    members: ["simpx", "coo-bot"],
    messages: [
      { id: "d1", author: "simpx", isMe: true, text: "今天把 4 tab 原型搭出来了", time: "16:20" },
      { id: "d2", author: "coo-bot", isAi: true, text: "👀 在 prototype tab 里看到了。Doc / Todo / Chat 都是 mock，你想先实现哪个？", time: "16:21" },
    ],
  },
  {
    id: "turbo-quant",
    kind: "channel",
    name: "turbo-quant",
    topic: "turbo quant 推进",
    members: ["simpx", "泰兰德", "如霖", "coo-bot"],
    messages: [{ id: "t1", author: "如霖", text: "明天可以一起过一下", time: "12:00" }],
  },
]

const DMS: Conversation[] = [
  {
    id: "dm-coo",
    kind: "dm",
    name: "coo-bot",
    messages: [
      { id: "c1", author: "simpx", isMe: true, text: "/summarize 今天 #gateway-launch 的进展", time: "16:30" },
      {
        id: "c2",
        author: "coo-bot",
        isAi: true,
        text:
          "**今天 #gateway-launch 摘要**\n\n- 阿尔萨斯 上传 RDMA trace\n- 我分析出 mr_register 耗时根因（cuda alignment ↔ RDMA page size）\n- simpx 开 loop `gateway-rdma-fix` 推进修复\n- 关联 todo #1a，driver simpx\n\n要发到 #general 吗？",
        time: "16:30",
      },
    ],
  },
  { id: "dm-zongyan", kind: "dm", name: "阿尔萨斯", unread: 1, messages: [{ id: "z1", author: "阿尔萨斯", text: "晚上要不要试一下 develop 那个版本？", time: "17:02" }] },
  { id: "dm-minmin", kind: "dm", name: "泰兰德", messages: [] },
]

export function ChatPage() {
  const [active, setActive] = createSignal<ChannelId>("gateway-launch")
  const conversation = () => [...CHANNELS, ...DMS].find((c) => c.id === active()) ?? CHANNELS[0]

  return (
    <div class="flex h-full w-full">
      {/* Channels rail */}
      <aside class="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-10 flex items-center justify-between border-b border-gray-200">
          <span class="text-xs text-gray-500">workspace</span>
          <span class="text-[13px] font-medium text-gray-900">loopey</span>
        </div>
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
        <div class="px-3 mt-3 mb-1 text-xs text-gray-500 flex items-center justify-between">
          <span>Direct messages</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <For each={DMS}>
            {(c) => <ConversationRow conv={c} active={active() === c.id} onClick={() => setActive(c.id)} />}
          </For>
        </div>
        <div class="flex-1" />
        <div class="px-3 h-10 border-t border-gray-200 flex items-center text-xs text-gray-500 gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-500" />
          <span>connected · ergo</span>
        </div>
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
              <div class="text-[11px] text-gray-500 mt-0.5">
                {conversation().members!.length} members · {conversation().members!.join(", ")}
              </div>
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
