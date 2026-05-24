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
// (Old `workspaceLoopat{Reserved,Claude,Skills,Agents,Sandbox*}` helpers
// deleted — superseded by the tiered .claude/ model. Workspace CC config now
// lives at `<knowledge>/.loopat/.claude/` and is accessed via
// `workspaceTeamClaudeDir/SettingsPath/ClaudeMdPath/SkillsDir/AgentsDir` below.)

// Per-loop $HOME overlay (docker container layer for home). The sandbox's
// $HOME is an overlayfs mount: lower = workspaceHomeSkelDir (shared skeleton,
// typically empty), upper = home-upper (per-loop persistent diff), work =
// home-work (overlayfs internal scratch). merged is the mount point that
// bwrap binds into the sandbox at $HOME. Persists across loop restarts; AI's
// pip/npm installs and shell history survive.
export const loopHomeUpper = (id: string) => join(loopDir(id), "home-upper")
export const loopHomeWork = (id: string) => join(loopDir(id), "home-work")
export const loopHomeMerged = (id: string) => join(loopDir(id), "home-merged")
// Workspace-shared base layer for the home overlay. User can drop default
// dotfiles in here; left empty by default.
export const workspaceHomeSkelDir = () => join(LOOPAT_HOME, "sandbox-home-skel")
// Bundled platform doctrine — ships with loopat code, always present.
export const bundledDoctrinePath = () => join(TEMPLATES_DIR, "CLAUDE.md")

// Per-loop-kind templates (distill, future: review, plan, etc.). Each kind
// has its own dir; createLoop / distillLoop copies the kind's CLAUDE.md into
// the new loop's workdir as the L2++ project-tier doctrine.
export const loopKindTemplateDir = (kind: string) => join(TEMPLATES_DIR, "loop-kinds", kind)
export const loopKindClaudePath = (kind: string) => join(loopKindTemplateDir(kind), "CLAUDE.md")

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
// Personal `.claude/` — CC-native shape, mirrors `~/.claude/`. The 4th layer
// in loopat's tiered .claude merge (workspace + profiles + personal + repo).
// Contains: settings.json, CLAUDE.md, skills/, agents/.
export const personalClaudeDir = (user: string) => join(personalDir(user), ".claude")
export const personalClaudeMdPath = (user: string) => join(personalClaudeDir(user), "CLAUDE.md")
export const personalSettingsPath = (user: string) => join(personalClaudeDir(user), "settings.json")
export const personalSkillsDir = (user: string) => join(personalClaudeDir(user), "skills")
export const personalAgentsDir = (user: string) => join(personalClaudeDir(user), "agents")
// Composed output inside each loop's .claude/. Regenerated every spawn.
// Plugin loading does NOT touch the loop's .claude/ — SDK loads plugins via
// its `plugins` option (resolved from server cache; see plugin-installer.ts).
export const loopComposedSkillsDir = (id: string) => join(loopDir(id), ".claude", "skills")
export const loopComposedAgentsDir = (id: string) => join(loopDir(id), ".claude", "agents")

// Platform-shipped builtin plugins live under server/templates/plugins/<name>/.
// They're always loaded into every loop (plugin-installer.ts:resolveBuiltinPlugins).
// No marketplace wrapper — direct path injection via SDK plugins option.
export const personalVaultDir = (user: string, vault: string) => join(personalVaultsDir(user), vault)
/** Sandbox-internal path: symlink to the active vault's real dir under
 *  personal/.loopat/vaults/<active>/. AI is taught to use this entrypoint. */
export const sandboxVaultMountPoint = () => "/loopat/context/vault"
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

// ─── Profile composition model (post-2026-05 design, CC-native refactor) ─
//
// See docs/composition.md. The team workspace lives inside the
// knowledge git repo at `.loopat/`, structured as a stack of CC-native
// `.claude/` directories — one per tier (team / profile). loopat materializes
// a merge of selected tiers into each loop's `.claude/`.
//
//   knowledge/.loopat/
//     .claude/                                ← team-tier CC config
//       settings.json (enabledPlugins, extraKnownMarketplaces)
//       CLAUDE.md, skills/, agents/
//     profiles/<name>/.claude/                ← profile-tier CC config
//       settings.json, CLAUDE.md, skills/, agents/
//     marketplace/                            ← team's local CC marketplace
//       .claude-plugin/marketplace.json
//       <plugin>/...
//
// No loopat-invented schema (profile.json gone). Admins use CC's own
// commands (`claude plugin install --scope=project` etc.) inside these
// dirs to edit team / profile configuration.
export const workspaceLoopatRoot = () => join(workspaceKnowledgeDir(), ".loopat")

// Team-tier .claude/ — analogous to ~/.claude/ but shared across team via git.
export const workspaceTeamClaudeDir = () => join(workspaceLoopatRoot(), ".claude")
export const workspaceTeamSettingsPath = () => join(workspaceTeamClaudeDir(), "settings.json")
export const workspaceTeamClaudeMdPath = () => join(workspaceTeamClaudeDir(), "CLAUDE.md")
export const workspaceTeamSkillsDir = () => join(workspaceTeamClaudeDir(), "skills")
export const workspaceTeamAgentsDir = () => join(workspaceTeamClaudeDir(), "agents")

// Profiles — each is a dir with a `.claude/` subdir (CC project-tier shape).
export const workspaceProfilesDir = () => join(workspaceLoopatRoot(), "profiles")
export const workspaceProfileDir = (name: string) => join(workspaceProfilesDir(), name)
export const workspaceProfileClaudeDir = (name: string) =>
  join(workspaceProfileDir(name), ".claude")
export const workspaceProfileSettingsPath = (name: string) =>
  join(workspaceProfileClaudeDir(name), "settings.json")
export const workspaceProfileClaudeMdPath = (name: string) =>
  join(workspaceProfileClaudeDir(name), "CLAUDE.md")
export const workspaceProfileSkillsDir = (name: string) =>
  join(workspaceProfileClaudeDir(name), "skills")
export const workspaceProfileAgentsDir = (name: string) =>
  join(workspaceProfileClaudeDir(name), "agents")

// (Marketplace location is NOT a loopat convention. Teams choose where to
// host private plugins — typically `<knowledge>/marketplace/` — and declare
// it via `extraKnownMarketplaces` in their team `.claude/settings.json`.
// loopat just registers whatever's declared; it doesn't probe fixed paths.)
