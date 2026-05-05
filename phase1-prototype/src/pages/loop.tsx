/**
 * Loop tab — chat-first layout with optional right panel.
 *
 * Shows what makes this loop unique: driver, workdir, context (knowledge
 * scope + mounted repos). Drops the old "idea-only" badge in favor of
 * context chips that explain the loop's scope.
 *
 * Driver state model:
 *   - active + driver = ME      → can release (RFD)
 *   - active + driver = other   → just shows their name
 *   - rfd                       → anyone (incl. self) can claim drive
 *   - fork is always available, regardless of state
 *
 * Right panel (toggleable, 50/50 split when open):
 *   files / editor (CodeMirror) / terminal
 */
import { createSignal, createEffect, For, Show } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { Icon } from "../components/icon"
import { Markdown } from "../components/markdown"
import { CodeEditor } from "../components/code-editor"
import {
  ME,
  loops,
  forkLoop,
  releaseRfd,
  claimDrive,
  previewSlug,
  setNewLoopDialogOpen,
  setLoopPersonal,
  mountRevisions,
  syncMount,
  chats,
  type CreateLoopOpts,
} from "../state"
import { REPOS, VAULT_DOCS, flattenVaultFiles, type DocNode } from "./context"
import type { ChatItem, Loop, TimelineEvent } from "../state"
import { getWorkspace } from "../mock/files"
import type { FileNode } from "../mock/files"

type RightMode = "workdir" | "editor" | "terminal" | "info"

const TERMINAL_LINES = [
  "$ pytest tests/test_gateway.py::test_rdma_register -xvs",
  "================================ test session starts ================================",
  "platform linux -- Python 3.10.13, pytest-8.0.1",
  "rootdir: /home/simpx/workspace/loopey-runtime",
  "collected 1 item",
  "",
  "tests/test_gateway.py::test_rdma_register PASSED                                  [100%]",
  "",
  "================================= 1 passed in 4.82s =================================",
  "$ ▍",
]

export function LoopPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [scope, setScope] = createSignal<"mine" | "all">("mine")
  const [rightOpen, setRightOpen] = createSignal(false)
  const [rightMode, setRightMode] = createSignal<RightMode>("workdir")
  const [editingPath, setEditingPath] = createSignal<string>("")
  const [fileEdits, setFileEdits] = createSignal<Record<string, Record<string, string>>>({})
  const [openFolders, setOpenFolders] = createSignal(new Set<string>(["context", "main"]))
  const [addContextOpen, setAddContextOpen] = createSignal(false)

  const toggleFolder = (name: string) => {
    const next = new Set(openFolders())
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpenFolders(next)
  }

  const sortKey = (l: Loop) => {
    if (l.inFocus?.includes("pinned")) return 0
    if (l.rfd) return 2
    return 1
  }
  const filtered = () =>
    loops()
      .filter((l) => (scope() === "mine" ? l.driver === ME : l.status !== "archived"))
      .slice()
      .sort((a, b) => sortKey(a) - sortKey(b))

  const current = () => loops().find((l) => l.id === params.id) ?? loops()[0]
  const workspace = () => getWorkspace(current().id)

  const toggleMode = (m: RightMode) => {
    if (rightOpen() && rightMode() === m) setRightOpen(false)
    else {
      setRightOpen(true)
      setRightMode(m)
    }
  }

  const openFile = (path: string) => {
    setEditingPath(path)
    setRightMode("editor")
    setRightOpen(true)
  }

  const fileText = (path: string) => {
    const lid = current().id
    return (
      fileEdits()[lid]?.[path] ??
      workspace().fileContents[path] ??
      `// ${path}\n(no content)`
    )
  }
  const setFileText = (path: string, value: string) => {
    const lid = current().id
    const next = { ...fileEdits() }
    next[lid] = { ...(next[lid] ?? {}), [path]: value }
    setFileEdits(next)
  }
  const isEdited = (path: string) => {
    const lid = current().id
    const edited = fileEdits()[lid]?.[path]
    if (edited === undefined) return false
    return edited !== (workspace().fileContents[path] ?? "")
  }

  const currentChat = (): ChatItem[] => chats[current().id] ?? []

  return (
    <div class="flex h-full w-full">
      <LoopsList
        scope={scope}
        setScope={setScope}
        filtered={filtered}
        currentId={() => params.id}
        onSelect={(id) => navigate(`/loop/${id}`)}
        onNewClick={() => setNewLoopDialogOpen(true)}
      />

      <div class="flex-1 min-w-0 min-h-0 flex">
        <main class="flex-1 min-w-0 flex flex-col bg-white min-h-0">
          <LoopHeader
            loop={current()}
            rightOpen={rightOpen}
            rightMode={rightMode}
            toggleMode={toggleMode}
            onAddContext={() => setAddContextOpen(true)}
          />

          <Show when={addContextOpen()}>
            <AddContextDialog
              loop={current()}
              onClose={() => setAddContextOpen(false)}
              onSave={(paths) => {
                setLoopPersonal(current().id, paths)
                setAddContextOpen(false)
              }}
            />
          </Show>

          <div class="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-3">
            <Show
              when={currentChat().length > 0}
              fallback={
                <div class="text-[13px] text-gray-500 italic mt-4">
                  No conversation yet — say something to start the loop.
                </div>
              }
            >
              <For each={currentChat()}>{(item) => <ChatRow item={item} onOpenFile={openFile} />}</For>
            </Show>
          </div>

          <ChatInput />
        </main>

        <Show when={rightOpen()}>
          <RightPanel
            current={current}
            rightMode={rightMode}
            setRightOpen={setRightOpen}
            editingPath={editingPath}
            fileText={fileText}
            setFileText={setFileText}
            isEdited={isEdited}
            openFolders={openFolders}
            toggleFolder={toggleFolder}
            openFile={openFile}
          />
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Loops list (col 1)
// ============================================================================

function LoopsList(props: {
  scope: () => "mine" | "all"
  setScope: (v: "mine" | "all") => void
  filtered: () => Loop[]
  currentId: () => string
  onSelect: (id: string) => void
  onNewClick: () => void
}) {
  return (
    <aside class="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
      <div class="px-3 h-10 flex items-center justify-between border-b border-gray-200">
        <span class="text-xs text-gray-500">Loops</span>
        <button
          type="button"
          class="text-gray-500 hover:text-gray-900 px-1.5 rounded hover:bg-gray-100 text-sm leading-none"
          title="new loop"
          onClick={() => props.onNewClick()}
        >
          +
        </button>
      </div>
      <div class="px-2 pt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => props.setScope("mine")}
          class={
            props.scope() === "mine"
              ? "px-2 h-6 rounded text-[11px] bg-gray-900 text-white"
              : "px-2 h-6 rounded text-[11px] text-gray-500 hover:bg-gray-100"
          }
        >
          我的
        </button>
        <button
          type="button"
          onClick={() => props.setScope("all")}
          class={
            props.scope() === "all"
              ? "px-2 h-6 rounded text-[11px] bg-gray-900 text-white"
              : "px-2 h-6 rounded text-[11px] text-gray-500 hover:bg-gray-100"
          }
        >
          全部
        </button>
        <span class="text-[11px] text-gray-400 ml-auto pr-1">{props.filtered().length}</span>
      </div>
      <div class="flex-1 min-h-0 overflow-auto py-2">
        <For each={props.filtered()}>
          {(loop) => {
            const sel = () => props.currentId() === loop.id
            return (
              <button
                type="button"
                onClick={() => props.onSelect(loop.id)}
                class={
                  sel()
                    ? "w-full px-3 py-2 flex items-center gap-2 text-left bg-gray-100"
                    : "w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                }
              >
                <span
                  class={
                    loop.status === "active"
                      ? "w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500"
                      : "w-1.5 h-1.5 rounded-full shrink-0 bg-gray-300"
                  }
                />
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] text-gray-900 truncate">{loop.name}</div>
                  <div class="text-[11px] text-gray-500 truncate flex items-center gap-1">
                    <ArchetypeIcon a={loop.archetype} />
                    <span>{loop.driver}</span>
                    <span>·</span>
                    <span>{loop.lastActivityAgo}</span>
                  </div>
                </div>
                <Show when={loop.rfd}>
                  <span title="RFD" class="text-amber-600 text-[11px]">RFD</span>
                </Show>
                <Show when={loop.inFocus?.includes("pinned")}>
                  <span title="pinned in focus" class="text-gray-500">📌</span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </aside>
  )
}

function ArchetypeIcon(props: { a: Loop["archetype"] }) {
  const ch =
    props.a === "code"
      ? "‹›"
      : props.a === "research"
        ? "⌕"
        : props.a === "online"
          ? "⚡"
          : props.a === "context-refine"
            ? "≡"
            : "✦"
  return <span class="text-gray-400 font-mono text-[10px]">{ch}</span>
}

// ============================================================================
// Loop header (driver state + context chips)
// ============================================================================

function LoopHeader(props: {
  loop: Loop
  rightOpen: () => boolean
  rightMode: () => RightMode
  toggleMode: (m: RightMode) => void
  onAddContext: () => void
}) {
  const navigate = useNavigate()
  const loop = () => props.loop
  const isMine = () => loop().driver === ME
  const modeBtn = (label: string, m: RightMode) => (
    <button
      class={
        props.rightOpen() && props.rightMode() === m
          ? "px-2 py-0.5 rounded bg-gray-100 text-gray-900"
          : "px-2 py-0.5 rounded hover:text-gray-900"
      }
      onClick={() => props.toggleMode(m)}
    >
      {label}
    </button>
  )
  return (
    <header class="px-5 pt-3 pb-2 shrink-0 border-b border-gray-200">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[15px] font-medium text-gray-900">{loop().name}</span>
        <span
          class={
            loop().status === "active"
              ? "w-1.5 h-1.5 rounded-full bg-emerald-500"
              : "w-1.5 h-1.5 rounded-full bg-gray-300"
          }
        />
        <Show when={loop().rfd}>
          <span class="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
            RFD
          </span>
        </Show>
        <Show when={loop().status === "idle" && !loop().rfd}>
          <span class="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">idle</span>
        </Show>
        <span class="text-xs text-gray-500">
          driver: <span class={isMine() ? "text-gray-900" : ""}>{loop().driver}</span>
        </span>

        <div class="flex-1" />

        {/* Always visible */}
        <button
          type="button"
          onClick={() => navigate(`/loop/${forkLoop(loop().id)}`)}
          class="px-3 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700"
        >
          fork
        </button>

        {/* Driver-state-aware action */}
        <Show when={isMine() && !loop().rfd}>
          <button
            type="button"
            onClick={() => releaseRfd(loop().id)}
            class="px-3 h-7 rounded text-xs bg-amber-100 text-amber-900 hover:bg-amber-200"
            title="release this loop — anyone can claim drive"
          >
            RFD
          </button>
        </Show>
        <Show when={loop().rfd}>
          <button
            type="button"
            onClick={() => claimDrive(loop().id)}
            class="px-3 h-7 rounded text-xs bg-emerald-100 text-emerald-900 hover:bg-emerald-200"
            title={isMine() ? "re-drive this loop" : "take over driving this loop"}
          >
            drive
          </button>
        </Show>
      </div>

      {/* workdir + branch + mode toggles */}
      <div class="text-xs text-gray-500 mt-1.5 flex items-center gap-2 flex-wrap">
        <span>{loop().workdir}</span>
        <Show when={loop().branch}>
          <span>·</span>
          <span class="flex items-center gap-1">
            <Icon name="fork" />
            {loop().branch}
          </span>
        </Show>
        <span>·</span>
        <span>{loop().participants} viewing</span>
        <div class="flex-1" />
        <div class="flex items-center gap-1 text-[11px]">
          {modeBtn("ℹ info", "info")}
          {modeBtn("▤ workdir", "workdir")}
          {modeBtn("✎ editor", "editor")}
          {modeBtn("▷ terminal", "terminal")}
        </div>
      </div>

      {/* context chips */}
      <div class="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span class="text-gray-400">context:</span>
        <ContextChip
          label="knowledge"
          value={loop().context.knowledge === "all" ? "all" : `${loop().context.knowledge.length}`}
        />
        <ContextChip
          label="notes"
          value={loop().context.notes === "all" ? "all" : `${loop().context.notes.length}`}
        />
        <ContextChip
          label="personal"
          value={
            loop().context.personal && loop().context.personal!.length > 0
              ? `${loop().context.personal!.length}`
              : "—"
          }
        />
        <button
          type="button"
          onClick={() => props.onAddContext()}
          class="text-gray-500 hover:text-gray-900 px-1.5 py-0.5 rounded hover:bg-gray-100"
          title="add context"
        >
          +
        </button>
      </div>

      {/* focus chips */}
      <Show when={loop().focuses && loop().focuses!.length > 0}>
        <div class="mt-1 flex items-center gap-1.5 flex-wrap text-[11px]">
          <span class="text-gray-400">focus:</span>
          <For each={loop().focuses}>
            {(name) => (
              <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-[11px] font-medium text-gray-900">
                {name}
              </span>
            )}
          </For>
        </div>
      </Show>
    </header>
  )
}

function ContextChip(props: { label: string; value: string }) {
  return (
    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-[11px]">
      <span class="text-gray-500">{props.label}:</span>
      <span class="text-gray-900 font-medium">{props.value}</span>
    </span>
  )
}

// ============================================================================
// Chat input + bottom toolbar
// ============================================================================

type PastedImage = { url: string; name: string }

function ChatInput() {
  const [pasted, setPasted] = createSignal<PastedImage[]>([])

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind !== "file" || !it.type.startsWith("image/")) continue
      const blob = it.getAsFile()
      if (!blob) continue
      e.preventDefault()
      const reader = new FileReader()
      reader.onload = () => {
        setPasted([
          ...pasted(),
          { url: reader.result as string, name: blob.name || `pasted-${Date.now()}.png` },
        ])
      }
      reader.readAsDataURL(blob)
    }
  }

  const removePasted = (idx: number) => setPasted(pasted().filter((_, i) => i !== idx))

  return (
    <div class="px-5 pb-3 pt-2 shrink-0 border-t border-gray-200">
      <Show when={pasted().length > 0}>
        <div class="flex flex-wrap gap-2 mb-2">
          <For each={pasted()}>
            {(p, i) => (
              <div class="relative group">
                <img
                  src={p.url}
                  alt={p.name}
                  class="w-16 h-16 object-cover rounded border border-gray-200"
                />
                <button
                  type="button"
                  onClick={() => removePasted(i())}
                  class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-900 text-white text-[11px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="remove"
                >
                  ×
                </button>
                <div class="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] truncate px-1 rounded-b">
                  {p.name}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 flex items-center gap-2">
        <Icon name="prompt" class="text-gray-500" />
        <input
          type="text"
          class="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-500"
          placeholder="type message · ⌘V to paste image"
          onPaste={handlePaste}
        />
        <button class="px-3 py-1 rounded bg-gray-200 text-gray-900 text-xs hover:bg-gray-300">
          send
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Right panel (files / editor / terminal)
// ============================================================================

function RightPanel(props: {
  current: () => Loop
  rightMode: () => RightMode
  setRightOpen: (v: boolean) => void
  editingPath: () => string
  fileText: (p: string) => string
  setFileText: (p: string, v: string) => void
  isEdited: (p: string) => boolean
  openFolders: () => Set<string>
  toggleFolder: (n: string) => void
  openFile: (p: string) => void
}) {
  return (
    <aside class="flex-1 min-w-0 border-l border-gray-200 bg-white flex flex-col">
      <header class="px-3 h-8 shrink-0 border-b border-gray-200 flex items-center gap-1 text-[11px] text-gray-500">
        <span class="capitalize">{props.rightMode()}</span>
        <Show when={props.rightMode() === "editor"}>
          <span class="ml-2 truncate">
            {props.editingPath() || "(no file)"}
            <Show when={props.editingPath() && props.isEdited(props.editingPath())}>
              <span class="text-orange-600"> ●</span>
            </Show>
          </span>
        </Show>
        <div class="flex-1" />
        <button
          class="text-gray-500 hover:text-gray-900 p-1 rounded hover:bg-gray-100"
          onClick={() => props.setRightOpen(false)}
          title="close panel"
        >
          <Icon name="close-small" />
        </button>
      </header>

      <Show when={props.rightMode() === "info"}>
        <InfoPanel loop={props.current()} />
      </Show>

      <Show when={props.rightMode() === "workdir"}>
        <div class="flex-1 min-h-0 overflow-auto py-2">
          <For each={buildLoopWorkdir(props.current())}>
            {(node) => (
              <FileTreeNode
                node={node}
                depth={0}
                openFolders={props.openFolders}
                toggleFolder={props.toggleFolder}
                onOpen={props.openFile}
                currentPath={props.editingPath}
              />
            )}
          </For>
        </div>
        <div class="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500">
          ⑂ <span class="text-gray-900">{props.current().branch ?? "main"}</span>
        </div>
      </Show>

      <Show when={props.rightMode() === "editor"}>
        <Show
          when={props.editingPath()}
          fallback={
            <div class="flex-1 min-h-0 flex items-center justify-center text-[13px] text-gray-500 px-8 text-center">
              没打开文件 · 在 ▤ workdir 里点一个，或在 chat 里点 artifact card
            </div>
          }
        >
          <div class="flex-1 min-h-0">
            <CodeEditor
              path={props.editingPath()}
              value={props.fileText(props.editingPath())}
              onChange={(v) => props.setFileText(props.editingPath(), v)}
            />
          </div>
          <div class="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 flex items-center gap-3">
            <span>{props.editingPath()}</span>
            <Show when={props.isEdited(props.editingPath())}>
              <span class="text-orange-600">unsaved (mock)</span>
            </Show>
            <span class="ml-auto">utf-8 · LF</span>
          </div>
        </Show>
      </Show>

      <Show when={props.rightMode() === "terminal"}>
        <div class="flex-1 min-h-0 overflow-auto px-3 py-2 font-mono text-xs leading-snug bg-gray-50">
          <For each={TERMINAL_LINES}>
            {(line) => (
              <div
                class={
                  line.includes("PASSED") || line.startsWith("$")
                    ? "text-emerald-600"
                    : line.startsWith("=")
                      ? "text-gray-500"
                      : "text-gray-900"
                }
              >
                {line}
              </div>
            )}
          </For>
        </div>
      </Show>
    </aside>
  )
}

// ============================================================================
// Info panel — loop metadata + timeline
// ============================================================================

function InfoPanel(props: { loop: Loop }) {
  const ws = () => getWorkspace(props.loop.id)
  const fileCount = () => countFiles(ws().fileTree)
  return (
    <div class="flex-1 min-h-0 overflow-auto px-5 py-4 text-[13px] text-gray-900">
      <Section label="basics">
        <Row label="created" value={`${props.loop.createdAt} · by ${props.loop.createdBy}`} />
        <Row label="archetype" value={props.loop.archetype} />
        <Row label="status" value={statusLabel(props.loop)} />
        <Row label="driver" value={props.loop.driver + (props.loop.driver === ME ? " (you)" : "")} />
        <Row label="participants" value={`${props.loop.participants}`} />
        <Row label="last activity" value={props.loop.lastActivityAgo} />
      </Section>

      <Section label="workdir">
        <Row label="path" value={props.loop.workdir} mono />
        <Show when={props.loop.branch}>
          <Row label="branch" value={props.loop.branch!} mono />
        </Show>
        <Row label="files" value={`${fileCount()} tracked`} />
      </Section>

      <Section label="context">
        <Row
          label="knowledge"
          value={
            props.loop.context.knowledge === "all"
              ? "all (public)"
              : `scoped to ${props.loop.context.knowledge.length} dirs`
          }
        />
      </Section>

      <Show when={props.loop.inFocus && props.loop.inFocus.length > 0}>
        <Section label="focus">
          <Row label="state" value={props.loop.inFocus!.includes("pinned") ? "📌 pinned" : "listed"} />
        </Section>
      </Show>

      <Section label="timeline">
        <ol class="flex flex-col gap-2 mt-1">
          <For each={[...props.loop.timeline].reverse()}>
            {(ev) => <TimelineRow ev={ev} />}
          </For>
        </ol>
      </Section>
    </div>
  )
}

function Section(props: { label: string; children: any }) {
  return (
    <section class="mb-5">
      <h3 class="text-[11px] uppercase tracking-wide text-gray-400 mb-2">{props.label}</h3>
      <div class="flex flex-col gap-1.5">{props.children}</div>
    </section>
  )
}

function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div class="flex items-baseline gap-3">
      <span class="text-[12px] text-gray-500 w-20 shrink-0">{props.label}</span>
      <span class={props.mono ? "font-mono text-[12px]" : "text-[13px]"}>{props.value}</span>
    </div>
  )
}

function TimelineRow(props: { ev: TimelineEvent }) {
  const ev = props.ev
  const summary = (() => {
    switch (ev.kind) {
      case "create":
        return `created by ${ev.by}`
      case "fork":
        return `forked by ${ev.by}${ev.note ? ` · ${ev.note}` : ""}`
      case "driver-change":
        return `driver: ${ev.from} → ${ev.to}`
      case "rfd":
        return `${ev.by} released (RFD)${ev.note ? ` · ${ev.note}` : ""}`
      case "claim":
        return `${ev.by} claimed${ev.from ? ` from ${ev.from}` : ""}${ev.note ? ` · ${ev.note}` : ""}`
      case "focus-pin":
        return `pinned to focus${ev.note ? ` · ${ev.note}` : ""}`
    }
  })()
  const dot =
    ev.kind === "create"
      ? "bg-emerald-500"
      : ev.kind === "rfd"
        ? "bg-amber-500"
        : ev.kind === "claim"
          ? "bg-emerald-500"
          : ev.kind === "fork"
            ? "bg-purple-500"
            : "bg-gray-400"
  return (
    <li class="flex items-baseline gap-2.5">
      <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${dot} translate-y-[3px]`} />
      <span class="font-mono text-[11px] text-gray-500 shrink-0 w-32">{ev.time}</span>
      <span class="text-[12px] text-gray-900">{summary}</span>
    </li>
  )
}

function statusLabel(l: Loop): string {
  if (l.rfd) return "active · RFD"
  return l.status
}

function countFiles(nodes: FileNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === "file") n++
    else n += countFiles(node.children)
  }
  return n
}

function FileTreeNode(props: {
  node: FileNode
  depth: number
  pathKey?: string
  openFolders: () => Set<string>
  toggleFolder: (name: string) => void
  onOpen: (path: string) => void
  currentPath: () => string
}) {
  if (props.node.kind === "folder") {
    const folder = props.node
    const key = () => props.pathKey ?? folder.name
    const opened = () => props.openFolders().has(key())
    const isSection = folder.display === "section"
    return (
      <>
        <button
          type="button"
          class={
            isSection
              ? folder.name === "context"
                ? "w-full py-1.5 flex items-center gap-1.5 bg-cyan-50/50 hover:bg-cyan-50 text-left border-y border-cyan-100/70"
                : "w-full py-1.5 flex items-center gap-1.5 bg-emerald-50/40 hover:bg-emerald-50 text-left border-y border-emerald-100/70"
              : "w-full py-1 flex items-center gap-1.5 hover:bg-gray-50 text-left"
          }
          style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
          onClick={() => props.toggleFolder(key())}
        >
          <Icon name={opened() ? "chevron-down" : "chevron-right"} class="text-gray-500" />
          <Show
            when={folder.secret}
            fallback={
              <Show
                when={isSection}
                fallback={<Icon name="folder" class="text-gray-500" />}
              >
                <span class="text-[12px]">
                  {folder.name === "context" ? "🧷" : "▣"}
                </span>
              </Show>
            }
          >
            <span class="text-[12px]">🔐</span>
          </Show>
          <span
            class={
              isSection
                ? "text-[11px] uppercase tracking-wider font-semibold text-gray-700"
                : "text-[13px] text-gray-900 truncate"
            }
          >
            {folder.name}
          </span>
          <Show when={folder.hint}>
            <span class="text-[10px] text-gray-500 italic">{folder.hint}</span>
          </Show>
          <Show when={folder.mount}>
            <MountBadge mount={folder.mount!} />
          </Show>
          <Show when={folder.revision}>
            <span
              class={
                folder.onSync
                  ? "text-[10px] text-gray-400 font-mono ml-auto"
                  : "text-[10px] text-gray-400 font-mono ml-auto pr-1"
              }
            >
              {folder.revision}
            </span>
          </Show>
          <Show when={folder.onSync}>
            <span
              role="button"
              tabIndex={0}
              class="text-[11px] text-gray-400 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
              title="sync (git pull --rebase)"
              onClick={(e) => {
                e.stopPropagation()
                folder.onSync?.()
              }}
            >
              ↻
            </span>
          </Show>
        </button>
        <Show when={opened()}>
          <For each={folder.children}>
            {(child) => (
              <FileTreeNode
                node={child}
                depth={props.depth + 1}
                pathKey={`${key()}/${child.kind === "folder" ? child.name : child.name}`}
                openFolders={props.openFolders}
                toggleFolder={props.toggleFolder}
                onOpen={props.onOpen}
                currentPath={props.currentPath}
              />
            )}
          </For>
        </Show>
      </>
    )
  }
  const file = props.node
  const sel = () => props.currentPath() === file.path
  const navigate = useNavigate()
  const handleClick = () => {
    if (file.linkTo) navigate(file.linkTo)
    else props.onOpen(file.path)
  }
  return (
    <button
      type="button"
      class={
        sel()
          ? "w-full py-1 flex items-center gap-2 text-left bg-gray-100"
          : file.linkTo
            ? "w-full py-1 flex items-center gap-2 text-left hover:bg-gray-50 italic text-gray-500"
            : "w-full py-1 flex items-center gap-2 text-left hover:bg-gray-50"
      }
      style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
      onClick={handleClick}
    >
      <span class="w-4" />
      <span class={file.linkTo ? "text-[12px] flex-1 min-w-0 truncate" : "text-[13px] text-gray-900 flex-1 min-w-0 truncate"}>
        {file.name}
      </span>
      <Show when={file.readonly && !file.linkTo}>
        <span class="text-[10px] text-gray-400" title="read-only">ro</span>
      </Show>
      <Show when={file.staged}>
        <span class="text-[11px] text-emerald-600" title="staged">A</span>
      </Show>
      <Show when={file.modified && !file.staged}>
        <span class="text-[11px] text-gray-500" title="modified">M</span>
      </Show>
    </button>
  )
}

function MountBadge(props: { mount: "ro" | "rw" | "selective" }) {
  const cls = () => {
    switch (props.mount) {
      case "ro":
        return "text-[10px] uppercase tracking-wide px-1 rounded bg-gray-100 text-gray-600"
      case "rw":
        return "text-[10px] uppercase tracking-wide px-1 rounded bg-cyan-100 text-cyan-800"
      case "selective":
        return "text-[10px] uppercase tracking-wide px-1 rounded bg-purple-100 text-purple-800"
    }
  }
  return <span class={cls()}>{props.mount}</span>
}

function buildLoopWorkdir(loop: Loop): FileNode[] {
  const main = getWorkspace(loop.id).fileTree
  const revs = mountRevisions()
  const ctx: FileNode[] = []
  ctx.push({
    kind: "folder",
    name: "knowledge",
    mount: "ro",
    revision: revs.knowledge,
    onSync: () => syncMount("knowledge"),
    children: [
      {
        kind: "file",
        name: "→ all team knowledge",
        path: "context/knowledge/__link__",
        linkTo: "/context/knowledge",
        readonly: true,
      },
    ],
  })
  ctx.push({
    kind: "folder",
    name: "notes",
    mount: "rw",
    revision: revs.notes,
    onSync: () => syncMount("notes"),
    children: [
      {
        kind: "file",
        name: "→ all team notes",
        path: "context/notes/__link__",
        linkTo: "/context/notes",
      },
    ],
  })
  if (loop.context.personal && loop.context.personal.length > 0) {
    ctx.push({
      kind: "folder",
      name: "personal",
      mount: "selective",
      revision: revs.personal,
      children: pathsToTreeFlat(loop.context.personal, "context/personal"),
    })
  }
  return [
    {
      kind: "folder",
      name: "context",
      display: "section",
      hint: "mounted from sources",
      children: ctx,
    },
    {
      kind: "folder",
      name: "main",
      display: "section",
      hint: "agent's cwd",
      children: main,
    },
  ]
}

function pathsToTreeFlat(paths: string[], prefix: string): FileNode[] {
  type T = { children: Record<string, T>; isFile?: boolean; full?: string }
  const root: T = { children: {} }
  for (const p of paths) {
    const parts = p.split("/")
    let cur = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        cur.children[part] = { children: {}, isFile: true, full: `${prefix}/${p}` }
      } else {
        if (!cur.children[part]) cur.children[part] = { children: {} }
        cur = cur.children[part]
      }
    }
  }
  const toNodes = (n: T): FileNode[] =>
    Object.entries(n.children).map(([name, child]): FileNode => {
      if (child.isFile) {
        return { kind: "file", name, path: child.full!, readonly: name.toUpperCase() === name && !name.includes(".") }
      }
      const isSecrets = name === "secrets"
      return {
        kind: "folder",
        name,
        children: toNodes(child),
        secret: isSecrets || undefined,
      }
    })
  return toNodes(root)
}

// ============================================================================
// Chat row — supports text / diff / todo / artifact / command / system markers.
//
// Visual rules (Claude-Code style):
//   - user text → gray bg block, no avatar/label
//   - ai   text → no bg, no avatar/label
//   - structured items (diff/todo/artifact/command) → bordered cards
//   - driver-change / rfd / claim → centered horizontal markers
// ============================================================================

function ChatRow(props: { item: ChatItem; onOpenFile: (path: string) => void }) {
  const item = props.item

  if (item.kind === "driver-change") {
    return <SystemMarker text={`${item.time}  driver: ${item.from} → ${item.to}`} />
  }
  if (item.kind === "rfd") {
    return <SystemMarker text={`${item.time}  ${item.by} 释放 driver · 进入 RFD`} accent="amber" />
  }
  if (item.kind === "claim") {
    return <SystemMarker text={`${item.time}  ${item.by} 认领了 driver`} accent="emerald" />
  }

  if (item.kind === "todo") return <TodoCard item={item} />
  if (item.kind === "artifact") return <ArtifactCard item={item} onOpen={() => props.onOpenFile(item.path)} />

  // Everything else (user / ai / diff / read / command) → markdown.
  // The Markdown component (marked + highlight.js) handles all the
  // layout: code fences, syntax-coloring, diff +/- backgrounds, lists.
  const md = toMarkdown(item)
  const isUser = item.kind === "user"
  return (
    <div class={isUser ? "rounded-md bg-gray-100 px-4 py-3" : "px-4 py-2"}>
      <Markdown text={md} class="prose-chat" />
      <div class="text-[11px] text-gray-500 mt-2">{item.time}</div>
    </div>
  )
}

const LANG_BY_EXT: Record<string, string> = {
  py: "python",
  go: "go",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  sh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  md: "markdown",
  toml: "",
}
const langFromPath = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return LANG_BY_EXT[ext] ?? ""
}

function toMarkdown(item: ChatItem): string {
  if (item.kind === "user" || item.kind === "ai") return item.text

  if (item.kind === "diff") {
    const body = item.lines
      .map((l) =>
        l.kind === "hunk"
          ? l.text
          : l.kind === "add"
            ? "+" + l.text.replace(/^[+-]?\t?/, "")
            : l.kind === "del"
              ? "-" + l.text.replace(/^[+-]?\t?/, "")
              : " " + l.text,
      )
      .join("\n")
    return `**Edit** \`${item.file}\`\n\n\`\`\`diff\n${body}\n\`\`\``
  }

  if (item.kind === "read") {
    const lang = langFromPath(item.path)
    const start = item.startLine ?? 1
    const end = start + item.lines.length - 1
    const range = item.startLine ? ` · L${start}-${end}` : ""
    const total = item.total ? ` of ${item.total}` : ""
    return `**Read** \`${item.path}\`${range}${total}\n\n\`\`\`${lang}\n${item.lines.join("\n")}\n\`\`\``
  }

  if (item.kind === "command") {
    const ok = item.ok === false ? " ✗" : item.ok === true ? " ✓" : ""
    return `**\`$ ${item.cmd}\`**${ok}\n\n\`\`\`\n${item.output.join("\n")}\n\`\`\``
  }

  return ""
}

function SystemMarker(props: { text: string; accent?: "amber" | "emerald" }) {
  const color =
    props.accent === "amber"
      ? "text-amber-700"
      : props.accent === "emerald"
        ? "text-emerald-700"
        : "text-gray-500"
  return (
    <div class="flex items-center gap-2 my-1 text-[11px]">
      <span class="flex-1 h-px bg-gray-200" />
      <span class={color}>{props.text}</span>
      <span class="flex-1 h-px bg-gray-200" />
    </div>
  )
}

function TodoCard(props: { item: Extract<ChatItem, { kind: "todo" }> }) {
  return (
    <div class="rounded-md border border-gray-200 px-4 py-3 bg-white mx-1">
      <Show when={props.item.title}>
        <div class="text-[12px] text-gray-500 mb-1.5">{props.item.title}</div>
      </Show>
      <ul class="flex flex-col gap-0.5">
        <For each={props.item.items}>
          {(t) => (
            <li class="flex items-start gap-2 text-[13px]">
              <span class={t.done ? "text-emerald-600" : "text-gray-400"}>{t.done ? "☑" : "☐"}</span>
              <span class={t.done ? "text-gray-500 line-through" : "text-gray-900"}>{t.text}</span>
            </li>
          )}
        </For>
      </ul>
      <div class="text-[11px] text-gray-500 mt-2">{props.item.time}</div>
    </div>
  )
}

function ArtifactCard(props: { item: Extract<ChatItem, { kind: "artifact" }>; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="text-left rounded-md border border-gray-200 px-4 py-3 bg-white mx-1 hover:bg-gray-50 hover:border-gray-300"
    >
      <div class="flex items-center gap-2">
        <span class="text-[14px]">📄</span>
        <span class="text-[13px] font-mono text-gray-900">{props.item.path}</span>
        <span class="text-[11px] text-gray-500">created · {props.item.lines} lines</span>
        <span class="ml-auto text-[11px] text-gray-500">{props.item.time}</span>
      </div>
      <div class="mt-2 font-mono text-[11px] leading-snug text-gray-500 line-clamp-3 whitespace-pre-wrap">
        {props.item.preview}
      </div>
    </button>
  )
}

// ============================================================================
// New loop dialog — pick repo / inject context / optional name
// ============================================================================

export function NewLoopDialog(props: {
  onClose: () => void
  onCreate: (opts: CreateLoopOpts) => void
}) {
  const [name, setName] = createSignal("")
  const [repo, setRepo] = createSignal("")
  const [personal, setPersonal] = createSignal<Set<string>>(new Set())

  const personalFiles = () => flattenVaultFiles(VAULT_DOCS.personal)
  const allPersonalSelected = () =>
    personalFiles().length > 0 && personalFiles().every((f) => personal().has(f.path))
  const togglePersonal = (path: string) => {
    const next = new Set(personal())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPersonal(next)
  }
  const toggleAllPersonal = () => {
    if (allPersonalSelected()) setPersonal(new Set<string>())
    else setPersonal(new Set(personalFiles().map((f) => f.path)))
  }

  const slugPreview = () =>
    previewSlug({
      name: name() || undefined,
      repo: repo() || undefined,
    })

  const handleCreate = () => {
    props.onCreate({
      name: name().trim() || undefined,
      repo: repo() || undefined,
      injectPersonal: personal().size > 0 ? [...personal()] : undefined,
    })
  }

  return (
    <div
      class="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
      onClick={props.onClose}
    >
      <div
        class="bg-white rounded-lg shadow-xl w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="px-5 h-11 shrink-0 border-b border-gray-200 flex items-center">
          <span class="text-[14px] font-medium text-gray-900">New loop</span>
          <span class="ml-auto text-[11px] text-gray-500">
            URL: <code class="font-mono text-gray-900">/loop/{slugPreview()}</code>
          </span>
          <button
            type="button"
            onClick={props.onClose}
            class="ml-3 text-gray-500 hover:text-gray-900 p-1 rounded hover:bg-gray-100"
            title="cancel"
          >
            <Icon name="close-small" />
          </button>
        </header>

        <div class="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-5">
          <DialogField label="Repo" hint="决定 workdir。可选。">
            <select
              class="w-full text-[13px] border border-gray-200 rounded px-2 h-8 bg-white"
              value={repo()}
              onChange={(e) => setRepo(e.currentTarget.value)}
            >
              <option value="">— none —</option>
              <For each={REPOS}>
                {(r) => <option value={r.name}>{r.name}</option>}
              </For>
            </select>
          </DialogField>

          <DialogField label="Context">
            <div class="border border-gray-200 rounded">
              <div class="px-3 h-8 flex items-center gap-2 text-[12px] text-gray-700 border-b border-gray-200 bg-gray-50">
                <span class="text-emerald-600">✓</span>
                <span class="font-medium">knowledge</span>
                <span class="text-gray-500">+</span>
                <span class="font-medium">notes</span>
                <span class="text-gray-500 ml-1">— public, 默认全注入</span>
              </div>
              <div class="px-3 h-8 flex items-center gap-2 border-b border-gray-200">
                <span class="text-[12px] font-medium text-gray-900">personal</span>
                <span class="text-[11px] text-gray-500">
                  {personal().size} / {personalFiles().length} selected
                </span>
                <button
                  type="button"
                  onClick={toggleAllPersonal}
                  class="ml-auto text-[11px] text-gray-600 hover:text-gray-900 px-2 h-6 rounded hover:bg-gray-100"
                >
                  {allPersonalSelected() ? "clear" : "select all"}
                </button>
              </div>
              <div class="px-3 py-1 max-h-56 overflow-auto">
                <For each={personalFiles()}>
                  {(f) => (
                    <label class="flex items-center gap-2 py-1 text-[12px] cursor-pointer hover:bg-gray-50 rounded px-1">
                      <input
                        type="checkbox"
                        class="shrink-0"
                        checked={personal().has(f.path)}
                        onChange={() => togglePersonal(f.path)}
                      />
                      <Show when={f.secret}>
                        <span class="text-amber-600 text-[11px]">🔒</span>
                      </Show>
                      <span class="font-mono text-[11px] text-gray-700 truncate">{f.path}</span>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </DialogField>

          <DialogField label="Name" hint="可选。slug 优先用 name，没则 repo，没则 hex。">
            <input
              type="text"
              class="w-full text-[13px] border border-gray-200 rounded px-2 h-8 bg-white outline-none focus:border-gray-400"
              placeholder="e.g. gateway-rdma-fix"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </DialogField>
        </div>

        <footer class="px-5 h-12 shrink-0 border-t border-gray-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            class="px-3 h-7 rounded text-xs text-gray-600 hover:bg-gray-100"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            class="px-3 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700"
          >
            create
          </button>
        </footer>
      </div>
    </div>
  )
}

function DialogField(props: { label: string; hint?: string; children: any }) {
  return (
    <div>
      <div class="flex items-baseline gap-2 mb-1.5">
        <label class="text-[12px] font-medium text-gray-900">{props.label}</label>
        <Show when={props.hint}>
          <span class="text-[11px] text-gray-500">{props.hint}</span>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

// ============================================================================
// Add-context dialog — opened from LoopHeader's "+", lets driver mount more
// personal paths into the loop's workdir.
// ============================================================================

function AddContextDialog(props: {
  loop: Loop
  onClose: () => void
  onSave: (paths: string[]) => void
}) {
  const [selected, setSelected] = createSignal<Set<string>>(
    new Set(props.loop.context.personal ?? []),
  )
  return (
    <div
      class="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
      onClick={props.onClose}
    >
      <div
        class="bg-white rounded-lg shadow-xl w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="px-5 h-11 shrink-0 border-b border-gray-200 flex items-center">
          <span class="text-[14px] font-medium text-gray-900">+ context</span>
          <span class="ml-3 text-[11px] text-gray-500">into <code class="font-mono">{props.loop.id}</code></span>
          <button
            type="button"
            onClick={props.onClose}
            class="ml-auto text-gray-500 hover:text-gray-900 p-1 rounded hover:bg-gray-100"
            title="cancel"
          >
            <Icon name="close-small" />
          </button>
        </header>

        <div class="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-4">
          <div class="border border-gray-200 rounded">
            <div class="px-3 h-8 flex items-center gap-2 text-[12px] text-gray-700 border-b border-gray-200 bg-gray-50">
              <span class="text-emerald-600">✓</span>
              <span class="font-medium">knowledge</span>
              <span class="text-gray-500">+</span>
              <span class="font-medium">notes</span>
              <span class="text-gray-500 ml-1">— public，已默认全注入</span>
            </div>
            <div class="px-3 py-2 text-[12px] text-gray-700">
              <div class="font-medium text-gray-900 mb-1.5">personal</div>
              <div class="text-[11px] text-gray-500 mb-2">
                选目录即选中所有子项。已选 {selected().size} 项。
              </div>
              <TreeChecklist
                nodes={VAULT_DOCS.personal}
                selected={selected}
                onChange={setSelected}
              />
            </div>
          </div>
        </div>

        <footer class="px-5 h-12 shrink-0 border-t border-gray-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            class="px-3 h-7 rounded text-xs text-gray-600 hover:bg-gray-100"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => props.onSave([...selected()])}
            class="px-3 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700"
          >
            save
          </button>
        </footer>
      </div>
    </div>
  )
}

function TreeChecklist(props: {
  nodes: DocNode[]
  selected: () => Set<string>
  onChange: (s: Set<string>) => void
}) {
  const leavesOf = (n: DocNode): string[] =>
    n.kind === "file" ? [n.path] : n.children.flatMap(leavesOf)

  const stateOf = (n: DocNode): "all" | "some" | "none" => {
    if (n.kind === "file") return props.selected().has(n.path) ? "all" : "none"
    const leaves = leavesOf(n)
    if (leaves.length === 0) return "none"
    const hits = leaves.filter((p) => props.selected().has(p)).length
    if (hits === 0) return "none"
    if (hits === leaves.length) return "all"
    return "some"
  }

  const toggle = (n: DocNode) => {
    const next = new Set(props.selected())
    if (n.kind === "file") {
      if (next.has(n.path)) next.delete(n.path)
      else next.add(n.path)
    } else {
      const leaves = leavesOf(n)
      const allChecked = leaves.length > 0 && leaves.every((p) => next.has(p))
      if (allChecked) leaves.forEach((p) => next.delete(p))
      else leaves.forEach((p) => next.add(p))
    }
    props.onChange(next)
  }

  return (
    <div>
      <For each={props.nodes}>
        {(n) => <TreeChecklistNode node={n} depth={0} stateOf={stateOf} toggle={toggle} />}
      </For>
    </div>
  )
}

function TreeChecklistNode(props: {
  node: DocNode
  depth: number
  stateOf: (n: DocNode) => "all" | "some" | "none"
  toggle: (n: DocNode) => void
}) {
  const [open, setOpen] = createSignal(true)
  const indent = () => `${props.depth * 0.9}rem`
  if (props.node.kind === "folder") {
    const f = props.node
    const state = () => props.stateOf(f)
    return (
      <>
        <div
          class="flex items-center gap-1.5 py-0.5 hover:bg-gray-50 rounded"
          style={{ "padding-left": indent() }}
        >
          <button
            type="button"
            class="text-gray-500 hover:text-gray-900"
            onClick={() => setOpen(!open())}
          >
            <Icon name={open() ? "chevron-down" : "chevron-right"} />
          </button>
          <Tristate state={state()} onChange={() => props.toggle(f)} />
          <Show when={f.marker === "secrets"}>
            <span class="text-[11px]">🔐</span>
          </Show>
          <span class="text-[12px] text-gray-900 font-medium">{f.name}</span>
        </div>
        <Show when={open()}>
          <For each={f.children}>
            {(c) => (
              <TreeChecklistNode
                node={c}
                depth={props.depth + 1}
                stateOf={props.stateOf}
                toggle={props.toggle}
              />
            )}
          </For>
        </Show>
      </>
    )
  }
  const file = props.node
  const state = () => props.stateOf(file)
  return (
    <div
      class="flex items-center gap-1.5 py-0.5 hover:bg-gray-50 rounded"
      style={{ "padding-left": `calc(${indent()} + 1.1rem)` }}
    >
      <Tristate state={state()} onChange={() => props.toggle(file)} />
      <Show when={file.secret}>
        <span class="text-amber-600 text-[10px]">🔒</span>
      </Show>
      <span class="font-mono text-[11px] text-gray-700 truncate">{file.name}</span>
    </div>
  )
}

function Tristate(props: { state: "all" | "some" | "none"; onChange: () => void }) {
  let ref: HTMLInputElement | undefined
  createEffect(() => {
    if (ref) ref.indeterminate = props.state === "some"
  })
  return (
    <input
      ref={ref}
      type="checkbox"
      class="shrink-0"
      checked={props.state === "all"}
      onChange={() => props.onChange()}
    />
  )
}

