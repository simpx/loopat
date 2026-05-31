/**
 * `loopat uninstall` — clean removal of everything THIS workspace created.
 *
 * Every loopat resource is workspace-scoped: containers, images, and the
 * network all carry a `loopat.workspace=<ws>` label, and the data dir IS this
 * workspace's LOOPAT_HOME. So uninstall removes only its own — even when other
 * LOOPAT_HOMEs exist on the same host, there's no cross-workspace collateral.
 *
 * Shared host infrastructure loopat merely uses — the podman machine (a Linux
 * VM on macOS) and the npx/bun cache — is only PRINTED as a hint, never
 * touched. Deleting a shared VM out from under the user would be the opposite
 * of a clean uninstall.
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

// The label every loopat container/image/network carries (set at create/build
// time in podman.ts). Deleting by label is exact — no name-prefix ambiguity
// (e.g. workspace "foo" vs "foobar").
const LABEL_WORKSPACE = "loopat.workspace"
const labelFilter = `label=${LABEL_WORKSPACE}=${WORKSPACE}`

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

async function workspaceContainers(): Promise<string[]> {
  const r = await podman(["ps", "-aq", "--filter", labelFilter])
  return r.code === 0 ? lines(r.out) : []
}
async function workspaceImageIds(): Promise<string[]> {
  const r = await podman(["images", "--filter", labelFilter, "--format", "{{.ID}}"])
  return r.code === 0 ? [...new Set(lines(r.out))] : []
}
async function workspaceNetworks(): Promise<string[]> {
  const r = await podman(["network", "ls", "--filter", labelFilter, "--format", "{{.Name}}"])
  return r.code === 0 ? lines(r.out) : []
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
  const images = hasPodman ? await workspaceImageIds() : []
  const networks = hasPodman ? await workspaceNetworks() : []
  const dataExists = existsSync(LOOPAT_HOME)

  // ── Plan (the user sees the exact boundary before anything happens) ──
  console.log(`loopat uninstall — workspace "${WORKSPACE}"`)
  console.log("")
  console.log("Will remove (this workspace only):")
  console.log(`  • ${containers.length} sandbox container(s)`)
  console.log(`  • ${images.length} sandbox image(s)`)
  console.log(`  • ${networks.length} network(s)${networks.length ? ` (${networks.join(", ")})` : ""}`)
  console.log(`  • data dir: ${LOOPAT_HOME}${dataExists ? "" : "  (absent)"}`)
  if (!hasPodman) console.log("  • note: podman not found — skipping container/image/network cleanup")
  console.log("")

  if (!yes && !confirm("Proceed? This permanently deletes this workspace's data. [y/N] ")) {
    console.log("Aborted — nothing removed.")
    return
  }

  // Every resource below is label-scoped to THIS workspace — no shared-resource
  // guessing, so other workspaces on the host are never touched.
  if (hasPodman && containers.length) {
    process.stdout.write(`Removing ${containers.length} container(s)… `)
    await podman(["rm", "-f", ...containers])
    console.log("done")
  }
  if (hasPodman && images.length) {
    // rmi by image ID removes this workspace's tags; shared overlay layers
    // stay alive (refcounted) for any other workspace still using them.
    process.stdout.write(`Removing ${images.length} image(s)… `)
    await podman(["rmi", "-f", ...images])
    console.log("done")
  }
  for (const net of networks) {
    process.stdout.write(`Removing network "${net}"… `)
    await podman(["network", "rm", net])
    console.log("done")
  }
  if (dataExists) {
    process.stdout.write(`Removing data dir ${LOOPAT_HOME}… `)
    await rm(LOOPAT_HOME, { recursive: true, force: true })
    console.log("done")
  }

  // Second-layer hints — shared infra we deliberately do NOT touch.
  console.log("")
  console.log("Done. This workspace's resources are gone.")
  console.log("")
  console.log("Left untouched (shared host infra — remove yourself only if loopat was their only user):")
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
