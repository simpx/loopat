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

export interface GitHostProvider {
  readonly id: string
  readonly label: string

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
