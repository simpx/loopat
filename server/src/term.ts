import { spawn, type IPty } from "bun-pty"
import type { WSContext } from "hono/ws"
import { mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"
import { buildOuterBwrapArgs } from "./outer-sandbox"
import { getLoop } from "./loops"
import { loadPersonalConfig } from "./config"

type Term = {
  proc: IPty
  subscribers: Set<WSContext>
  /**
   * Rolling buffer of recent PTY output. Replayed to each new subscriber
   * so the initial prompt (emitted before the first ws joined) and history
   * since term spawn are visible on attach. Capped by SCROLLBACK_MAX_BYTES.
   */
  scrollback: string[]
  scrollbackBytes: number
}

const SCROLLBACK_MAX_BYTES = 64 * 1024

const terms = new Map<string, Term>()
const pending = new Map<string, Promise<Term>>()

async function getOrSpawn(loopId: string): Promise<Term> {
  const existing = terms.get(loopId)
  if (existing) return existing
  const inflight = pending.get(loopId)
  if (inflight) return inflight

  const p = (async () => {
    // Outer bwrap argv (same shape as Claude CLI's outer sandbox — virtual
    // /loopat/loop/<id>/, /loopat/context/*). Wrap inner shell with `script`
    // so it gets a fresh controlling tty (without this, the bash-in-bash
    // chain strips tty control).
    const meta = await getLoop(loopId)
    if (!meta) throw new Error(`loop ${loopId} not found`)
    const personalCfg = await loadPersonalConfig(meta.createdBy)
    const innerShell = personalCfg.sandbox?.shell ?? "/usr/bin/fish"
    const innerCmd = `script -qfc "${innerShell} -i" /dev/null`

    // Fish (and other interactive shells) want to write to XDG_DATA_HOME
    // (history) and XDG_RUNTIME_DIR (notifier pipe). Both default to paths
    // (~/.local/share, /run/user/$UID) that are ro-bound in our sandbox.
    // Point them at /tmp/loopat-fish-<id>/ — /tmp is bind-rw and shared with
    // the host, so the dir we mkdir here is visible to the sandbox at the
    // same path. Per-loop dir avoids cross-loop history mixing and keeps
    // XDG_RUNTIME_DIR's mode-0700 requirement easy to satisfy.
    const fishHome = `/tmp/loopat-fish-${loopId}`
    const fishData = join(fishHome, "data")
    const fishRuntime = join(fishHome, "runtime")
    await mkdir(fishData, { recursive: true })
    await mkdir(fishRuntime, { recursive: true })
    await chmod(fishRuntime, 0o700).catch(() => {})

    const bwrapArgs = await buildOuterBwrapArgs(loopId, meta.createdBy, {
      TERM: "xterm-256color",
      XDG_DATA_HOME: fishData,
      XDG_RUNTIME_DIR: fishRuntime,
    })
    const fullArgs = [...bwrapArgs, "--", "/bin/bash", "-c", innerCmd]
    const proc = spawn("bwrap", fullArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    })
    const t: Term = { proc, subscribers: new Set(), scrollback: [], scrollbackBytes: 0 }
    terms.set(loopId, t)

    proc.onData((chunk) => {
      t.scrollback.push(chunk)
      t.scrollbackBytes += chunk.length
      while (t.scrollbackBytes > SCROLLBACK_MAX_BYTES && t.scrollback.length > 1) {
        const dropped = t.scrollback.shift()!
        t.scrollbackBytes -= dropped.length
      }
      for (const ws of t.subscribers) {
        try {
          ws.send(JSON.stringify({ type: "data", data: chunk }))
        } catch {}
      }
    })
    proc.onExit(({ exitCode }) => {
      for (const ws of t.subscribers) {
        try {
          ws.send(JSON.stringify({ type: "exit", code: exitCode }))
          ws.close()
        } catch {}
      }
      terms.delete(loopId)
    })

    return t
  })()

  pending.set(loopId, p)
  try {
    return await p
  } finally {
    pending.delete(loopId)
  }
}

export async function attachTerm(loopId: string, ws: WSContext) {
  const t = await getOrSpawn(loopId)
  // Replay scrollback BEFORE adding to subscribers so the new viewer sees the
  // initial prompt + prior output exactly once (live chunks come after).
  for (const chunk of t.scrollback) {
    try {
      ws.send(JSON.stringify({ type: "data", data: chunk }))
    } catch {}
  }
  t.subscribers.add(ws)
}

export function detachTerm(loopId: string, ws: WSContext) {
  const t = terms.get(loopId)
  if (!t) return
  t.subscribers.delete(ws)
  if (t.subscribers.size === 0) {
    try {
      t.proc.kill()
    } catch {}
    terms.delete(loopId)
  }
}

export function writeTerm(loopId: string, data: string) {
  const t = terms.get(loopId)
  if (!t) return
  t.proc.write(data)
}

export function resizeTerm(loopId: string, cols: number, rows: number) {
  const t = terms.get(loopId)
  if (!t) return
  try {
    t.proc.resize(cols, rows)
  } catch {}
}

/** Force-kill a loop's terminal PTY process and disconnect all subscribers.
 *  Handles the in-flight spawn case (pending promise). */
export function killTerm(loopId: string) {
  const inflight = pending.get(loopId)
  if (inflight) {
    inflight.then((t) => {
      terms.delete(loopId)
      for (const ws of t.subscribers) {
        try { ws.send(JSON.stringify({ type: "exit", code: -1 })); ws.close() } catch {}
      }
      try { t.proc.kill() } catch {}
    }).catch(() => {})
    pending.delete(loopId)
    return
  }
  const t = terms.get(loopId)
  if (!t) return
  terms.delete(loopId)
  for (const ws of t.subscribers) {
    try {
      ws.send(JSON.stringify({ type: "exit", code: -1 }))
      ws.close()
    } catch {}
  }
  t.subscribers.clear()
  try { t.proc.kill() } catch {}
}
