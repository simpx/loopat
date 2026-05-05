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
 *   - rfd                       → "可被认领" + (others see "claim drive")
 *   - fork is always available, regardless of state
 *
 * Right panel (toggleable, 50/50 split when open):
 *   files / editor (CodeMirror) / terminal
 */
import { createSignal, For, Show } from "solid-js"
import { html as diff2htmlRender } from "diff2html"
import "diff2html/bundles/css/diff2html.min.css"
import { Icon } from "../components/icon"
import { Markdown } from "../components/markdown"
import { CodeEditor } from "../components/code-editor"
import {
  ME,
  loops,
  currentLoopId,
  setCurrentLoopId,
  forkLoop,
  releaseRfd,
  claimDrive,
  chats,
} from "../state"
import type { ChatItem, Loop } from "../state"
import { FILE_TREE, FILE_CONTENT } from "../mock/files"
import type { FileNode } from "../mock/files"

type RightMode = "files" | "editor" | "terminal"

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
  const [scope, setScope] = createSignal<"mine" | "all">("mine")
  const [rightOpen, setRightOpen] = createSignal(false)
  const [rightMode, setRightMode] = createSignal<RightMode>("files")
  const [editingPath, setEditingPath] = createSignal<string>("runtime/gateway.py")
  const [fileEdits, setFileEdits] = createSignal<Record<string, string>>({})
  const [openFolders, setOpenFolders] = createSignal(new Set(["runtime", "tests"]))

  const toggleFolder = (name: string) => {
    const next = new Set(openFolders())
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpenFolders(next)
  }

  const filtered = () =>
    loops().filter((l) => (scope() === "mine" ? l.driver === ME : l.status !== "archived"))

  const current = () => loops().find((l) => l.id === currentLoopId()) ?? loops()[0]

  const openFile = (path: string) => {
    setEditingPath(path)
    setRightMode("editor")
    setRightOpen(true)
  }

  const fileText = (path: string) => fileEdits()[path] ?? FILE_CONTENT[path] ?? `// ${path}\n`
  const setFileText = (path: string, value: string) =>
    setFileEdits({ ...fileEdits(), [path]: value })
  const isEdited = (path: string) =>
    path in fileEdits() && fileEdits()[path] !== (FILE_CONTENT[path] ?? "")

  const currentChat = (): ChatItem[] => chats[current().id] ?? []

  return (
    <div class="flex h-full w-full">
      <LoopsList scope={scope} setScope={setScope} filtered={filtered} />

      <div class="flex-1 min-w-0 min-h-0 flex">
        <main class="flex-1 min-w-0 flex flex-col bg-white min-h-0">
          <LoopHeader loop={current()} />

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

          <ChatInput
            current={current}
            rightOpen={rightOpen}
            rightMode={rightMode}
            setRightOpen={setRightOpen}
            setRightMode={setRightMode}
          />
        </main>

        <Show when={rightOpen() && current().workdir}>
          <RightPanel
            current={current}
            rightMode={rightMode}
            setRightMode={setRightMode}
            setRightOpen={setRightOpen}
            editingPath={editingPath}
            setEditingPath={setEditingPath}
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
}) {
  return (
    <aside class="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
      <div class="px-3 h-10 flex items-center justify-between border-b border-gray-200">
        <span class="text-xs text-gray-500">Loops</span>
        <button class="text-gray-500 hover:text-gray-900 p-0.5 rounded hover:bg-gray-100">
          <Icon name="enter" />
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
            const sel = () => currentLoopId() === loop.id
            return (
              <button
                type="button"
                onClick={() => setCurrentLoopId(loop.id)}
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
                  <span title="RFD · 可被认领" class="text-amber-600 text-[11px]">RFD</span>
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

function LoopHeader(props: { loop: Loop }) {
  const loop = () => props.loop
  const isMine = () => loop().driver === ME
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
            RFD · 可被认领
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
          onClick={() => forkLoop(loop().id)}
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
            title="release driver — others can claim"
          >
            release (RFD)
          </button>
        </Show>
        <Show when={!isMine() && loop().rfd}>
          <button
            type="button"
            onClick={() => claimDrive(loop().id)}
            class="px-3 h-7 rounded text-xs bg-emerald-100 text-emerald-900 hover:bg-emerald-200"
          >
            claim drive
          </button>
        </Show>
      </div>

      {/* workdir + branch */}
      <div class="text-xs text-gray-500 mt-1.5 flex items-center gap-2 flex-wrap">
        <Show
          when={loop().workdir}
          fallback={<span class="text-gray-400 italic">no workdir · pure design</span>}
        >
          <span>{loop().workdir}</span>
          <Show when={loop().branch}>
            <span>·</span>
            <span class="flex items-center gap-1">
              <Icon name="fork" />
              {loop().branch}
            </span>
          </Show>
        </Show>
        <span>·</span>
        <span>{loop().participants} viewing</span>
      </div>

      {/* context chips */}
      <div class="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span class="text-gray-400">context:</span>
        <ContextChip label="knowledge" value={loop().context.knowledge === "all" ? "all" : `${loop().context.knowledge.length} dirs`} />
        <For each={loop().context.repos}>
          {(repo) => <ContextChip label="repo" value={repo} />}
        </For>
        <button class="text-gray-400 hover:text-gray-700 px-1.5 py-0.5 rounded hover:bg-gray-50">
          + mount
        </button>
      </div>
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

function ChatInput(props: {
  current: () => Loop
  rightOpen: () => boolean
  rightMode: () => RightMode
  setRightOpen: (v: boolean) => void
  setRightMode: (m: RightMode) => void
}) {
  const toggleMode = (m: RightMode) => {
    if (props.rightOpen() && props.rightMode() === m) props.setRightOpen(false)
    else {
      props.setRightOpen(true)
      props.setRightMode(m)
    }
  }
  const modeBtn = (label: string, m: RightMode) => (
    <button
      class={
        props.rightOpen() && props.rightMode() === m
          ? "px-1.5 py-0.5 rounded bg-gray-100 text-gray-900"
          : "px-1.5 py-0.5 rounded hover:text-gray-900"
      }
      onClick={() => toggleMode(m)}
    >
      {label}
    </button>
  )
  return (
    <div class="px-5 pb-3 pt-2 shrink-0 border-t border-gray-200">
      <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 flex items-center gap-2">
        <Icon name="prompt" class="text-gray-500" />
        <input
          type="text"
          class="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-500"
          placeholder="type message…"
        />
        <button class="px-3 py-1 rounded bg-gray-200 text-gray-900 text-xs hover:bg-gray-300">
          send
        </button>
      </div>
      <div class="flex items-center justify-between mt-2 text-[11px] text-gray-500">
        <div class="flex items-center gap-3">
          <button class="hover:text-gray-900">+ fresh chat</button>
          <button class="hover:text-gray-900" onClick={() => forkLoop(props.current().id)}>
            ⑂ fork loop
          </button>
          <button class="hover:text-gray-900">▾ history (3)</button>
        </div>
        <Show when={props.current().workdir}>
          <div class="flex items-center gap-2">
            {modeBtn("▤ files", "files")}
            {modeBtn("✎ editor", "editor")}
            {modeBtn("▷ terminal", "terminal")}
          </div>
        </Show>
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
  setRightMode: (m: RightMode) => void
  setRightOpen: (v: boolean) => void
  editingPath: () => string
  setEditingPath: (p: string) => void
  fileText: (p: string) => string
  setFileText: (p: string, v: string) => void
  isEdited: (p: string) => boolean
  openFolders: () => Set<string>
  toggleFolder: (n: string) => void
  openFile: (p: string) => void
}) {
  return (
    <aside class="flex-1 min-w-0 border-l border-gray-200 bg-white flex flex-col">
      <header class="px-3 h-10 shrink-0 border-b border-gray-200 flex items-center gap-1">
        <ModeTab label="▤ files" active={props.rightMode() === "files"} onClick={() => props.setRightMode("files")} />
        <ModeTab label="✎ editor" active={props.rightMode() === "editor"} onClick={() => props.setRightMode("editor")} />
        <ModeTab label="▷ terminal" active={props.rightMode() === "terminal"} onClick={() => props.setRightMode("terminal")} />
        <Show when={props.rightMode() === "editor"}>
          <span class="ml-2 text-[11px] text-gray-500 truncate">
            {props.editingPath()}
            <Show when={props.isEdited(props.editingPath())}>
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

      <Show when={props.rightMode() === "files"}>
        <div class="flex-1 min-h-0 overflow-auto py-2">
          <For each={FILE_TREE}>
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
          {" · 2 files modified"}
        </div>
      </Show>

      <Show when={props.rightMode() === "editor"}>
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

function ModeTab(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={
        props.active
          ? "px-2.5 h-7 rounded text-xs bg-gray-100 text-gray-900"
          : "px-2.5 h-7 rounded text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      }
    >
      {props.label}
    </button>
  )
}

function FileTreeNode(props: {
  node: FileNode
  depth: number
  openFolders: () => Set<string>
  toggleFolder: (name: string) => void
  onOpen: (path: string) => void
  currentPath: () => string
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
              <FileTreeNode
                node={child}
                depth={props.depth + 1}
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
  return (
    <button
      type="button"
      class={
        sel()
          ? "w-full py-1 flex items-center gap-2 text-left bg-gray-100"
          : "w-full py-1 flex items-center gap-2 text-left hover:bg-gray-50"
      }
      style={{ "padding-left": `${0.5 + props.depth * 0.75}rem`, "padding-right": "0.5rem" }}
      onClick={() => props.onOpen(file.path)}
    >
      <span class="w-4" />
      <span class="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{file.name}</span>
      <Show when={file.staged}>
        <span class="text-[11px] text-emerald-600" title="staged">A</span>
      </Show>
      <Show when={file.modified && !file.staged}>
        <span class="text-[11px] text-gray-500" title="modified">M</span>
      </Show>
    </button>
  )
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
    return <SystemMarker text={`${item.time}  ${item.by} 释放 driver · loop 进入 RFD（任何人可认领）`} accent="amber" />
  }
  if (item.kind === "claim") {
    return <SystemMarker text={`${item.time}  ${item.by} 认领了 driver`} accent="emerald" />
  }

  if (item.kind === "user") {
    return (
      <div class="rounded-md bg-gray-100 px-4 py-3">
        <Markdown text={item.text} class="prose-chat" />
        <div class="text-[11px] text-gray-500 mt-2">{item.time}</div>
      </div>
    )
  }

  if (item.kind === "ai") {
    return (
      <div class="px-4 py-2">
        <Markdown text={item.text} class="prose-chat" />
        <div class="text-[11px] text-gray-500 mt-2">{item.time}</div>
      </div>
    )
  }

  if (item.kind === "diff") {
    return <DiffCard item={item} />
  }
  if (item.kind === "read") {
    return <ReadCard item={item} onOpen={() => props.onOpenFile(item.path)} />
  }
  if (item.kind === "todo") {
    return <TodoCard item={item} />
  }
  if (item.kind === "artifact") {
    return <ArtifactCard item={item} onOpen={() => props.onOpenFile(item.path)} />
  }
  if (item.kind === "command") {
    return <CommandCard item={item} />
  }
  return null
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

function buildUnifiedDiff(file: string, lines: { kind: string; text: string }[]): string {
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`]
  for (const line of lines) {
    if (line.kind === "hunk") out.push(line.text)
    else if (line.kind === "add") out.push("+" + line.text.replace(/^[+-]?\t?/, ""))
    else if (line.kind === "del") out.push("-" + line.text.replace(/^[+-]?\t?/, ""))
    else out.push(" " + line.text)
  }
  return out.join("\n")
}

function DiffCard(props: { item: Extract<ChatItem, { kind: "diff" }> }) {
  const html = () =>
    diff2htmlRender(buildUnifiedDiff(props.item.file, props.item.lines), {
      drawFileList: false,
      matching: "lines",
      outputFormat: "line-by-line",
    })
  return (
    <div class="rounded-md border border-gray-200 overflow-hidden bg-white mx-1">
      <header class="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
        <span class="text-[11px] text-gray-500">diff</span>
        <span class="text-[12px] font-mono text-gray-900">{props.item.file}</span>
        <span class="ml-auto text-[11px] text-gray-500">{props.item.time}</span>
      </header>
      <div class="diff-card-body text-[12px]" innerHTML={html()} />
    </div>
  )
}

function ReadCard(props: { item: Extract<ChatItem, { kind: "read" }>; onOpen: () => void }) {
  const start = () => props.item.startLine ?? 1
  const range = () => `L${start()}-${start() + props.item.lines.length - 1}`
  return (
    <div class="rounded-md border border-gray-200 overflow-hidden bg-white mx-1">
      <header class="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
        <span class="text-[11px] text-gray-500">read</span>
        <button
          type="button"
          onClick={props.onOpen}
          class="text-[12px] font-mono text-gray-900 hover:underline"
          title="open in editor"
        >
          {props.item.path}
        </button>
        <span class="text-[11px] text-gray-500">
          {range()}
          <Show when={props.item.total}>
            <span> of {props.item.total}</span>
          </Show>
        </span>
        <span class="ml-auto text-[11px] text-gray-500">{props.item.time}</span>
      </header>
      <div class="overflow-auto">
        <table class="font-mono text-[12px] leading-snug border-collapse w-full text-gray-800">
          <tbody>
            <For each={props.item.lines}>
              {(text, i) => (
                <tr>
                  <td class="w-10 text-right pr-2 py-[1px] text-gray-400 select-none border-r border-gray-100 align-top">
                    {start() + i()}
                  </td>
                  <td class="pl-3 pr-3 py-[1px] whitespace-pre align-top">
                    {text || "\u00A0"}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
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
      <pre class="mt-2 font-mono text-[11px] leading-snug text-gray-500 line-clamp-3 whitespace-pre-wrap">
        {props.item.preview}
      </pre>
    </button>
  )
}

function CommandCard(props: { item: Extract<ChatItem, { kind: "command" }> }) {
  return (
    <div class="rounded-md border border-gray-200 overflow-hidden bg-white mx-1">
      <header class="px-3 py-1.5 bg-gray-900 text-gray-100 flex items-center gap-2 font-mono text-[12px]">
        <span class="text-gray-400">$</span>
        <span class="flex-1 truncate">{props.item.cmd}</span>
        <Show when={props.item.ok !== undefined}>
          <span class={props.item.ok ? "text-emerald-400" : "text-red-400"}>
            {props.item.ok ? "✓" : "✗"}
          </span>
        </Show>
        <span class="text-gray-400">{props.item.time}</span>
      </header>
      <pre class="px-3 py-2 font-mono text-[12px] leading-snug text-gray-700 bg-gray-50 overflow-auto">
        <For each={props.item.output}>{(line) => <div>{line}</div>}</For>
      </pre>
    </div>
  )
}
