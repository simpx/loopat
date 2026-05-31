/**
 * `loopat uninstall` — clean removal of everything loopat itself created.
 *
 * Boundary (deliberate): we remove ONLY loopat's own resources — the per-loop
 * sandbox containers, the sandbox images, the `loopat` podman network, and the
 * workspace data dir (LOOPAT_HOME). We do NOT touch shared infrastructure the
 * host may use for other things — the podman machine (a Linux VM on macOS) and
 * the npx/bun cache are only PRINTED as hints. Deleting a shared VM out from
 * under the user would be the opposite of a clean uninstall.
 *
 * Containers are found by the `loopat.workspace` label (set at create time in
 * podman.ts), not by guessing name prefixes. Shared images/network are removed
 * only once no loopat container remains anywhere, so a second workspace on the
 * same host isn't collateral.
 *
 * Run via the launcher: `npx loopat uninstall [--yes]`.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import { LOOPAT_HOME, WORKSPACE } from "./paths"

const execFileP = promisify(execFile)

// Stable external contract values — kept in sync with podman.ts. (These are the
// network name, container label key, and image repo prefix; they essentially
// never change, so a local copy avoids pulling the whole podman module in.)
const LABEL_WORKSPACE = "loopat.workspace"
const LOOPAT_NETWORK = "loopat"
const IMAGE_REF = "loopat-sandbox" // base `loopat-sandbox:latest` + child `loopat-sandbox-<hash>:latest`

type Run = { code: number; out: string; err: string }
async function podman(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP("podman", args, { maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, out: stdout, err: stderr }
  } catch (e: any) {
    return { code: typeof e?.code === "number" ? e.code : 1, out: e?.stdout ?? "", err: e?.stderr ?? String(e?.message ?? e) }
  }
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean)

async function podmanAvailable(): Promise<boolean> {
  return (await podman(["--version"])).code === 0
}

/** Containers belonging to THIS workspace. */
async function workspaceContainers(): Promise<string[]> {
  const r = await podman(["ps", "-aq", "--filter", `label=${LABEL_WORKSPACE}=${WORKSPACE}`])
  return r.code === 0 ? lines(r.out) : []
}

/** Any loopat container (any workspace) — used to decide if shared resources are still in use. */
async function anyLoopatContainers(): Promise<string[]> {
  const r = await podman(["ps", "-aq", "--filter", `label=${LABEL_WORKSPACE}`])
  return r.code === 0 ? lines(r.out) : []
}

async function loopatImageIds(): Promise<string[]> {
  const r = await podman(["images", "--filter", `reference=${IMAGE_REF}*`, "--format", "{{.ID}}"])
  return r.code === 0 ? [...new Set(lines(r.out))] : []
}

/** TTY confirm. Non-interactive (piped) without --yes → treated as "no". */
function confirm(question: string): boolean {
  const ans = prompt(question)
  return ans !== null && /^y(es)?$/i.test(ans.trim())
}

export async function runUninstall(argv: string[]): Promise<void> {
  const yes = argv.includes("--yes") || argv.includes("-y")
  const hasPodman = await podmanAvailable()
  const containers = hasPodman ? await workspaceContainers() : []
  const dataExists = existsSync(LOOPAT_HOME)

  // ── Plan (so the user sees the exact boundary before anything happens) ──
  console.log(`loopat uninstall — workspace "${WORKSPACE}"`)
  console.log("")
  console.log("Will remove:")
  console.log(`  • ${containers.length} sandbox container(s)`)
  console.log(`  • sandbox images + the "${LOOPAT_NETWORK}" network (if no loopat container remains)`)
  console.log(`  • data dir: ${LOOPAT_HOME}${dataExists ? "" : "  (absent)"}`)
  if (!hasPodman) console.log("  • note: podman not found — skipping container/image/network cleanup")
  console.log("")

  if (!yes && !confirm("Proceed? This permanently deletes your workspace data. [y/N] ")) {
    console.log("Aborted — nothing removed.")
    return
  }

  // 1. Our containers (label-scoped).
  if (hasPodman && containers.length) {
    process.stdout.write(`Removing ${containers.length} container(s)… `)
    await podman(["rm", "-f", ...containers])
    console.log("done")
  }

  // 2. Shared images + network — only when no loopat container is left anywhere.
  if (hasPodman) {
    const remaining = await anyLoopatContainers()
    if (remaining.length === 0) {
      const imgs = await loopatImageIds()
      if (imgs.length) {
        process.stdout.write(`Removing ${imgs.length} image(s)… `)
        await podman(["rmi", "-f", ...imgs])
        console.log("done")
      }
      if ((await podman(["network", "exists", LOOPAT_NETWORK])).code === 0) {
        process.stdout.write(`Removing network "${LOOPAT_NETWORK}"… `)
        await podman(["network", "rm", LOOPAT_NETWORK])
        console.log("done")
      }
    } else {
      console.log(`Keeping shared images/network — ${remaining.length} loopat container(s) from other workspaces still present.`)
    }
  }

  // 3. Workspace data.
  if (dataExists) {
    process.stdout.write(`Removing data dir ${LOOPAT_HOME}… `)
    await rm(LOOPAT_HOME, { recursive: true, force: true })
    console.log("done")
  }

  // 4. Second-layer hints — shared infra we deliberately do NOT touch.
  console.log("")
  console.log("Done. loopat's own resources are gone.")
  console.log("")
  console.log("Left untouched (remove yourself only if loopat was their only user):")
  if (process.platform === "darwin") {
    console.log("  • podman machine (Linux VM):  podman machine stop && podman machine rm")
  }
  console.log(`  • npx/bun cache:              rm -rf ${join(homedir(), ".npm", "_npx")}`)
  console.log("")
}

if (import.meta.main) {
  runUninstall(process.argv.slice(2)).catch((e) => {
    console.error(`[loopat] uninstall failed: ${e?.message ?? e}`)
    process.exit(1)
  })
}
