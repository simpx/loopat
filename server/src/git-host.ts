/**
 * Git host provider abstraction — docs/identity.md's five-capability contract
 * as a pluggable interface. A GitHostProvider adapts ONE git platform (GitHub,
 * GitLab, an internal host, …) onto the five operations loopat needs to onboard
 * a user. loopat core stays platform-agnostic.
 *
 * To add a platform: implement this interface and `registerProvider()` it —
 * see server/src/providers.ts (the explicit registry). Nothing in core changes.
 */

export type HostCred = { token: string; baseUrl?: string }
export type RepoRef = { owner: string; name: string }

/**
 * Onboarding is fully implemented by the provider (see GitHostProvider.onboarding).
 * The provider is a state machine: given the current context it either reports
 * `done`, or returns the next FORM to render. loopat knows nothing about the
 * flow — it only renders the generic form and, on submit, runs each field's
 * `action` (the only two primitives it provides).
 */
export type OnboardingField = {
  /** Field key. For action "vault-env" this is ALSO the vault-env name written. */
  name: string
  label: string
  type?: "password" | "text"
  help?: string
  placeholder?: string
  /**
   *  - "vault-env":           store the submitted value in the vault under `name`.
   *  - "personal-repo-token": use the submitted value as the git token to
   *                           provision + import the user's personal repo.
   */
  action: "vault-env" | "personal-repo-token"
}

export type OnboardingForm = {
  title: string
  description?: string
  submitLabel?: string
  /** "all" (default) = every field required; "any" = at least one. */
  require?: "all" | "any"
  fields: OnboardingField[]
}

/**
 * What the provider's onboarding() returns: either done, or the next thing to
 * show. The provider runs its OWN checks (file exists? api/git ok?) and, on
 * failure, returns a remediation for loopat to display:
 *   - "form":  a generic form loopat renders + runs (writes vault env / sets up repo).
 *   - "route": an existing loopat page to send the user to (e.g. the personal-repo
 *              settings page, or an MCP auth page). loopat shows the real page and
 *              re-asks onboarding() once the user is done — the provider's next
 *              check decides whether to advance.
 */
export type OnboardingView =
  | { done: true }
  | {
      done: false
      show:
        | ({ kind: "form" } & OnboardingForm)
        | { kind: "route"; path: string; title?: string; description?: string }
    }

export interface GitHostProvider {
  readonly id: string
  readonly label: string

  /** Optional: where/how the user gets a token, shown in the onboarding token
   *  step. A URL or short hint. Platform-specific, so the provider supplies it
   *  (core stays platform-agnostic). */
  readonly tokenHelp?: string

  /** Optional defaults the provider declares so loopat needs no config.json:
   *  the git host base URL and the default personal-repo name. A request may
   *  still override either; absent both, baseUrl falls back to the provider's
   *  own internal default and defaultRepo to "loopat-personal". */
  readonly baseUrl?: string
  readonly defaultRepo?: string

  /**
   * Optional onboarding, FULLY implemented by the provider. When present, loopat
   * treats onboarding as MANDATORY: until it reports `done`, loop creation is
   * blocked and the UI shows the provider's current form.
   *
   * loopat owns NONE of the flow — it calls onboarding(ctx), renders the
   * returned form, collects the values, runs each field's action, then calls
   * onboarding() again with fresh context, repeating until `done`. The provider
   * decides everything: how many forms, their order, what to ask, when it's
   * complete. A provider without onboarding() imposes no gate.
   */
  onboarding?(ctx: {
    userId: string
    login?: string
    vaultEnvs: Record<string, string>
    config: Record<string, unknown>
    /** Has the user's personal repo been imported yet? */
    personalRepoImported: boolean
    /** Path to the user's personal repo working tree (null until imported), so
     *  the provider can run its own "does this file/dir exist?" checks against
     *  e.g. `${repoDir}/.loopat/...`. The provider may import node:fs itself. */
    repoDir: string | null
  }): Promise<OnboardingView>


  /**
   * How git authenticates clone/push on this platform:
   *  - "ssh-deploy-key": loopat generates an ssh key, the provider registers it
   *    (registerDeployKey), and git uses ssh. (GitHub.)
   *  - "https-token": git uses `https://oauth2:<token>@…`; no key is registered.
   *    (GitLab / internal — one token does API + git.)
   */
  readonly gitAuthMode: "ssh-deploy-key" | "https-token"

  /** ① authenticate — turn a credential into the user's login (+ email for
   *  commit authorship, where the platform enforces a valid address). */
  authenticate(cred: HostCred): Promise<{ login: string; email?: string }>

  /** ② create a private repo in the user's namespace if missing. */
  ensureRepo(
    cred: HostCred,
    name: string,
    opts?: { private?: boolean },
  ): Promise<{ url: string; created: boolean }>

  /** ③ register a deploy key on a repo (only for "ssh-deploy-key" mode). */
  registerDeployKey?(
    cred: HostCred,
    repo: RepoRef,
    title: string,
    pubkey: string,
    readOnly: boolean,
  ): Promise<void>

  /** ④ register an account-level key (only for "ssh-deploy-key" mode). */
  registerUserKey?(cred: HostCred, title: string, pubkey: string): Promise<void>

  /** ⑤ grant a member access to a repo (usually admin-gated). */
  grantAccess(
    cred: HostCred,
    repo: RepoRef,
    login: string,
    level: "read" | "write",
  ): Promise<void>

  /** List the user's repos (names) for an onboarding picker. Optional. */
  listRepos?(cred: HostCred): Promise<{ name: string; path: string }[]>

  /**
   * Optional internal-setup hook. Runs once during personal-repo init, right
   * after `git-crypt init` (so `.gitattributes` already encrypts
   * `.loopat/vaults/**`) and before the scaffold is committed + pushed. Use it
   * to seed default files into the working tree — provider configs, ssh keys,
   * jumpbox configs, … This is where a team bakes its internal defaults.
   *
   * Encryption boundary: files under `.loopat/vaults/**` are git-crypt
   * encrypted; everything else (e.g. `.loopat/config.json`) is committed in
   * PLAINTEXT — so never write real secrets outside the vault (use env-var
   * refs like `"$FOO_API_KEY"` in config.json instead).
   *
   * loopat stages (`git add .loopat memory`), commits and pushes whatever you
   * write. Throwing only logs a warning — setup still succeeds.
   *
   *   ctx.repoDir  — cloned working tree (write paths relative to this)
   *   ctx.vaultDir — `${repoDir}/.loopat/vaults/default` (encrypted)
   *   ctx.userId   — the loopat user being set up
   *   ctx.login    — their login on this platform
   */
  seedDefaults?(ctx: {
    repoDir: string
    vaultDir: string
    userId: string
    login: string
  }): Promise<void>
}

const providers = new Map<string, GitHostProvider>()

export function registerProvider(p: GitHostProvider): void {
  providers.set(p.id, p)
}
export function getProvider(id: string): GitHostProvider | undefined {
  return providers.get(id)
}
export function listProviders(): { id: string; label: string }[] {
  return [...providers.values()].map((p) => ({ id: p.id, label: p.label }))
}
