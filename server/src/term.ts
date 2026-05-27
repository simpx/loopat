import { spawn, type IPty } from "bun-pty"
import type { WSContext } from "hono/ws"
import { mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"
import { ensureContainer, buildPodmanExecArgs, markActive, markInactive, V_LOOP_WORKDIR } from "./podman"
import { effectiveDriver, getLoop } from "./loops"
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

async function getOrSpawn(loopId: string, initCols = 80, initRows = 24): Promise<Term> {
  const existing = terms.get(loopId)
  if (existing) return existing
  const inflight = pending.get(loopId)
  if (inflight) return inflight

  const tag = loopId.slice(0, 8)
  const p = (async () => {
    const meta = await getLoop(loopId)
    if (!meta) throw new Error(`loop ${loopId} not found`)
    const driver = effectiveDriver(meta)
    const personalCfg = await loadPersonalConfig(driver, meta.config?.vault)

    // Shell resolution (highest precedence first):
    //   1. personal config `shell` — user's per-user override
    //   2. /bin/bash — POSIX-guaranteed fallback
    let innerShell = personalCfg.shell
    if (!innerShell) innerShell = "/bin/bash"
    // `script -qfc "<shell> -i" /dev/null` gives the inner shell a fresh
    // controlling tty so prompt + job control work cleanly.
    const innerCmd = `script -qfc "${innerShell} -i" /dev/null`

    // Fish (and other interactive shells) want XDG_DATA_HOME / XDG_RUNTIME_DIR
    // to be writable. /tmp is bound shared with host inside the container at
    // the same path, so we can safely mkdir paths here that the container
    // will see at the same location.
    const fishHome = `/tmp/loopat-fish-${loopId}`
    const fishData = join(fishHome, "data")
    const fishRuntime = join(fishHome, "runtime")
    await mkdir(fishData, { recursive: true })
    await mkdir(fishRuntime, { recursive: true })
    await chmod(fishRuntime, 0o700).catch(() => {})

    await ensureContainer({
      loopId,
      createdBy: driver,
      vaultName: meta.config?.vault,
      knowledgeRw: meta.config?.knowledge_rw,
      mountAllLoops: meta.config?.mount_all_loops,
      extraEnv: personalCfg.vaultEnvs,
    })
    markActive(loopId, "pty")

    const podmanArgs = buildPodmanExecArgs({
      loopId,
      command: "/bin/bash",
      args: ["-c", innerCmd],
      env: {
        ...personalCfg.vaultEnvs,
        TERM: "xterm-256color",
        XDG_DATA_HOME: fishData,
        XDG_RUNTIME_DIR: fishRuntime,
      },
      tty: true,
      interactive: true,
      workdir: V_LOOP_WORKDIR(loopId),
    })

    const binary = process.env.LOOPAT_PODMAN_BIN || "podman"
    console.error(`[term:${tag}] spawn ${binary} argc=${podmanArgs.length}`)
    const proc = spawn(binary, podmanArgs, {
      name: "xterm-256color",
      cols: initCols,
      rows: initRows,
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
        try { ws.send(JSON.stringify({ type: "data", data: chunk })) } catch {}
      }
    })
    proc.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        const trailing = t.scrollback.join("").slice(-400)
        console.error(`[term:${tag}] podman exit=${exitCode}; last 400 bytes of pty output:\n${trailing}`)
      }
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
  } catch (e: any) {
    console.error(`[term:${tag}] spawn failed: ${e?.message ?? e}`)
    throw e
  } finally {
    pending.delete(loopId)
  }
}

export async function attachTerm(loopId: string, ws: WSContext, initCols = 80, initRows = 24) {
  const t = await getOrSpawn(loopId, initCols, initRows)
  // Don't replay scrollback — accumulated output from SIGWINCH redraws and
  // prior connections causes duplicated prompt text. Instead trigger a
  // fresh screen redraw via ^L (clear-screen in readline). The PTY is
  // already at the correct size from initCols/initRows.
  t.subscribers.add(ws)
  t.proc.write("\x0c")
}

export function detachTerm(loopId: string, ws: WSContext) {
  const t = terms.get(loopId)
  if (!t) return
  t.subscribers.delete(ws)
  if (t.subscribers.size === 0) {
    try { t.proc.kill() } catch {}
    terms.delete(loopId)
    markInactive(loopId, "pty")
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
  try { t.proc.resize(cols, rows) } catch {}
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
  markInactive(loopId, "pty")
}
