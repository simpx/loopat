import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync, watch } from "node:fs"
import { LOOPAT_HOME } from "./paths"

export type LoopStatusEntry = { status: string; updated: string; viewed?: boolean }
export type LoopStatusMap = Record<string, LoopStatusEntry>

const STATUS_FILE = join(LOOPAT_HOME, "loop-status.json")
let cache: LoopStatusMap = {}
const watchers = new Set<(curr: LoopStatusMap, prev: LoopStatusMap) => void>()

if (existsSync(STATUS_FILE)) {
  try { cache = JSON.parse(readFileSync(STATUS_FILE, "utf8")) } catch {}
}

function save() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(cache, null, 2))
  } catch (e) {
    console.error("[loop-status] Failed to write file:", e)
  }
}

export function updateLoopStatus(loopId: string, status: string) {
  const prev = { ...cache }
  const entry = cache[loopId] || { status: "", updated: "", viewed: false }
  entry.status = status
  entry.updated = new Date().toISOString()
  if (status === "Done") {
    entry.viewed = false
  }
  cache[loopId] = entry
  save()

  // Immediately notify watchers without waiting for file system event
  for (const fn of watchers) {
    fn(cache, prev)
  }
}

export function markLoopViewed(loopId: string) {
  if (cache[loopId]) {
    cache[loopId].viewed = true
    save()
  }
}

export function getLoopStatus(): LoopStatusMap {
  return cache
}

export function watchStatusFile(fn: (curr: LoopStatusMap, prev: LoopStatusMap) => void) {
  watchers.add(fn)
  let prev = { ...cache }
  try {
    watch(STATUS_FILE, (eventType) => {
      if (eventType === "change") {
        try {
          const raw = readFileSync(STATUS_FILE, "utf8")
          const curr = JSON.parse(raw)
          fn(curr, prev)
          prev = curr
        } catch {}
      }
    })
  } catch {}
}
