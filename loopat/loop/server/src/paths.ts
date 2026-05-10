import { homedir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const LOOPAT_HOME = process.env.LOOPAT_HOME ?? join(homedir(), ".loopat")

// loopat code install dir (contains node_modules/, helper binaries the sandbox needs)
// Computed from this file's path: server/src/paths.ts → loop/
const __DIRNAME = dirname(fileURLToPath(import.meta.url))
export const LOOPAT_INSTALL_DIR = resolve(__DIRNAME, "../..")
export const TEMPLATES_DIR = join(LOOPAT_INSTALL_DIR, "server", "templates")

// Workspace + user are env-overridable so a fresh machine "just works":
//   LOOPAT_WORKSPACE=foo LOOPAT_USER=alice bun run dev
// otherwise: WORKSPACE defaults to "1001", ME defaults to $USER (OS account).
export const WORKSPACE = process.env.LOOPAT_WORKSPACE ?? "1001"
export const ME = process.env.LOOPAT_USER ?? process.env.USER ?? userInfo().username ?? "user"

export const workspaceDir = () => join(LOOPAT_HOME, WORKSPACE)
export const loopsDir = () => join(workspaceDir(), "loops")
export const workspaceContextDir = () => join(workspaceDir(), "context")
export const workspaceKnowledgeDir = () => join(workspaceContextDir(), "knowledge")
export const workspaceNotesDir = () => join(workspaceContextDir(), "notes")
export const workspaceReposDir = () => join(workspaceContextDir(), "repos")
export const workspaceRepoDir = (name: string) => join(workspaceReposDir(), name)
export const personalDir = (user: string) => join(workspaceDir(), "personal", user)

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
export const workspaceDoctrinePath = () => join(workspaceDir(), "CLAUDE.md")
