/**
 * e2e scenario #2 — personal permissions: authorization tracks the personal
 * repo, NOT the host.
 *
 * A git-over-ssh server hosts three repos under three ssh accounts
 * (git-kn / git-notes / git-personal), each with its own authorized_keys, so a
 * key can be authorized PER repo. The HOST key is authorized on all three (the
 * host "has permission" — and the startup display-clone uses it). The USER's
 * vault key is authorized in stages to produce three outcomes:
 *
 *   stage 1  empty personal (no vault key)        → kn ✗  personal ✗
 *   stage 2  vault key authorized on kn+notes only → kn ✓  personal ✗
 *   stage 3  vault key authorized on personal too  → kn ✓  personal ✓
 *
 * The process default GIT_SSH_COMMAND is the host key, yet loop work still
 * fails until the VAULT key is authorized — proving a loop never borrows the
 * host's access. "loop work" = the server-side git a loop drives: pull a
 * context repo, push personal. (createLoop itself always succeeds — it just
 * writes metadata; the real success/failure is in reaching the remotes.)
 *
 * Safe + self-contained: throwaway LOOPAT_HOME + container, removed on exit.
 * Requires bun + podman.  Run: bun run scripts/e2e/personal-permissions.ts
 */
const HOME = `/tmp/loopat-e2e-perm-${process.pid}`
process.env.LOOPAT_HOME = HOME

const { execFile } = await import("node:child_process")
const { promisify } = await import("node:util")
const { writeFile, readFile, mkdir, copyFile, chmod, rm } = await import("node:fs/promises")
const { join } = await import("node:path")
const x = promisify(execFile)
const podman = (...a: string[]) => x("podman", a)

const IMAGE = "loopat-gitssh-test"
const CTR = `loopat-e2e-perm-${process.pid}`
const PORT = "2224"
const serverDir = join(import.meta.dir, "git-ssh-server")
const sshUrl = (acct: string) => `ssh://${acct}@127.0.0.1:${PORT}/srv/${acct}/repo.git`
const sshCmd = (key: string) =>
  `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`
const author = ["-c", "user.email=e2e@x", "-c", "user.name=e2e"]

let ctrUp = false
async function cleanup() {
  if (ctrUp) await podman("rm", "-f", CTR).catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

async function authorize(acct: string, pub: string) {
  await podman("exec", CTR, "sh", "-c", `echo '${pub}' >> /home/${acct}/.ssh/authorized_keys`)
}

async function main(): Promise<boolean> {
  await podman("build", "-q", "-t", IMAGE, serverDir)
  await mkdir(HOME, { recursive: true })

  // two keypairs: the host's, and the user's (vault) key.
  const hostKey = join(HOME, "host"), vaultKey = join(HOME, "vault")
  await x("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", hostKey, "-q", "-C", "host"])
  await x("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", vaultKey, "-q", "-C", "vault"])
  const hostPub = (await readFile(hostKey + ".pub", "utf8")).trim()
  const vaultPub = (await readFile(vaultKey + ".pub", "utf8")).trim()
  const hostEnv = { ...process.env, GIT_SSH_COMMAND: sshCmd(hostKey) }

  await podman("rm", "-f", CTR).catch(() => {})
  await podman("run", "-d", "--name", CTR, "-p", `${PORT}:22`, IMAGE)
  ctrUp = true
  await new Promise((r) => setTimeout(r, 3000))

  // host key authorized on ALL three repos (host "has permission").
  for (const acct of ["git-kn", "git-notes", "git-personal"]) await authorize(acct, hostPub)
  // Seed kn/notes only (pullRepoFromRemote needs an origin/main to fetch).
  // git-personal stays an EMPTY bare repo, so personal's first push creates
  // main with no unrelated-history rebase against a host-seeded commit.
  for (const acct of ["git-kn", "git-notes"]) {
    const d = join(HOME, `seed-${acct}`)
    await x("git", ["clone", "-q", sshUrl(acct), d], { env: hostEnv })
    await writeFile(join(d, "README.md"), `${acct}\n`)
    await x("git", ["-C", d, ...author, "add", "-A"])
    await x("git", ["-C", d, ...author, "commit", "-qm", "seed"])
    await x("git", ["-C", d, "push", "-q", "origin", "HEAD:main"], { env: hostEnv })
  }

  // The process default ssh is the HOST key — so the startup display-clone
  // (which uses no explicit key) reaches the repos. Loop work overrides this
  // per-call with the vault key.
  process.env.GIT_SSH_COMMAND = sshCmd(hostKey)

  const { ensureWorkspaceDirs, createUser, provisionUserPersonal, pullRepoFromRemote, pushPersonalToRemote } =
    await loadLoopat()
  const { workspaceKnowledgeDir, personalDir, personalVaultDir, personalLoopatConfigPath, personalLoopatDir } =
    await import("../../server/src/paths")
  const { configPath } = await import("../../server/src/config")

  // host config declares kn/notes (display mirror); startup clones with host key.
  await writeFile(configPath(), JSON.stringify({ knowledge: { git: sshUrl("git-kn") }, notes: { git: sshUrl("git-notes") }, providers: {}, repos: [] }, null, 2))
  await ensureWorkspaceDirs()
  const displayOk = await readFile(join(workspaceKnowledgeDir(), "README.md"), "utf8").then((s) => s.includes("git-kn")).catch(() => false)

  await createUser({ id: "e2e", password: "test1234" })
  await provisionUserPersonal("e2e")
  // personal is self-describing; its repo lives under the git-personal account.
  await mkdir(personalLoopatDir("e2e"), { recursive: true })
  await writeFile(personalLoopatConfigPath("e2e"), JSON.stringify({ providers: { default: "" }, knowledge: { git: sshUrl("git-kn") }, notes: { git: sshUrl("git-notes") } }, null, 2))
  await x("git", ["-C", personalDir("e2e"), "remote", "set-url", "origin", sshUrl("git-personal")]).catch(async () => {
    await x("git", ["-C", personalDir("e2e"), "remote", "add", "origin", sshUrl("git-personal")])
  })

  const vssh = join(personalVaultDir("e2e", "default"), "mounts", "home", ".ssh")
  const knOk = () => pullRepoFromRemote(workspaceKnowledgeDir(), "e2e").then((r: any) => r.ok)
  const persOk = () => pushPersonalToRemote("e2e").then((r: any) => r.ok)

  // stage 1 — empty personal: no vault key at all.
  const s1 = { kn: await knOk(), pers: await persOk() }

  // stage 2 — vault key present + authorized on kn/notes ONLY.
  await mkdir(vssh, { recursive: true })
  await copyFile(vaultKey, join(vssh, "id"))
  await chmod(join(vssh, "id"), 0o600)
  await authorize("git-kn", vaultPub)
  await authorize("git-notes", vaultPub)
  const s2 = { kn: await knOk(), pers: await persOk() }

  // stage 3 — vault key also authorized on personal.
  await authorize("git-personal", vaultPub)
  const s3 = { kn: await knOk(), pers: await persOk() }

  const ok =
    displayOk &&
    !s1.kn && !s1.pers &&
    s2.kn && !s2.pers &&
    s3.kn && s3.pers
  console.log(`  ${displayOk ? "✓" : "✗"} host key display-clone of kn worked (host has permission)`)
  console.log(`  ${!s1.kn && !s1.pers ? "✓" : "✗"} stage 1 (empty personal): kn=${s1.kn} personal=${s1.pers} — both must fail`)
  console.log(`  ${s2.kn && !s2.pers ? "✓" : "✗"} stage 2 (kn+notes authorized): kn=${s2.kn} personal=${s2.pers} — kn ok, personal fails`)
  console.log(`  ${s3.kn && s3.pers ? "✓" : "✗"} stage 3 (all authorized): kn=${s3.kn} personal=${s3.pers} — both ok`)
  return ok
}

async function loadLoopat() {
  const loops = await import("../../server/src/loops")
  const auth = await import("../../server/src/auth")
  return { ...loops, createUser: auth.createUser }
}

let ok = false
try { ok = await main() } finally { await cleanup() }
if (ok) console.log("PASS — loop work is gated by the personal/vault key per repo, not by the host.")
else { console.log("FAIL"); process.exit(1) }
