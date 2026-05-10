import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const LOOPAT_HOME = process.env.LOOPAT_HOME ?? join(homedir(), ".loopat")

// loopat code install dir (contains node_modules/, helper binaries the sandbox needs)
// Computed from this file's path: server/src/paths.ts → loop/
const __DIRNAME = dirname(fileURLToPath(import.meta.url))
export const LOOPAT_INSTALL_DIR = resolve(__DIRNAME, "../..")

// Hardcoded for now; future = subdomain-routed multi-workspace.
export const WORKSPACE = "1001"
export const ME = "simpx"

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
