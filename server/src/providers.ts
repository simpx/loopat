/**
 * Git-host provider registry bootstrap.
 *
 * - Built-in (open-source) providers self-register via the static imports below.
 * - External / internal providers live OUTSIDE the repo, in
 *   `LOOPAT_HOME/extensions/providers/*.{ts,js,mjs}`. `loadExtensionProviders()`
 *   dynamically imports each file and registers its default export. An extension
 *   is a plain object shaped like GitHostProvider — it does NOT import loopat, so
 *   an internal platform's adapter never has to enter the open-source core.
 */
import { join } from "node:path"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { registerProvider, type GitHostProvider } from "./git-host"
import { extensionsProvidersDir } from "./paths"

import "./github" // built-in, open-source

let extLoaded = false

/** Idempotently load external provider extensions from the extensions dir. */
export async function loadExtensionProviders(): Promise<void> {
  if (extLoaded) return
  extLoaded = true
  const dir = extensionsProvidersDir()
  if (!existsSync(dir)) return
  let files: string[] = []
  try { files = await readdir(dir) } catch { return }
  for (const f of files) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue
    try {
      const mod: any = await import(pathToFileURL(join(dir, f)).href)
      const p = mod.default ?? mod.provider
      if (p?.id && typeof p.authenticate === "function" && typeof p.ensureRepo === "function") {
        registerProvider(p as GitHostProvider)
        console.log(`[loopat] loaded git-host extension: ${p.id}`)
      } else {
        console.warn(`[loopat] ${f}: not a valid GitHostProvider (need id / authenticate / ensureRepo)`)
      }
    } catch (e: any) {
      console.warn(`[loopat] failed to load provider extension ${f}: ${e?.message ?? e}`)
    }
  }
}
