import { spawn, type IPty } from "bun-pty"
import type { WSContext } from "hono/ws"
import { buildOuterBwrapArgs } from "./outer-sandbox"
import { getLoop } from "./loops"

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
    const innerShell = process.env.SHELL ?? "/bin/bash"
    const innerCmd = `script -qfc "${innerShell} -i" /dev/null`
    const bwrapArgs = await buildOuterBwrapArgs(loopId, meta.createdBy, { TERM: "xterm-256color" })
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
