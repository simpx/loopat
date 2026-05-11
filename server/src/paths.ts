import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * LOOPAT_HOME *is* the workspace directory. Single-workspace by design — to
 * run a second workspace, start a second loopat instance with a different
 * LOOPAT_HOME. Default `~/.loopat`. The display/URL name is the basename
 * with leading dots stripped (so `~/.loopat` → "loopat").
 */
export const LOOPAT_HOME = process.env.LOOPAT_HOME ?? join(homedir(), ".loopat")

// loopat code install dir (contains node_modules/, helper binaries the sandbox needs)
// Computed from this file's path: server/src/paths.ts → loop/
const __DIRNAME = dirname(fileURLToPath(import.meta.url))
export const LOOPAT_INSTALL_DIR = resolve(__DIRNAME, "../..")
export const TEMPLATES_DIR = join(LOOPAT_INSTALL_DIR, "server", "templates")

export const WORKSPACE = basename(LOOPAT_HOME).replace(/^\.+/, "") || "loopat"

export const workspaceDir = () => LOOPAT_HOME
export const usersPath = () => join(LOOPAT_HOME, "users.json")
export const loopsDir = () => join(LOOPAT_HOME, "loops")
export const workspaceContextDir = () => join(LOOPAT_HOME, "context")
export const workspaceKnowledgeDir = () => join(workspaceContextDir(), "knowledge")
export const workspaceNotesDir = () => join(workspaceContextDir(), "notes")
export const workspaceReposDir = () => join(workspaceContextDir(), "repos")
export const workspaceRepoDir = (name: string) => join(workspaceReposDir(), name)
export const personalDir = (user: string) => join(LOOPAT_HOME, "personal", user)

export const loopDir = (id: string) => join(loopsDir(), id)
export const loopWorkdir = (id: string) => join(loopDir(id), "workdir")
export const loopClaudeDir = (id: string) => join(loopDir(id), ".claude")
export const loopContextDir = (id: string) => join(loopDir(id), "context")
export const loopContextKnowledge = (id: string) => join(loopContextDir(id), "knowledge")
export const loopContextNotes = (id: string) => join(loopContextDir(id), "notes")
export const loopContextPersonal = (id: string) => join(loopContextDir(id), "personal")
export const loopMetaPath = (id: string) => join(loopDir(id), "meta.json")
export const loopHistoryPath = (id: string) => join(loopDir(id), "messages.jsonl")

export const personalMemoryDir = (user: string) => join(personalDir(user), "memory")
export const teamMemoryDir = () => join(workspaceNotesDir(), "memory")
// `.loopat/` is a reserved namespace under knowledge — slots for team Claude
// config that supplements the platform doctrine (skills, optional team CLAUDE.md).
// Everything else under knowledge/ is plain team-owned docs.
export const workspaceLoopatReservedDir = () => join(workspaceKnowledgeDir(), ".loopat")
export const workspaceLoopatClaudeDir = () => join(workspaceLoopatReservedDir(), "claude")
// Optional. If present, appended after the bundled platform doctrine.
export const workspaceTeamClaudePath = () => join(workspaceLoopatClaudeDir(), "CLAUDE.md")
export const workspaceLoopatSkillsDir = () => join(workspaceLoopatClaudeDir(), "skills")
// Optional team-shared Claude Code config (mcpServers, future: hooks, ...).
// Shape mirrors `.claude.json`. Workspace-versioned in knowledge repo.
export const workspaceTeamClaudeJsonPath = () => join(workspaceLoopatClaudeDir(), "claude.json")
// Bundled platform doctrine — ships with loopat code, always present.
export const bundledDoctrinePath = () => join(TEMPLATES_DIR, "CLAUDE.md")
