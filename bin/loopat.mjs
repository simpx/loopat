#!/usr/bin/env node
// loopat launcher — runs the Bun server bundled in this package.
//
// loopat's server is written against the Bun runtime (bun:sqlite, Bun.serve,
// bun-pty FFI, …), so it cannot run on plain Node. We depend on the `bun` npm
// package, which downloads a platform Bun binary at install time; this Node
// shim locates that binary and hands off to `bun server/src/index.ts`.
//
// `npx loopat` therefore works on any machine that has Node — the user never
// has to install Bun themselves.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, "..")
const serverEntry = join(pkgRoot, "server", "src", "index.ts")

function resolveBun() {
  // 1. Explicit override.
  if (process.env.LOOPAT_BUN && existsSync(process.env.LOOPAT_BUN)) {
    return process.env.LOOPAT_BUN
  }
  // 2. The `bun` dependency's installed binary. The package ships bin/bun.exe
  //    (a cross-platform shim) and, after its postinstall, the real binary.
  try {
    const bunPkg = dirname(require.resolve("bun/package.json"))
    for (const candidate of [
      join(bunPkg, "bin", "bun"),
      join(bunPkg, "bin", "bun.exe"),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* bun package not resolvable from here — fall through */
  }
  // 3. npm-created bin shim alongside our package.
  for (const candidate of [
    join(pkgRoot, "..", ".bin", "bun"),
    join(pkgRoot, "node_modules", ".bin", "bun"),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  // 4. A bun already on PATH.
  return "bun"
}

const bun = resolveBun()
const child = spawn(bun, [serverEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})

child.on("error", (err) => {
  console.error(`[loopat] failed to launch bun (${bun}): ${err.message}`)
  console.error("[loopat] set LOOPAT_BUN to a bun binary, or install bun: https://bun.sh")
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
