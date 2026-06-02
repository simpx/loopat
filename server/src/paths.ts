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
// Local git hosting: when a context repo has no remote, loopat hosts the
// `origin` itself as a bare repo here (docs/context-flow.md "solo").
export const workspaceOriginsDir = () => join(LOOPAT_HOME, "origins")
export const workspaceOriginPath = (name: string) => join(workspaceOriginsDir(), `${name}.git`)
// External git-host provider extensions (e.g. internal "Code" platform). Drop a
// duck-typed provider file here; loopat loads it without any core change.
export const extensionsProvidersDir = () => join(LOOPAT_HOME, "extensions", "providers")
export const personalDir = (user: string) => join(LOOPAT_HOME, "personal", user)

// Per-user context main repos. knowledge/notes/repos are NOT workspace-shared:
// each user's loop sees ONLY what their personal.knowledge points at (no
// fallback to the workspace default). These are the main repos the loop's
// context worktrees are derived from — the per-user analogue of the shared
// workspaceKnowledgeDir()/workspaceNotesDir(). Live under context/users/<user>/
// so they never collide with the workspace-default context/knowledge.
export const userContextDir = (user: string) => join(workspaceContextDir(), "users", user)
export const personalKnowledgeDir = (user: string) => join(userContextDir(user), "knowledge")
export const personalNotesDir = (user: string) => join(userContextDir(user), "notes")
export const personalReposDir = (user: string) => join(userContextDir(user), "repos")
export const personalRepoDir = (user: string, name: string) => join(personalReposDir(user), name)
// Bare mirror cache for a roster repo — host-only (NOT mounted into the sandbox).
// Cloned once, fetched per new-loop; loop workdirs are `git worktree add`'d off
// it; pushes from those worktrees go straight to origin. Kept OUT of
// personalReposDir so the sandbox's context/repos stays a clean clone-on-demand
// area (just REPOS.md), never a pile of bare repos.
export const personalRepoCacheRoot = (user: string) => join(userContextDir(user), "repo-cache")
export const personalRepoCacheDir = (user: string, name: string) => join(personalRepoCacheRoot(user), name)
// The per-user knowledge repo's .loopat root (holds its config.json = notes +
// repo roster). Workspace-default equivalent is workspaceLoopatRoot().
export const personalKnowledgeLoopatRoot = (user: string) => join(personalKnowledgeDir(user), ".loopat")

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

// UI loop checkouts — a per-user worktree for editing team context (notes) from
// outside any AI loop (a "no-AI UI loop", see docs/context-flow.md). Disposable:
// opened from origin/main, synced back ff-only.
export const uiDir = (user: string) => join(LOOPAT_HOME, "ui", user)
export const uiNotesDir = (user: string) => join(uiDir(user), "notes")
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
// Vault model: each loop selects one vault (default = "default"). The vault is
// NOT exposed to the sandbox as a directory. Instead two filesystem conventions
// inside the vault drive automatic delivery at spawn time:
//   - `vaults/<v>/envs/<NAME>`            → injected as env var $NAME
//   - `vaults/<v>/mounts/home/<rel>/...`  → bound at $HOME/<rel>/...
// AI never sees "vault" as a concept — it just sees a configured machine.
export const personalLoopatDir = (user: string) => join(personalDir(user), ".loopat")
export const personalLoopatConfigPath = (user: string) => join(personalLoopatDir(user), "config.json")
export const personalVaultsDir = (user: string) => join(personalLoopatDir(user), "vaults")
// Personal `.claude/` — CC-native shape. The 4th layer in loopat's tiered
// .claude merge (workspace + profiles + personal + repo). Lives under
// `.loopat/` to mirror the team convention (`knowledge/.loopat/.claude/`):
// loopat-controlled config goes under `.loopat/` so the personal repo's
// other content (memory, scratch files) stays cleanly separate.
// Contains: settings.json, CLAUDE.md, skills/, agents/.
export const personalClaudeDir = (user: string) => join(personalLoopatDir(user), ".claude")
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
/** Convention dir: every file under this dir is auto-injected as an env var
 *  at spawn time. Filename = env var name. content = value (trailing newline
 *  stripped). Subdirs not recursed. */
export const personalVaultEnvsDir = (user: string, vault: string) =>
  join(personalVaultDir(user, vault), "envs")
/** Path to a specific env-var file inside the vault. */
export const personalVaultEnvPath = (user: string, vault: string, name: string) =>
  join(personalVaultEnvsDir(user, vault), name)
/** Convention dir: every top-level entry under this is auto-bound at the
 *  corresponding $HOME-relative path. e.g. `mounts/home/.ssh/` → `$HOME/.ssh/`. */
export const personalVaultMountsHomeDir = (user: string, vault: string) =>
  join(personalVaultDir(user, vault), "mounts", "home")

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

// Per-user equivalents: a loop sources team .claude / profiles from the loop
// creator's PER-USER knowledge repo (context/users/<user>/knowledge), not the
// workspace-default one. Mirrors the per-user notes/repos model.
export const personalKnowledgeTeamClaudeDir = (user: string) =>
  join(personalKnowledgeLoopatRoot(user), ".claude")
export const personalKnowledgeProfilesDir = (user: string) =>
  join(personalKnowledgeLoopatRoot(user), "profiles")
export const personalKnowledgeProfileDir = (user: string, name: string) =>
  join(personalKnowledgeProfilesDir(user), name)
export const personalKnowledgeProfileClaudeDir = (user: string, name: string) =>
  join(personalKnowledgeProfileDir(user, name), ".claude")
export const personalKnowledgeProfileClaudeMdPath = (user: string, name: string) =>
  join(personalKnowledgeProfileClaudeDir(user, name), "CLAUDE.md")
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
