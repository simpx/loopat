#!/usr/bin/env node
/**
 * postinstall: make sure a LINUX claude binary is available for the sandbox.
 *
 * loopat runs the AI inside a linux podman sandbox, so it needs the
 * linux-<arch> claude binary. npm only installs the claude-agent-sdk platform
 * binary matching the HOST (os/cpu filtered optionalDependencies) — so on a
 * linux host we already have it (no-op here), but on macOS/Windows npm installs
 * the darwin/win binary and the sandbox would hit "Exec format error".
 *
 * On a non-linux host we fetch the linux-<arch> binary into
 * <loopat>/sandbox-claude (pinned to the SDK version we depend on) using npm's
 * --os/--cpu override. Best-effort: a failure only means sandbox AI won't run
 * on this host until fixed; the install itself still succeeds.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

if (process.platform === "linux") process.exit(0) // host claude IS the sandbox claude

const arch = process.arch // "arm64" | "x64"
const pkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}`
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dest = join(installDir, "sandbox-claude")
const binary = join(dest, "node_modules", pkg, "claude")

if (existsSync(binary)) process.exit(0) // already fetched

try {
  const require = createRequire(import.meta.url)
  let version = ""
  try {
    version = require("@anthropic-ai/claude-agent-sdk/package.json").version
  } catch {}
  const spec = version ? `${pkg}@${version}` : pkg
  mkdirSync(dest, { recursive: true })
  console.log(`[loopat] host is ${process.platform}/${arch}; fetching linux claude for the sandbox (${spec})…`)
  // The platform binary declares os=linux, so `--os=linux --cpu` hits
  // EBADPLATFORM on a darwin host — `--force` is what actually fetches it.
  execFileSync("npm", ["install", "--prefix", dest, "--no-save", "--force", spec], { stdio: "inherit" })
  if (existsSync(binary)) console.log(`[loopat] sandbox claude ready at ${binary}`)
  else console.warn(`[loopat] sandbox claude install finished but ${binary} is missing`)
} catch (e) {
  console.warn(`[loopat] could not fetch linux claude for the sandbox: ${e?.message ?? e}`)
  console.warn(`[loopat] sandbox AI won't run on this host until fixed; everything else works.`)
}
