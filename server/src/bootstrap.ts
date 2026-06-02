/**
 * Boot-time pre-flight: verify the host has what loopat needs (podman, claude
 * binary, apiKey) and print a checklist. Doesn't exit on failure — UI still
 * works, just chat won't function until the user fills in what's missing.
 */
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { resolveSandboxClaudeBinary } from "./claude-binary"
import { configPath, loadKnowledgeConfig, type WorkspaceConfig } from "./config"
import {
  WORKSPACE,
  usersPath,
  workspaceDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceTeamClaudeMdPath,
} from "./paths"
import { listUsers } from "./auth"

type Check = { ok: boolean; label: string; hint?: string }

/** The host to print in the "open …" url. HOST=0.0.0.0/:: means "all
 *  interfaces" — localhost works locally but isn't reachable from other
 *  machines, so resolve a real LAN ip instead. */
function accessHost(): string {
  const h = process.env.HOST
  if (!h || h === "127.0.0.1" || h === "localhost") return "localhost"
  if (h !== "0.0.0.0" && h !== "::") return h
  try {
    const ip = execFileSync(
      "sh", ["-c", "ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' || ipconfig getifaddr en0 2>/dev/null"],
      { stdio: "pipe" },
    ).toString().trim()
    return ip || "localhost"
  } catch { return "localhost" }
}

function checkPodman(): Check {
  const isMac = process.platform === "darwin"
  let version: string
  try {
    version = execFileSync("podman", ["--version"], { stdio: "pipe" }).toString().trim()
  } catch {
    return {
      ok: false,
      label: "podman (sandbox)",
      hint: isMac
        ? "brew install podman, then: podman machine init && podman machine start"
        : "sudo apt install podman uidmap fuse-overlayfs   (Linux)",
    }
  }
  // On macOS podman runs inside a Linux VM ("machine"). `--version` succeeds even
  // when the machine is stopped — `podman info` is what actually needs the VM up.
  if (isMac) {
    try {
      execFileSync("podman", ["info"], { stdio: "pipe", timeout: 8000 })
    } catch {
      return {
        ok: false,
        label: `podman (sandbox): ${version}`,
        hint: "podman machine isn't running — start it: podman machine start   (run `podman machine init` first if you never have)",
      }
    }
  }
  return { ok: true, label: `podman (sandbox): ${version}` }
}

function checkClaudeBinary(): Check {
  // The AI runs in the linux sandbox, so what matters is the SANDBOX claude.
  try {
    const p = resolveSandboxClaudeBinary()
    const tag = process.platform === "linux" ? "" : " [linux, for sandbox]"
    return { ok: true, label: `claude binary${tag} (${p.split("/").slice(-3).join("/")})` }
  } catch {
    return {
      ok: false,
      label: "claude binary (sandbox/linux)",
      hint:
        process.platform === "linux"
          ? "run `bun install` in the loopat repo root — SDK ships the binary as a platform-specific package"
          : "the linux claude for the sandbox wasn't fetched (postinstall). Reinstall loopat, or run the `npm install --os=linux ...` command from the resolve error",
    }
  }
}

function checkGitCrypt(): Check {
  try {
    const out = execFileSync("git-crypt", ["--version"], { stdio: "pipe" }).toString().trim()
    return { ok: true, label: `git-crypt (personal vault): ${out}` }
  } catch {
    return {
      ok: false,
      label: "git-crypt (personal vault)",
      hint: process.platform === "darwin"
        ? "brew install git-crypt   (encrypts your personal vault)"
        : "sudo apt install git-crypt   (encrypts your personal vault)",
    }
  }
}


function describeRemote(dir: string, url: string | undefined): string {
  if (!existsSync(dir)) return "missing"
  const isRepo = existsSync(join(dir, ".git"))
  if (url && isRepo) return url
  if (url && !isRepo) return `${url}  (clone failed → local-only)`
  return "local-only (no remote)"
}

async function checkUsers(): Promise<Check> {
  const path = usersPath()
  if (!existsSync(path)) {
    return { ok: true, label: `users:     (none yet — register on first visit)` }
  }
  try {
    const users = await listUsers()
    const ids = users.map((u) => u.id).join(", ") || "(empty)"
    return { ok: true, label: `users:     ${users.length} (${ids})` }
  } catch (e: any) {
    return { ok: false, label: `users:     <unreadable>`, hint: `${path}: ${e?.message ?? e}` }
  }
}

export async function printBootstrapBanner(cfg: WorkspaceConfig) {
  // notes is declared inside the knowledge repo's .loopat/config.json. The repo
  // roster is per-user (personal config), so the workspace banner can't list it.
  const kcfg = await loadKnowledgeConfig()
  const checks: Check[] = [
    { ok: true, label: `workspace: ${workspaceDir()}` },
    { ok: true, label: `team .claude/CLAUDE.md (${existsSync(workspaceTeamClaudeMdPath()) ? "present" : "absent"})` },
    { ok: existsSync(workspaceKnowledgeDir()), label: `knowledge: ${describeRemote(workspaceKnowledgeDir(), cfg.knowledge?.git || undefined)}` },
    { ok: existsSync(workspaceNotesDir()), label: `notes:     ${describeRemote(workspaceNotesDir(), kcfg.notes?.git || undefined)}` },
    { ok: true, label: `repos:     (per-user, in personal config)` },
    await checkUsers(),
    { ok: existsSync(configPath()), label: `config: ${configPath()}` },
    checkPodman(),
    checkClaudeBinary(),
    checkGitCrypt(),
  ]

  // Colorize only on a TTY (not when piped/redirected) and unless NO_COLOR is set.
  const color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const green = wrap("32"), red = wrap("31"), yellow = wrap("33"), dim = wrap("2"), bold = wrap("1"), cyan = wrap("36")

  const bar = dim("─".repeat(60))
  console.log(`\n${bar}`)
  console.log(`  ${bold(cyan(`loopat bootstrap`))} ${dim("—")} ${bold(WORKSPACE)}`)
  console.log(bar)
  for (const c of checks) {
    const mark = c.ok ? green("✓") : red("✗")
    console.log(`  ${mark}  ${c.ok ? c.label : bold(c.label)}`)
    if (!c.ok && c.hint) console.log(`     ${yellow("→ " + c.hint)}`)
  }
  console.log(bar)
  const blockers = checks.filter((c) => !c.ok)
  if (blockers.length > 0) {
    console.log(`  ${yellow(`${blockers.length} thing(s) to fix`)} before chat will work — see hints above.\n`)
    return false
  }
  // NB: the "ready. open …" line is intentionally NOT printed here. The banner
  // runs up front (so dependency checks are visible immediately), but the port
  // isn't listening yet and the sandbox base image may still be pulling. The
  // caller prints printReadyLine() only after the port is actually open and the
  // image is prepared — otherwise we'd claim readiness mid-boot.
  console.log("")
  return true
}

/** The "ready. open <url>" line — printed by the boot sequence AFTER the port
 *  is listening and the sandbox image is ready (see printBootstrapBanner). */
export function printReadyLine() {
  const color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const green = wrap("32"), cyan = wrap("36")
  console.log(`  ${green("ready.")} open ${cyan(`http://${accessHost()}:${process.env.PORT ?? 10001}`)}\n`)
}
