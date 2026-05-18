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
export const loopContextRepos = (id: string) => join(loopContextDir(id), "repos")
export const loopContextChatDir = (id: string) => join(loopContextDir(id), "chat")
export const loopMetaPath = (id: string) => join(loopDir(id), "meta.json")
export const loopHistoryPath = (id: string) => join(loopDir(id), "messages.jsonl")
export const loopChatHistoryPath = (id: string) => join(loopDir(id), "chat_history.jsonl")

export const chatDbPath = () => join(LOOPAT_HOME, "chat.db")

export const personalMemoryDir = (user: string) => join(personalDir(user), "memory")
export const workspaceMemoryDir = () => join(workspaceNotesDir(), "memory")
// `.loopat/` is a reserved namespace under knowledge — slots for workspace Claude
// supplements (skills, optional workspace CLAUDE.md). Everything else under
// knowledge/ is plain workspace-owned docs.
export const workspaceLoopatReservedDir = () => join(workspaceKnowledgeDir(), ".loopat")
export const workspaceLoopatClaudeDir = () => join(workspaceLoopatReservedDir(), "claude")
// Optional. If present, appended after the bundled platform doctrine.
export const workspaceClaudePath = () => join(workspaceLoopatClaudeDir(), "CLAUDE.md")
export const workspaceLoopatSkillsDir = () => join(workspaceLoopatClaudeDir(), "skills")
// Workspace plugins (admin-managed, lives under knowledge/.loopat/plugins/).
// Sibling of claude/ — plugins are namespaced (loaded by CC via plugin manifest)
// whereas claude/skills/ are flat user-tier skills (composed by loopat).
export const workspaceLoopatPluginsDir = () => join(workspaceLoopatReservedDir(), "plugins")
// Workspace-shared Claude Code config (mcpServers, future: hooks, ...).
// Shape mirrors `.claude.json`. Workspace-versioned in knowledge repo.
export const workspaceClaudeJsonPath = () => join(workspaceLoopatClaudeDir(), "claude.json")
// Workspace sandbox catalog: each sandbox is a SUBDIRECTORY containing a
// `mise.toml` (the runtime declaration mise reads) and optional `mise.lock`
// (version pinning). mise's lockfile generation requires cwd-based config
// discovery + `mise.toml` naming, which is why each sandbox is its own dir
// rather than a flat `<name>.toml` file. The dir also leaves room for future
// siblings like `mcp.json` / `AGENTS.md`. Personal sandboxes come later.
export const workspaceLoopatSandboxesDir = () => join(workspaceLoopatReservedDir(), "sandboxes")
export const workspaceLoopatSandboxDir = (name: string) =>
  join(workspaceLoopatSandboxesDir(), name)
export const workspaceLoopatSandboxPath = (name: string) =>
  join(workspaceLoopatSandboxDir(name), "mise.toml")
export const workspaceLoopatSandboxLockPath = (name: string) =>
  join(workspaceLoopatSandboxDir(name), "mise.lock")
// sandbox.json holds loopat-side metadata (shell etc.) — kept separate from
// mise.toml so neither tool's file mixes concepts from the other.
export const workspaceLoopatSandboxMetaPath = (name: string) =>
  join(workspaceLoopatSandboxDir(name), "sandbox.json")

// Per-loop sandbox snapshot: copy of catalog sandbox dir. cwd-discovered by mise.
export const loopSandboxDir = (id: string) => join(loopDir(id), "sandbox")
export const loopSandboxPath = (id: string) => join(loopSandboxDir(id), "mise.toml")
export const loopSandboxLockPath = (id: string) => join(loopSandboxDir(id), "mise.lock")
export const loopSandboxMetaPath = (id: string) => join(loopSandboxDir(id), "sandbox.json")
// Bundled platform doctrine — ships with loopat code, always present.
export const bundledDoctrinePath = () => join(TEMPLATES_DIR, "CLAUDE.md")

// Builtin plugins (ship with loopat install). Composed into every loop's
// plugin cache as the lowest-priority tier — workspace and personal plugins
// can shadow them by name. See server/src/compose.ts.
export const builtinPluginsDir = () => join(TEMPLATES_DIR, "plugins")

// Personal `.loopat/` reserved namespace: per-user loopat config + vaults.
// Mirrors `knowledge/.loopat/` as the personal counterpart.
//
// Vault model: each loop selects one vault (default = "default"). The selected
// vault's contents are mounted into the sandbox at
// `/loopat/context/personal/.loopat/vault/` (singular — one active vault per
// loop). Other vaults on the host are hidden inside the sandbox.
export const personalLoopatDir = (user: string) => join(personalDir(user), ".loopat")
export const personalLoopatConfigPath = (user: string) => join(personalLoopatDir(user), "config.json")
export const personalVaultsDir = (user: string) => join(personalLoopatDir(user), "vaults")
/** Per-(user, vault) MCP OAuth token store. Inside the vault so it's covered
 *  by git-crypt — content is per-active-vault, never seen across vaults. */
export const personalMcpTokensPath = (user: string, vault: string) =>
  join(personalVaultsDir(user), vault, "mcp-tokens.json")
// Personal claude/ namespace: mirrors knowledge/.loopat/claude/ for per-user
// supplements. skills/ here become user-tier skills composed in.
export const personalLoopatClaudeDir = (user: string) => join(personalLoopatDir(user), "claude")
export const personalLoopatSkillsDir = (user: string) => join(personalLoopatClaudeDir(user), "skills")
// Personal plugins (sibling of claude/), per-user namespaced.
export const personalLoopatPluginsDir = (user: string) => join(personalLoopatDir(user), "plugins")
// Composed output inside each loop's .claude/. Regenerated every spawn.
export const loopComposedSkillsDir = (id: string) => join(loopDir(id), ".claude", "skills")
export const loopComposedPluginsCacheDir = (id: string) => join(loopDir(id), ".claude", "plugins", "cache")
export const personalVaultDir = (user: string, vault: string) => join(personalVaultsDir(user), vault)
/** Sandbox-internal path where the active vault's contents land. */
export const sandboxVaultMountPoint = () => "/loopat/context/personal/.loopat/vault"
/** Provider apiKey file inside a specific vault. */
export const personalProviderKeyPath = (user: string, vault: string, providerName: string) =>
  join(personalVaultDir(user, vault), "provider-keys", providerName)

// Host-only per-user state: deploy key (loopat → personal repo) and git-crypt
// key (decrypts secrets/ inside the cloned personal repo). Kept OUTSIDE
// personal/<user>/ so it never appears in the sandbox bind view. The user
// can't see these from inside their loop's terminal / file browser.
export const hostSecretsDir = (user: string) => join(LOOPAT_HOME, "host-secrets", user)
export const hostDeployKeyPath = (user: string) => join(hostSecretsDir(user), "deploy-key")
export const hostDeployKeyPubPath = (user: string) => join(hostSecretsDir(user), "deploy-key.pub")
export const personalGitCryptKeyPath = (user: string) => join(hostSecretsDir(user), "git-crypt.key")
export const personalTokenUsagePath = (user: string) => join(personalLoopatDir(user), "token-usage.json")
export const workspaceSecretsDir = () => join(workspaceDir(), "secrets")
