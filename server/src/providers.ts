/**
 * Git-host provider registry bootstrap.
 *
 * - Built-in (open-source) providers self-register via the static imports below.
 * - Remote extension: if `extensionUrl` is set in workspace config, the file is
 *   fetched on startup and cached at `LOOPAT_HOME/extensions/providers/`. On
 *   fetch failure, the cached version is used.
 * - Local extensions in `LOOPAT_HOME/extensions/providers/*.{ts,js,mjs}` are
 *   always loaded (includes the cached remote extension).
 */
import { join } from "node:path"
import { existsSync } from "node:fs"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { registerProvider, getProvider, type GitHostProvider } from "./git-host"
import { extensionsProvidersDir } from "./paths"
import { loadConfig } from "./config"

import "./github" // built-in, open-source

let extLoaded = false
const extensionProviderIds: string[] = []

async function fetchRemoteExtension(): Promise<void> {
  const cfg = await loadConfig()
  if (!cfg.extensionUrl) return
  const dir = extensionsProvidersDir()
  await mkdir(dir, { recursive: true })
  const url = cfg.extensionUrl
  const filename = url.split("/").pop() || "remote-extension.ts"
  const dest = join(dir, filename)

  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("~/")) {
    const { copyFile } = await import("node:fs/promises")
    const src = url.startsWith("~") ? join(process.env.HOME ?? "", url.slice(1)) : url
    try {
      await copyFile(src, dest)
      console.log(`[loopat] extension loaded from local: ${src}`)
    } catch (e: any) {
      if (existsSync(dest)) {
        console.log(`[loopat] local extension not found, using cache: ${e?.message ?? e}`)
      } else {
        console.warn(`[loopat] local extension not found, no cache: ${e?.message ?? e}`)
      }
    }
    return
  }

  try {
    const res = await fetch(url + `?t=${Date.now()}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const content = await res.text()
    await writeFile(dest + ".tmp", content)
    const { rename } = await import("node:fs/promises")
    await rename(dest + ".tmp", dest)
    console.log(`[loopat] extension updated from ${url}`)
  } catch (e: any) {
    if (existsSync(dest)) {
      console.log(`[loopat] extension fetch failed, using cache: ${e?.message ?? e}`)
    } else {
      console.warn(`[loopat] extension fetch failed, no cache: ${e?.message ?? e}`)
    }
  }
}

async function loadProvidersFromDir(dir: string): Promise<void> {
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
        try {
          const cfg = await loadConfig()
          if (typeof p.init === "function") p.init(cfg.providerConfig?.[p.id] ?? {})
        } catch {}
        console.log(`[loopat] loaded git-host extension: ${p.id}`)
      } else {
        console.warn(`[loopat] ${f}: not a valid GitHostProvider (need id / authenticate / ensureRepo)`)
      }
    } catch (e: any) {
      console.warn(`[loopat] failed to load provider extension ${f}: ${e?.message ?? e}`)
    }
  }
}

/** Idempotently load provider extensions (fetch remote + load local cache). */
export async function loadExtensionProviders(): Promise<void> {
  if (extLoaded) return
  extLoaded = true
  await fetchRemoteExtension()
  await loadProvidersFromDir(extensionsProvidersDir())
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
