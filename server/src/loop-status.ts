import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync, watch } from "node:fs"
import { LOOPAT_HOME } from "./paths"

export type LoopStatusEntry = {
  status: string
  updated: string
  viewed?: boolean
  /**
   * Runtime-readiness phase, set around ensureContainer (term.ts / session.ts):
   *  - "preparing": the per-loop sandbox image is being built (mise toolchain
   *    install / base-image pull). Terminal + chat are not yet usable — the UI
   *    shows a blocking "installing tools" overlay so the user doesn't type into
   *    a shell that isn't there or fire a chat turn that just queues.
   *  - "ready": the container is up; normal use.
   * Absent on loops that never needed a build (image already cached).
   */
  phase?: "preparing" | "ready"
}
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

/**
 * Set a loop's runtime-readiness phase (see LoopStatusEntry.phase). Bumps
 * `updated` so the loop-status WS hub broadcasts the change to subscribers.
 * Kept separate from updateLoopStatus so the human-readable build-progress
 * string (used by the kanban + the overlay) and the gate flag move independently.
 */
export function setLoopPhase(loopId: string, phase: "preparing" | "ready") {
  const prev = { ...cache }
  const entry = cache[loopId] || { status: "", updated: "", viewed: false }
  entry.phase = phase
  entry.updated = new Date().toISOString()
  cache[loopId] = entry
  save()
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
