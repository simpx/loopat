import { spawn, type IPty } from "bun-pty"
import type { WSContext } from "hono/ws"
import { mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"
import { resolveSandboxBinary } from "./sandbox-binary"
import { buildBwrapArgs } from "./bwrap"
import { getLoop } from "./loops"
import { loadPersonalConfig } from "./config"
import { readSandboxMeta, readSandboxMetaFromPath } from "./sandboxes"
import { loopDir, loopWorkdir, loopSandboxMetaPath } from "./paths"

const isWin = process.platform === "win32"
const isMac = process.platform === "darwin"

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

  const tag = loopId.slice(0, 8)
  const p = (async () => {
    const meta = await getLoop(loopId)
    if (!meta) throw new Error(`loop ${loopId} not found`)
    const personalCfg = await loadPersonalConfig(meta.createdBy, meta.config?.vault)
    // Shell resolution (highest precedence first):
    //   1. personal config `shell` — user's per-user override
    //   2. sandbox.json `shell` — sandbox author's choice (prefer loop snapshot
    //      copy, fall back to catalog if no snapshot)
    //   3. /bin/bash (POSIX) / cmd.exe (Windows) — platform-appropriate fallback
    let innerShell = personalCfg.shell
    if (!innerShell && meta.config?.sandbox) {
      const snapshotMeta = await readSandboxMetaFromPath(loopSandboxMetaPath(loopId))
      const sandboxMeta = snapshotMeta ?? await readSandboxMeta(meta.config.sandbox)
      if (sandboxMeta?.shell) innerShell = sandboxMeta.shell
    }
    if (!innerShell) innerShell = isWin ? "cmd.exe" : "/bin/bash"

    const sandboxBin = resolveSandboxBinary()
    let bwrapArgs: string[]
    let fullArgs: string[]

    // Ensure workdir exists before sandbox tries to bind it
    await mkdir(loopWorkdir(loopId), { recursive: true })

    if (isWin) {
      // Windows: sandbox is a pass-through; strip bwrap-only ops, keep
      // chdir/setenv. No outer bash -c wrapper, no script(1) — none exist.
      bwrapArgs = await buildBwrapArgs(loopId, meta.createdBy, {
        ...(personalCfg.envs ?? {}),
        TERM: "xterm-256color",
      }, meta.config?.sandbox, meta.config?.vault)
      fullArgs = [...bwrapArgs, "--", innerShell]
    } else {
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
      // Ensure workdir exists before sandbox binds it
      await mkdir(loopWorkdir(loopId), { recursive: true })

      bwrapArgs = await buildBwrapArgs(loopId, meta.createdBy, {
        ...(personalCfg.envs ?? {}),
        TERM: "xterm-256color",
        XDG_DATA_HOME: fishData,
        XDG_RUNTIME_DIR: fishRuntime,
      }, meta.config?.sandbox, meta.config?.vault)
      if (isMac) {
        // bun-pty already gives loopat-sandbox a controlling PTY on macOS.
        // Avoid nesting BSD script(1) inside the sandbox: it creates another
        // PTY via /dev/pty* and can be killed by the SBPL profile before the
        // user shell starts.
        fullArgs = [...bwrapArgs, "--", innerShell, "-i"]
      } else {
        // Wrap inner shell with `script` so it gets a fresh controlling tty
        // (without this, the bash-in-bash chain strips tty control).
        fullArgs = [...bwrapArgs, "--", "/bin/bash", "-c", `script -qfc "${innerShell} -i" /dev/null`]
      }
    }

    console.error(`[term:${tag}] spawn ${sandboxBin} argc=${fullArgs.length} sandbox=${meta.config?.sandbox ?? "<none>"}`)
    const proc = spawn(sandboxBin, fullArgs, {
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
      // bwrap nonzero exit usually means: argv malformed, bind src missing,
      // inner cmd failed. Surface it in server log + scrollback so the user
      // can debug without grepping. Zero exit = normal shell quit, silent.
      if (exitCode !== 0) {
        const trailing = t.scrollback.join("").slice(-400)
        console.error(`[term:${tag}] bwrap exit=${exitCode}; last 400 bytes of pty output:\n${trailing}`)
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
