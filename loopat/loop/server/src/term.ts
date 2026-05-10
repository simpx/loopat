import { spawn, type IPty } from "bun-pty"
import type { WSContext } from "hono/ws"
import { loopWorkdir } from "./paths"
import { wrapForLoop } from "./sandbox"

type Term = {
  proc: IPty
  subscribers: Set<WSContext>
}

const terms = new Map<string, Term>()
const pending = new Map<string, Promise<Term>>()

async function getOrSpawn(loopId: string): Promise<Term> {
  const existing = terms.get(loopId)
  if (existing) return existing
  const inflight = pending.get(loopId)
  if (inflight) return inflight

  const p = (async () => {
    const workdir = loopWorkdir(loopId)
    const innerShell = process.env.SHELL ?? "/bin/bash"
    // Wrap inner shell with `script` so it gets a fresh controlling tty.
    // Without this, multiple `bash -c` layers from sandbox-runtime strip the
    // tty; bash logs "cannot set terminal process group · no job control".
    const innerCmd = `script -qfc "${innerShell} -i" /dev/null`
    const wrappedCmd = await wrapForLoop(innerCmd, loopId)
    const proc = spawn("/bin/bash", ["-c", wrappedCmd], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workdir,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    })
    const t: Term = { proc, subscribers: new Set() }
    terms.set(loopId, t)

    proc.onData((chunk) => {
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
