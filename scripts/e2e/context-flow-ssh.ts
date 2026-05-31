/**
 * e2e scenario #4 — context flow over a REAL ssh remote, authenticated with the
 * user's VAULT key (not the host's ssh).
 *
 * Spins up a throwaway git-over-ssh server (podman), declares it as the
 * personal repo's authoritative kn/notes remote, drops the matching private key
 * into the user's vault, then creates a loop. The loop's git ops must reach the
 * ssh server — and CAN ONLY do so with the vault key, because this process
 * inherits no GIT_SSH_COMMAND and the server authorizes only the test key. So a
 * successful fetch of the seeded content proves the vault-key path end to end:
 *   - personal config is authoritative (origin = the ssh url it declared)
 *   - server-side git authenticates AS THE USER (vault key), not as the host
 *
 * Safe + self-contained: throwaway LOOPAT_HOME + container, both removed on
 * exit. Requires bun + podman. First run builds the tiny ssh-server image.
 *
 * Run:  bun run scripts/e2e/context-flow-ssh.ts
 */
const HOME = `/tmp/loopat-e2e-sshcf-${process.pid}`
process.env.LOOPAT_HOME = HOME
delete process.env.GIT_SSH_COMMAND // loopat must rely on the vault key alone

const { execFile } = await import("node:child_process")
const { promisify } = await import("node:util")
const { writeFile, readFile, mkdir, copyFile, chmod, rm } = await import("node:fs/promises")
const { join } = await import("node:path")
const x = promisify(execFile)
const G = (...a: string[]) => x("git", a)
const podman = (...a: string[]) => x("podman", a)

const { ensureWorkspaceDirs, createLoop, provisionUserPersonal } = await import("../../server/src/loops")
const { createUser } = await import("../../server/src/auth")
const { workspaceKnowledgeDir, personalVaultDir, personalLoopatConfigPath, personalLoopatDir } =
  await import("../../server/src/paths")

const IMAGE = "loopat-gitssh-test"
const CTR = `loopat-e2e-gitssh-${process.pid}`
const PORT = "2223"
const serverDir = join(import.meta.dir, "git-ssh-server")

let ctrUp = false
async function cleanup() {
  if (ctrUp) await podman("rm", "-f", CTR).catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

async function main(): Promise<boolean> {
  await podman("build", "-q", "-t", IMAGE, serverDir) // cached after first run

  await mkdir(HOME, { recursive: true })
  const key = join(HOME, "id")
  await x("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key, "-q", "-C", "e2e"])
  const pub = (await readFile(key + ".pub", "utf8")).trim()

  await podman("rm", "-f", CTR).catch(() => {})
  await podman("run", "-d", "--name", CTR, "-p", `${PORT}:22`, "-e", `AUTHORIZED_KEY=${pub}`, IMAGE)
  ctrUp = true
  await new Promise((r) => setTimeout(r, 3000)) // let sshd come up

  const SSH_URL = `ssh://git@127.0.0.1:${PORT}/srv/git/repo.git`
  const keyEnv = {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`,
  }

  // seed the remote with a commit (directly, with the test key)
  const seed = join(HOME, "seed")
  await x("git", ["clone", "-q", SSH_URL, seed], { env: keyEnv })
  await writeFile(join(seed, "TEAM.md"), "team knowledge\n")
  const author = ["-c", "user.email=e2e@x", "-c", "user.name=e2e"]
  await x("git", ["-C", seed, ...author, "add", "-A"])
  await x("git", ["-C", seed, ...author, "commit", "-qm", "seed"])
  await x("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"], { env: keyEnv })

  // loopat: vault key + self-describing personal config pointing at the ssh url
  await ensureWorkspaceDirs()
  await createUser({ id: "e2e", password: "test1234" })
  await provisionUserPersonal("e2e")
  const vssh = join(personalVaultDir("e2e", "default"), "mounts", "home", ".ssh")
  await mkdir(vssh, { recursive: true })
  await copyFile(key, join(vssh, "id"))
  await chmod(join(vssh, "id"), 0o600)
  await mkdir(personalLoopatDir("e2e"), { recursive: true })
  await writeFile(
    personalLoopatConfigPath("e2e"),
    JSON.stringify({ providers: { default: "" }, knowledge: { git: SSH_URL }, notes: { git: SSH_URL } }, null, 2),
  )

  // createLoop → ensureUserContext fetches the ssh remote WITH THE VAULT KEY
  const loop = await createLoop({ title: "writer", createdBy: "e2e" })
  console.log(`loop ${loop.id.slice(0, 8)} created`)

  const kn = workspaceKnowledgeDir()
  const origin = (await G("-C", kn, "remote", "get-url", "origin")).stdout.trim()
  const hasMain = await G("-C", kn, "rev-parse", "--verify", "-q", "origin/main").then(() => true).catch(() => false)
  const teamFile = await G("-C", kn, "cat-file", "-e", "origin/main:TEAM.md").then(() => true).catch(() => false)
  console.log(`  ${origin === SSH_URL ? "✓" : "✗"} origin = personal-declared ssh url (authoritative)`)
  console.log(`  ${hasMain ? "✓" : "✗"} fetched origin/main — vault-key ssh auth succeeded`)
  console.log(`  ${teamFile ? "✓" : "✗"} seeded team content reachable via the remote`)
  return origin === SSH_URL && hasMain && teamFile
}

let ok = false
try { ok = await main() } finally { await cleanup() }
if (ok) console.log("PASS — loop reached the ssh remote with the user's vault key alone.")
else { console.log("FAIL"); process.exit(1) }
