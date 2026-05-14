import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { join, basename } from "node:path"
import { workspaceNotesDir } from "./paths"
import { createLoop, patchLoopMeta, type LoopMeta } from "./loops"

// ── types ──

export type KanbanCard = {
  cid: string
  text: string
  done: boolean
  assignee?: string
  priority?: string
  due?: string
  loopId?: string
  topics: string[]
  description: string
  subtasks: { text: string; done: boolean }[]
}

export type KanbanColumn = {
  filename: string
  title: string
  cards: KanbanCard[]
}

// ── regex ──

const BULLET_CARD_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/
const META_RE = /^\s*>\s*([\w-]+):\s*(.*)$/
const INDENT_BULLET_RE = /^\s+-\s*\[([ xX])\]\s+(.*)$/
const TOPIC_RE = /(?<![\w])#([A-Za-z0-9][\w-]*)/g

function extractTopics(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(TOPIC_RE)) {
    seen.add(m[1].toLowerCase())
  }
  return [...seen]
}

function hashCid(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) & 0xffffffff
  }
  return h.toString(36)
}

// ── column parser ──

/** Parse a single column markdown file into its column + cards. */
function parseColumnFile(filename: string, body: string): KanbanColumn {
  const lines = body.split("\n")
  let title = basename(filename, ".md")
  const cards: KanbanCard[] = []

  let inFrontmatter = false
  let i = 0

  for (; i < lines.length; i++) {
    const line = lines[i]

    // skip YAML frontmatter
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === "---") { inFrontmatter = false }
      continue
    }

    // first non-frontmatter # heading → column title
    const h1 = line.match(/^#\s+(.*)$/)
    if (h1) {
      title = h1[1].trim() || title
      i++
      break
    }

    // if we hit content without a heading, stay at this index
    if (line.trim() && !line.startsWith("#")) {
      break
    }
  }

  // parse cards: each top-level - [ ] starts a card, indented content belongs to it
  for (; i < lines.length; i++) {
    const line = lines[i]
    const bm = line.match(BULLET_CARD_RE)
    if (!bm) continue

    const indent = bm[1]
    // only top-level bullets are cards
    if (indent !== "") continue

    const done = bm[2].toLowerCase() === "x"
    const text = bm[3].trim()
    const cid = hashCid(text)

    let assignee: string | undefined
    let priority: string | undefined
    let due: string | undefined
    let loopId: string | undefined
    const descLines: string[] = []
    const subtasks: { text: string; done: boolean }[] = []

    // consume indented sub-content for this card
    let j = i + 1
    while (j < lines.length) {
      const sub = lines[j]
      // stop at next top-level bullet or next heading
      if (/^-\s*\[[ xX]\]/.test(sub) || /^#+\s/.test(sub)) break
      if (sub.trim() === "") { j++; continue }

      // only process indented lines
      if (!sub.startsWith(" ") && !sub.startsWith("\t")) { j++; continue }

      const mm = sub.match(META_RE)
      if (mm) {
        const k = mm[1].toLowerCase()
        const v = mm[2].trim()
        if (k === "assignee") assignee = v || undefined
        else if (k === "priority") priority = v || undefined
        else if (k === "due") due = v || undefined
        else if (k === "loop") loopId = v || undefined
        j++
        continue
      }

      const ib = sub.match(INDENT_BULLET_RE)
      if (ib) {
        subtasks.push({ text: ib[2].trim(), done: ib[1].toLowerCase() === "x" })
        j++
        continue
      }

      descLines.push(sub.trim())
      j++
    }

    cards.push({
      cid,
      text,
      done,
      assignee,
      priority,
      due,
      loopId,
      topics: extractTopics(text),
      description: descLines.join("\n").trim(),
      subtasks,
    })
  }

  return { filename, title, cards }
}

// ── directory ──

function todoDir(): string {
  return join(workspaceNotesDir(), "todo")
}

// ── read / list ──

export async function listKanbanColumns(): Promise<KanbanColumn[]> {
  const dir = todoDir()
  let entries: string[] = []
  try { entries = await readdir(dir) } catch { return [] }

  const cols: KanbanColumn[] = []
  for (const f of entries) {
    if (!f.endsWith(".md")) continue
    try {
      const body = await readFile(join(dir, f), "utf8")
      cols.push(parseColumnFile(f, body))
    } catch { /* skip unreadable */ }
  }

  // sort: predefined order first, then alphabetical
  const ORDER = ["backlog", "todo", "in-progress", "done"]
  cols.sort((a, b) => {
    const ai = ORDER.indexOf(basename(a.filename, ".md"))
    const bi = ORDER.indexOf(basename(b.filename, ".md"))
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.title.localeCompare(b.title)
  })
  return cols
}

async function readColumnRaw(filename: string): Promise<{ body: string; path: string } | null> {
  const safe = basename(filename)
  if (!safe || safe.startsWith(".")) return null
  const path = join(todoDir(), safe)
  try {
    const body = await readFile(path, "utf8")
    return { body, path }
  } catch {
    return null
  }
}

// ── card helpers: find card lines in raw body ──

function findCardRange(body: string, cid: string): { start: number; end: number; text: string } | null {
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const bm = lines[i].match(BULLET_CARD_RE)
    if (!bm || bm[1] !== "") continue
    const text = bm[3].trim()
    if (hashCid(text) !== cid) continue

    // found the card at line i; find where its sub-content ends
    let end = i + 1
    while (end < lines.length) {
      const sub = lines[end]
      if (/^-\s*\[[ xX]\]/.test(sub) || /^#+\s/.test(sub)) break
      end++
    }
    return { start: i, end, text }
  }
  return null
}

// ── mutations ──

export async function addCard(filename: string, opts: {
  text: string
  assignee?: string
  priority?: string
  due?: string
  topics?: string[]
  description?: string
}): Promise<{ ok: boolean; cid?: string }> {
  const raw = await readColumnRaw(filename)
  if (!raw) {
    // create new column file
    const title = basename(filename, ".md")
    const body = `# ${title}\n\n- [ ] ${opts.text}\n`
    await mkdir(todoDir(), { recursive: true })
    await writeFile(join(todoDir(), basename(filename)), body)
    return { ok: true, cid: hashCid(opts.text) }
  }

  let lines = raw.body.split("\n")

  // build card line with topics
  const topicStr = opts.topics?.length ? " " + opts.topics.map((t) => `#${t}`).join(" ") : ""
  const cardLine = `- [ ] ${opts.text}${topicStr}`

  // append metadata sub-lines
  const subLines: string[] = []
  if (opts.assignee) subLines.push(`  > assignee: ${opts.assignee}`)
  if (opts.priority) subLines.push(`  > priority: ${opts.priority}`)
  if (opts.due) subLines.push(`  > due: ${opts.due}`)
  if (opts.description) {
    for (const dl of opts.description.split("\n")) {
      subLines.push(`  ${dl}`)
    }
  }

  // append card at end, with blank line separator if there are existing cards
  const hasCards = lines.some((l) => /^-\s*\[[ xX]\]/.test(l))
  if (hasCards) lines.push("")
  lines.push(cardLine)
  for (const sl of subLines) lines.push(sl)
  // ensure trailing newline
  if (lines[lines.length - 1] !== "") lines.push("")

  await writeFile(raw.path, lines.join("\n"))
  return { ok: true, cid: hashCid(opts.text) }
}

export async function toggleCard(filename: string, cid: string): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false

  const lines = raw.body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const bm = lines[i].match(BULLET_CARD_RE)
    if (!bm || bm[1] !== "") continue
    if (hashCid(bm[3].trim()) !== cid) continue

    const ch = bm[2].toLowerCase() === "x" ? " " : "x"
    lines[i] = lines[i].replace(/\[[ xX]\]/, `[${ch}]`)
    await writeFile(raw.path, lines.join("\n"))
    return true
  }
  return false
}

export async function deleteCard(filename: string, cid: string): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false

  const range = findCardRange(raw.body, cid)
  if (!range) return false

  const lines = raw.body.split("\n")
  // remove trailing blank line if card was the last content
  while (range.end < lines.length && lines[range.end].trim() === "") range.end++
  lines.splice(range.start, range.end - range.start)

  // clean up trailing double-blanks
  const newBody = lines.join("\n").replace(/\n{3,}/g, "\n\n")
  await writeFile(raw.path, newBody)
  return true
}

export async function moveCard(fromFile: string, cid: string, toFile: string, toIndex?: number): Promise<boolean> {
  const fromRaw = await readColumnRaw(fromFile)
  if (!fromRaw) return false

  const range = findCardRange(fromRaw.body, cid)
  if (!range) return false

  const fromLines = fromRaw.body.split("\n")

  // extract card lines (including sub-content)
  const cardLines: string[] = []
  for (let i = range.start; i < range.end; i++) {
    cardLines.push(fromLines[i])
  }

  // remove from source
  let end = range.end
  while (end < fromLines.length && fromLines[end].trim() === "") end++
  fromLines.splice(range.start, end - range.start)
  const newFromBody = fromLines.join("\n").replace(/\n{3,}/g, "\n\n")
  await writeFile(fromRaw.path, newFromBody)

  // insert into target at position
  const toRaw = await readColumnRaw(toFile)
  if (!toRaw) {
    // create target column
    const title = basename(toFile, ".md")
    const body = `# ${title}\n\n${cardLines.join("\n")}\n`
    await mkdir(todoDir(), { recursive: true })
    await writeFile(join(todoDir(), basename(toFile)), body)
    return true
  }

  const toLines = toRaw.body.split("\n")

  if (toIndex !== undefined && toIndex >= 0) {
    // find the line index of the toIndex-th card
    let cardCount = 0
    let insertAt = toLines.length
    for (let i = 0; i < toLines.length; i++) {
      const bm = toLines[i].match(BULLET_CARD_RE)
      if (bm && bm[1] === "") {
        if (cardCount === toIndex) {
          insertAt = i
          break
        }
        cardCount++
      }
    }
    // insert before the target card
    const linesToInsert = [...cardLines]
    if (insertAt < toLines.length) {
      // add blank line separator before the card we're inserting before
      if (insertAt > 0 && toLines[insertAt - 1].trim() !== "") {
        linesToInsert.push("")
      }
    }
    toLines.splice(insertAt, 0, ...linesToInsert)
  } else {
    // append to end
    if (toLines[toLines.length - 1] !== "") toLines.push("")
    toLines.push(...cardLines)
  }
  if (toLines[toLines.length - 1] !== "") toLines.push("")
  await writeFile(toRaw.path, toLines.join("\n"))
  return true
}

export async function updateCardMeta(filename: string, cid: string, patch: {
  text?: string; assignee?: string; priority?: string; due?: string
}): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false

  const range = findCardRange(raw.body, cid)
  if (!range) return false

  const lines = raw.body.split("\n")
  const cardText = range.text

  // Update the card text line itself
  if (patch.text !== undefined && patch.text !== cardText) {
    const bm = lines[range.start].match(BULLET_CARD_RE)
    if (bm) {
      const ch = bm[2].toLowerCase() === "x" ? "x" : " "
      lines[range.start] = `- [${ch}] ${patch.text}`
    }
  }

  // Update/add metadata sub-lines within the card's range
  if (patch.assignee !== undefined || patch.priority !== undefined || patch.due !== undefined) {
    const metaPatch: Record<string, string | undefined> = {
      assignee: patch.assignee,
      priority: patch.priority,
      due: patch.due,
    }

    // find existing meta lines and update them
    const seen = new Set<string>()
    for (let i = range.start + 1; i < range.end; i++) {
      const mm = lines[i].match(META_RE)
      if (!mm) continue
      const k = mm[1].toLowerCase()
      if (k in metaPatch) {
        seen.add(k)
        const v = metaPatch[k]
        if (v !== undefined) {
          lines[i] = lines[i].replace(/^(\s*)> .*$/, `$1> ${k}: ${v}`)
        } else {
          lines[i] = ""
        }
      }
    }

    // add missing meta keys after card line
    for (const [k, v] of Object.entries(metaPatch)) {
      if (!seen.has(k) && v !== undefined) {
        lines.splice(range.start + 1, 0, `  > ${k}: ${v}`)
      }
    }
  }

  await writeFile(raw.path, lines.join("\n"))
  return true
}

/** Replace the entire card block (bullet line + indented content) in a column file. */
export async function updateCardBlock(filename: string, cid: string, newBlock: string): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false
  const range = findCardRange(raw.body, cid)
  if (!range) return false
  const lines = raw.body.split("\n")
  // Also swallow trailing blank lines after the card block
  let end = range.end
  while (end < lines.length && lines[end].trim() === "") end++
  lines.splice(range.start, end - range.start, ...newBlock.split("\n"))
  // Clean up excessive blanks
  const newBody = lines.join("\n").replace(/\n{3,}/g, "\n\n")
  await writeFile(raw.path, newBody)
  return true
}

export async function assignDriverForCard(
  filename: string,
  cid: string,
  userId: string
): Promise<{ ok: boolean; loopId?: string }> {
  const cols = await listKanbanColumns()
  const col = cols.find((c) => c.filename === filename)
  const card = col?.cards.find((c) => c.cid === cid)
  if (!card || !card.loopId) return { ok: false }

  const updated = await patchLoopMeta(card.loopId, { driver: userId } as Partial<LoopMeta>)
  if (!updated) return { ok: false }

  await updateCardMeta(filename, cid, { assignee: userId })
  return { ok: true, loopId: card.loopId }
}

export async function linkLoopToCard(
  filename: string,
  cid: string,
  loopId: string,
  userId: string
): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false

  const range = findCardRange(raw.body, cid)
  if (!range) return false

  const lines = raw.body.split("\n")
  lines.splice(range.start + 1, 0, `  > loop: ${loopId}`)
  await writeFile(raw.path, lines.join("\n"))

  await patchLoopMeta(loopId, { driver: userId } as Partial<LoopMeta>)
  return true
}

export async function createLoopFromCard(
  filename: string,
  cid: string,
  userId: string
): Promise<{ ok: boolean; loopId?: string }> {
  const cols = await listKanbanColumns()
  const col = cols.find((c) => c.filename === filename)
  const card = col?.cards.find((c) => c.cid === cid)
  if (!card) return { ok: false }

  const loop = await createLoop({ title: card.text, createdBy: userId })
  // Set driver to the creating user
  await patchLoopMeta(loop.id, { driver: userId } as Partial<LoopMeta>)

  // add loop association as a meta line
  const raw = await readColumnRaw(filename)
  if (raw) {
    const range = findCardRange(raw.body, cid)
    if (range) {
      const lines = raw.body.split("\n")
      lines.splice(range.start + 1, 0, `  > loop: ${loop.id}`)
      await writeFile(raw.path, lines.join("\n"))
    }
  }

  return { ok: true, loopId: loop.id }
}

export async function createColumn(filename: string, title?: string): Promise<boolean> {
  const safe = basename(filename)
  if (!safe || safe.startsWith(".")) return false
  const dir = todoDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, safe)
  const displayTitle = title || basename(safe, ".md")
  await writeFile(path, `# ${displayTitle}\n\n`)
  return true
}

/** Persist card order within a column file. */
export async function reorderCards(filename: string, orderedCids: string[]): Promise<boolean> {
  const raw = await readColumnRaw(filename)
  if (!raw) return false

  const lines = raw.body.split("\n")

  // Extract card blocks: each card is its bullet line + all indented sub-lines
  interface CardBlock { cid: string; start: number; end: number; lines: string[] }
  const blocks: CardBlock[] = []

  for (let i = 0; i < lines.length; i++) {
    const bm = lines[i].match(BULLET_CARD_RE)
    if (!bm || bm[1] !== "") continue
    const text = bm[3].trim()
    const cid = hashCid(text)

    let end = i + 1
    while (end < lines.length) {
      const sub = lines[end]
      if (/^-\s*\[[ xX]\]/.test(sub) || /^#+\s/.test(sub)) break
      end++
    }

    blocks.push({
      cid,
      start: i,
      end,
      lines: lines.slice(i, end),
    })
  }

  // Reorder blocks
  const cidOrder = new Map(orderedCids.map((c, i) => [c, i]))
  const notInOrder = blocks.filter((b) => !cidOrder.has(b.cid))
  const ordered = blocks
    .filter((b) => cidOrder.has(b.cid))
    .sort((a, b) => (cidOrder.get(a.cid) ?? 0) - (cidOrder.get(b.cid) ?? 0))
  const reordered = [...ordered, ...notInOrder]

  // Find the content before first card and after last card
  const firstCardIdx = blocks.reduce((min, b) => Math.min(min, b.start), Infinity)
  const prefix = lines.slice(0, firstCardIdx)

  // Rebuild: prefix + reordered card blocks
  const result = [...prefix]
  for (const b of reordered) {
    for (const l of b.lines) result.push(l)
  }

  // Trim trailing blanks
  while (result.length && result[result.length - 1].trim() === "") result.pop()
  result.push("")

  await writeFile(raw.path, result.join("\n"))
  return true
}

// ── column config (notes/todo/config.yaml) ──

export type KanbanColumnConfig = {
  file: string
  color?: string
}

export type KanbanConfig = {
  columns: KanbanColumnConfig[]
}

function configPath(): string {
  return join(todoDir(), "config.yaml")
}

export async function readKanbanConfig(): Promise<KanbanConfig | null> {
  try {
    const raw = await readFile(configPath(), "utf8")
    return parseYaml(raw)
  } catch {
    return null
  }
}

async function writeKanbanConfig(cfg: KanbanConfig): Promise<void> {
  await mkdir(todoDir(), { recursive: true })
  const lines = ["columns:"]
  for (const c of cfg.columns) {
    lines.push(`  - file: ${c.file}`)
    if (c.color) lines.push(`    color: "${c.color}"`)
  }
  await writeFile(configPath(), lines.join("\n") + "\n")
}

/** Minimal YAML parser for our simple config format. */
function parseYaml(raw: string): KanbanConfig {
  const cfg: KanbanConfig = { columns: [] }
  let cur: Partial<KanbanColumnConfig> | null = null
  for (const line of raw.split("\n")) {
    const seq = line.match(/^\s*-\s+file:\s*(\S+)/)
    if (seq) {
      if (cur?.file) { cfg.columns.push({ file: cur.file, color: cur.color }) }
      cur = { file: seq[1] }
      continue
    }
    if (cur) {
      const color = line.match(/^\s+color:\s*"?([^"]*)"?/)
      if (color) { cur.color = color[1] || undefined }
    }
  }
  if (cur?.file) cfg.columns.push({ file: cur.file, color: cur.color })
  return cfg
}

/** Save column order to config. Creates/updates config.yaml. */
export async function saveColumnOrder(orderedFiles: string[]): Promise<void> {
  const existing = await readKanbanConfig()
  const colorMap = new Map((existing?.columns ?? []).map((c) => [c.file, c.color]))
  const columns: KanbanColumnConfig[] = orderedFiles.map((f) => {
    const entry: KanbanColumnConfig = { file: f }
    const color = colorMap.get(f)
    if (color) entry.color = color
    return entry
  })
  await writeKanbanConfig({ columns })
}

/** Update column color in config. */
export async function setColumnColor(filename: string, color: string): Promise<void> {
  const cfg = await readKanbanConfig()
  const existing = cfg?.columns ?? []
  const found = existing.find((c) => c.file === filename)
  if (found) {
    found.color = color
  } else {
    existing.push({ file: filename, color })
  }
  await writeKanbanConfig({ columns: existing })
}

/** Delete a column file. All cards in the column are lost (caller should archive first). */
export async function deleteColumn(filename: string): Promise<boolean> {
  const safe = basename(filename)
  try {
    await unlink(join(todoDir(), safe))
  } catch {
    return false
  }
  const cfg = await readKanbanConfig()
  if (cfg) {
    cfg.columns = cfg.columns.filter((c) => c.file !== safe)
    await writeKanbanConfig(cfg)
  }
  return true
}

/** Rename a column file on disk and update config if present. */
export async function renameColumn(fromFile: string, toFile: string): Promise<boolean> {
  const safeFrom = basename(fromFile)
  const safeTo = basename(toFile)
  if (!safeTo || safeTo.startsWith(".") || !safeTo.endsWith(".md")) return false
  const dir = todoDir()
  try {
    await rename(join(dir, safeFrom), join(dir, safeTo))
  } catch {
    return false
  }
  // update config if present
  const cfg = await readKanbanConfig()
  if (cfg) {
    const found = cfg.columns.find((c) => c.file === safeFrom)
    if (found) found.file = safeTo
    await writeKanbanConfig(cfg)
  }
  return true
}
