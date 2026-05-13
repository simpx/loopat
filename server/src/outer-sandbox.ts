/**
 * Outer sandbox: build bwrap argv that wraps a single command (e.g. claude
 * CLI driver, or interactive bash for PTY) inside a virtualized fs view.
 *
 * Key decisions:
 *   - Single layer (this is the only sandbox; SDK's internal sandbox-runtime
 *     is disabled for CLI; PTY also goes through here)
 *   - Virtual paths Claude / user sees (all under /loopat/):
 *       /loopat/loop/<id>/workdir/    ← workdir (rw)
 *       /loopat/loop/<id>/.claude/    ← SDK CLAUDE_CONFIG_DIR (rw)
 *       /loopat/context/knowledge/    ← team docs (ro)
 *       /loopat/context/notes/        ← team prose (rw)
 *       /loopat/context/personal/     ← driver private (rw, memory/ + .loopat/{config.json,secrets/})
 *       /loopat/context/repos/<name>/ ← workspace repos (rw; commits go via workdir worktree)
 *   - $HOME (/home/$USER) is tmpfs; personal-dep symlink targets are re-bound
 *     to their real paths under $HOME so tools like ssh find $HOME/.ssh
 *   - Workspace repos are ALSO re-bound at their host absolute path because
 *     git worktrees store absolute gitdir paths. The virtual path is what the
 *     AI / user references; git internals follow the host path.
 *   - Network is not unshared (host network shared); API calls work directly
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  loopWorkdir,
  loopClaudeDir,
  workspaceKnowledgeDir,
  workspaceLoopatSkillsDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceTeamClaudePath,
  personalDir,
  LOOPAT_INSTALL_DIR,
} from "./paths"
import { resolvePersonalDeps } from "./personal-deps"
import { loadPersonalConfig } from "./config"

function expandHostPath(p: string, home: string): string {
  let s = p
  if (s === "~") s = home
  else if (s.startsWith("~/")) s = home + s.slice(1)
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => process.env[name] ?? "")
}

export const V_LOOP = (id: string) => `/loopat/loop/${id}`
export const V_LOOP_WORKDIR = (id: string) => `/loopat/loop/${id}/workdir`
export const V_LOOP_CLAUDE = (id: string) => `/loopat/loop/${id}/.claude`
export const V_LOOP_CLAUDE_SKILLS = (id: string) => `/loopat/loop/${id}/.claude/skills`
export const V_CONTEXT_KNOWLEDGE = "/loopat/context/knowledge"
export const V_CONTEXT_NOTES = "/loopat/context/notes"
export const V_CONTEXT_NOTES_MEMORY = "/loopat/context/notes/memory"
export const V_CONTEXT_PERSONAL = "/loopat/context/personal"
export const V_CONTEXT_PERSONAL_MEMORY = "/loopat/context/personal/memory"
export const V_CONTEXT_REPOS = "/loopat/context/repos"

export type SandboxExtraEnv = Record<string, string>

/**
 * Build bwrap argv list. Caller appends `[, "--", cmd, ...args]` and spawns.
 */
export async function buildOuterBwrapArgs(
  loopId: string,
  createdBy: string,
  extraSetenv: SandboxExtraEnv = {},
): Promise<string[]> {
  const home = homedir()
  const personalDeps = await resolvePersonalDeps(createdBy)

  // Per-component ro-binds (NOT `--ro-bind / /`) — RO root prevents bwrap from
  // mkdir'ing virtual paths like /loop. With selective binds, the sandbox
  // root is a fresh tmpfs that bwrap can populate freely.
  const SYSTEM_RO = ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/var", "/run"]
  const args: string[] = ["--new-session", "--die-with-parent"]
  for (const p of SYSTEM_RO) {
    // some paths may not exist on every distro — use --ro-bind-try
    args.push("--ro-bind-try", p, p)
  }
  args.push(
    // /tmp shared (writable, for socat / mktemp / IPC sockets)
    "--bind", "/tmp", "/tmp",
    // host home: tmpfs; personal-dep targets bound back below
    "--tmpfs", home,
    // virtual mount points: bind directly. bwrap auto-creates parents.
    "--bind", loopWorkdir(loopId), V_LOOP_WORKDIR(loopId),
    "--bind", loopClaudeDir(loopId), V_LOOP_CLAUDE(loopId),
    "--ro-bind", workspaceKnowledgeDir(), V_CONTEXT_KNOWLEDGE,
    "--bind", workspaceNotesDir(), V_CONTEXT_NOTES,
    "--bind", personalDir(createdBy), V_CONTEXT_PERSONAL,
    // loopat install dir (claude binary lives here)
    "--ro-bind", LOOPAT_INSTALL_DIR, LOOPAT_INSTALL_DIR,
  )

  // team skills: nested ro-bind over .claude/ so Claude Code discovers them
  // as user-tier skills (CLAUDE_CONFIG_DIR/skills). Only mount if populated.
  const skillsSrc = workspaceLoopatSkillsDir()
  if (existsSync(skillsSrc)) {
    args.push("--ro-bind", skillsSrc, V_LOOP_CLAUDE_SKILLS(loopId))
  }

  // team CLAUDE.md supplement: bind to CLAUDE_CONFIG_DIR/CLAUDE.md so Claude
  // Code natively loads it as user-tier (settingSources includes "user").
  // The platform doctrine (L2) is still injected via systemPrompt.append.
  const teamClaudeMd = workspaceTeamClaudePath()
  if (existsSync(teamClaudeMd)) {
    args.push("--ro-bind", teamClaudeMd, join(V_LOOP_CLAUDE(loopId), "CLAUDE.md"))
  }

  // Claude Code's OAuth credentials for MCP servers (coop / yuque / aone-* …)
  // live at `~/.claude/.credentials.json` on the host. ro-bind into the
  // sandbox's CLAUDE_CONFIG_DIR so MCPs that use OAuth flow reuse the host
  // driver's tokens. Refresh-on-expiry will fail (ro), needs separate flow.
  const credsSrc = join(home, ".claude", ".credentials.json")
  if (existsSync(credsSrc)) {
    args.push("--ro-bind", credsSrc, join(V_LOOP_CLAUDE(loopId), ".credentials.json"))
  }

  // repos: bind at the virtual path (for AI / user) AND re-bind at the host
  // absolute path (for git internals — worktree `.git` files store absolute
  // gitdir paths). Same source, two paths. Rw because git writes
  // HEAD/index/logs in the main repo for each worktree.
  const reposDir = workspaceReposDir()
  if (existsSync(reposDir)) {
    args.push("--bind", reposDir, V_CONTEXT_REPOS)
    args.push("--bind", reposDir, reposDir)
  }

  args.push(
    // proc, dev, pid namespace
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    // cwd = workdir (the worktree); sibling .claude/ holds SDK state
    "--chdir", V_LOOP_WORKDIR(loopId),
    "--setenv", "PWD", V_LOOP_WORKDIR(loopId),
  )

  // re-bind personal-dep targets so e.g. /home/<user>/.ssh works for ssh client.
  // User-owned ssh keys (push to git, ssh to jumpboxes) live encrypted under
  // personal/<user>/.loopat/secrets/.ssh/ and reach $HOME/.ssh inside the
  // sandbox via a personal-deps symlink the user sets up themselves.
  // Loopat's deploy key (host-secrets/<user>/deploy-key) is NEVER bound here —
  // it's loopat-the-platform's clone credential, not for sandbox use.
  for (const target of personalDeps) {
    args.push("--bind", target, target)
  }

  // user-declared host -> sandbox mounts (personal/<user>/.loopat/config.json sandbox.mounts)
  const personalCfg = await loadPersonalConfig(createdBy)
  const sandboxCfg = personalCfg.sandbox ?? {}
  for (const m of sandboxCfg.mounts ?? []) {
    const src = expandHostPath(m.src, home)
    const dst = expandHostPath(m.dst ?? m.src, home)
    args.push(m.rw ? "--bind-try" : "--ro-bind-try", src, dst)
  }

  // PATH prepend (sandbox.path) — server's PATH is inherited by default; this
  // adds dirs to the front so binaries in e.g. ~/.local/bin are found without
  // sourcing a shell rc.
  if (sandboxCfg.path?.length) {
    const dirs = sandboxCfg.path.map((p) => expandHostPath(p, home)).join(":")
    const cur = process.env.PATH ?? ""
    args.push("--setenv", "PATH", cur ? `${dirs}:${cur}` : dirs)
  }

  for (const [k, v] of Object.entries(extraSetenv)) {
    args.push("--setenv", k, v)
  }

  return args
}
