/**
 * Personal secrets: flatten `personal/<user>/secrets/<service>/<VAR>` files
 * into a `{ VAR: <contents-trimmed> }` map. Used to substitute `${VAR}` refs
 * in workspace config (currently: mcpServers headers / env / etc).
 *
 * Convention from ccx: filename inside a service dir IS the env var name;
 * file body is the value. Loose files at the secrets root are skipped (they
 * don't follow the convention).
 *
 * Single-user MVP: the user is whoever created the loop. Multi-user later may
 * merge workspace-shared + per-user maps, or namespace by service.
 */
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { personalDir } from "./paths"

export async function loadPersonalSecrets(user: string): Promise<Record<string, string>> {
  const root = join(personalDir(user), "secrets")
  if (!existsSync(root)) return {}
  const out: Record<string, string> = {}
  for (const service of await readdir(root)) {
    const sdir = join(root, service)
    const s = await stat(sdir).catch(() => null)
    if (!s?.isDirectory()) continue
    for (const f of await readdir(sdir)) {
      try {
        out[f] = (await readFile(join(sdir, f), "utf8")).trim()
      } catch {
        // unreadable file — skip
      }
    }
  }
  return out
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function substituteVars<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(VAR_RE, (_, name) => vars[name] ?? "") as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteVars(v, vars)) as unknown as T
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteVars(v, vars)
    return out as unknown as T
  }
  return value
}
