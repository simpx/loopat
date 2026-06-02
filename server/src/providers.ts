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
import { registerProvider, getProvider, type GitHostProvider } from "./git-host"
import { extensionsProvidersDir } from "./paths"

import "./github" // built-in, open-source

let extLoaded = false
// Ids of providers loaded from extension files (NOT the built-in github). A
// dropped-in extension IS the active provider — see resolveProviderId().
const extensionProviderIds: string[] = []

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
        if (!extensionProviderIds.includes(p.id)) extensionProviderIds.push(p.id)
        console.log(`[loopat] loaded git-host extension: ${p.id}`)
      } else {
        console.warn(`[loopat] ${f}: not a valid GitHostProvider (need id / authenticate / ensureRepo)`)
      }
    } catch (e: any) {
      console.warn(`[loopat] failed to load provider extension ${f}: ${e?.message ?? e}`)
    }
  }
}

/**
 * Resolve the active git-host provider id.
 *
 * A provider extension dropped into `LOOPAT_HOME/extensions/providers/` IS the
 * provider: if any extension is present it wins outright — no `config.json`
 * `gitHost.provider` needed. Multiple extensions → any one of them (undefined
 * behavior). With no extension present, fall back to the explicitly-requested
 * id, then the built-in `github`.
 */
export async function resolveProviderId(requested?: string): Promise<string> {
  await loadExtensionProviders()
  if (extensionProviderIds.length > 0) return extensionProviderIds[0]
  return requested || "github"
}

/** Resolve and return the active provider object (see resolveProviderId). Its
 *  baseUrl / defaultRepo / tokenHelp let loopat run with no config.json. */
export async function resolveProvider(requested?: string): Promise<GitHostProvider | undefined> {
  return getProvider(await resolveProviderId(requested))
}
