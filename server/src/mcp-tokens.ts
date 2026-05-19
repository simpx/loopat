/**
 * Per-(user, vault) MCP OAuth token store.
 *
 * Storage: `personal/<user>/.loopat/vaults/<vault>/mcp-tokens.json`
 *
 *   {
 *     "<serverName>": {
 *       accessToken: string,
 *       refreshToken?: string,
 *       expiresAt?: number,           // ms epoch
 *       scope?: string,
 *       clientId?: string,
 *       clientSecret?: string,
 *       serverUrl?: string,           // sanity-check vs workspace claude.json
 *       authorizationEndpoint?: string,
 *       tokenEndpoint?: string,
 *     }
 *   }
 *
 * Why inside the vault? Because vault content is git-crypt encrypted, the
 * tokens (including refresh tokens that survive on disk for weeks) automatically
 * become ciphertext when pushed to the personal repo. Cross-vault isolation
 * comes for free: a loop spawned with vault=prod sees only prod tokens.
 *
 * `serverName` matches a key in workspace `mcpServers` config
 * (knowledge/.loopat/claude/claude.json). spawn-time inject merges these into
 * per-server `headers.Authorization`, so the sandboxed CC sees pre-
 * authenticated HTTP/SSE transports and skips its own OAuth flow.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { personalMcpTokensPath } from "./paths"
import type { McpServerConfig } from "./config"

export type McpServerToken = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  /** Stored from OAuth client registration; kept for refresh + revoke flows. */
  clientId?: string
  clientSecret?: string
  /** Snapshot of MCP server URL at auth time; surfaces "config drift" if the
   *  workspace claude.json server URL changes later. */
  serverUrl?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
}

export type McpTokensFile = Record<string, McpServerToken>

export async function loadMcpTokens(user: string, vault: string): Promise<McpTokensFile> {
  const p = personalMcpTokensPath(user, vault)
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(await readFile(p, "utf8"))
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as McpTokensFile
  } catch (e: any) {
    console.warn(`[loopat] mcp-tokens: malformed at ${p}: ${e?.message ?? e}`)
    return {}
  }
}

export async function saveMcpTokens(
  user: string,
  vault: string,
  tokens: McpTokensFile,
): Promise<void> {
  const p = personalMcpTokensPath(user, vault)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(tokens, null, 2) + "\n")
}

export async function putMcpToken(
  user: string,
  vault: string,
  serverName: string,
  token: McpServerToken,
): Promise<void> {
  const all = await loadMcpTokens(user, vault)
  all[serverName] = token
  await saveMcpTokens(user, vault, all)
}

export async function deleteMcpToken(
  user: string,
  vault: string,
  serverName: string,
): Promise<void> {
  const all = await loadMcpTokens(user, vault)
  delete all[serverName]
  await saveMcpTokens(user, vault, all)
}

/**
 * Take a workspace mcpServers config and merge in this (user, vault)'s stored
 * tokens as `Authorization: Bearer <token>` headers. Only http/sse servers
 * support headers; stdio servers pass through unchanged.
 *
 * Pure function; returns a fresh map. Original workspace config not mutated.
 */
export function mergeMcpTokens(
  workspaceServers: Record<string, McpServerConfig> | undefined,
  userTokens: McpTokensFile,
): Record<string, McpServerConfig> | undefined {
  if (!workspaceServers) return workspaceServers
  const out: Record<string, McpServerConfig> = {}
  for (const [name, srv] of Object.entries(workspaceServers)) {
    const tok = userTokens[name]
    if (!tok || !tok.accessToken) {
      out[name] = srv
      continue
    }
    if (srv.type === "http" || srv.type === "sse") {
      out[name] = {
        ...srv,
        headers: {
          ...(srv.headers ?? {}),
          Authorization: `Bearer ${tok.accessToken}`,
        },
      }
    } else {
      out[name] = srv
    }
  }
  return out
}
