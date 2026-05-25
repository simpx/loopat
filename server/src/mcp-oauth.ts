/**
 * MCP OAuth 2.0 client — loopat owns the OAuth dance, not the sandboxed CC.
 *
 * Flow (high-level):
 *   1. POST /api/mcp-auth/start { serverName }
 *      ↓
 *      lookup workspace mcpServers[serverName].url
 *      ↓
 *      discover OAuth metadata:
 *        - RFC 9728 (protected-resource metadata) → list of auth servers
 *        - RFC 8414 (auth-server metadata)         → endpoints
 *      ↓
 *      RFC 7591 dynamic client registration (DCR) — register loopat as a
 *      client at the auth server, get client_id / optionally client_secret
 *      ↓
 *      generate PKCE verifier + challenge, generate state
 *      ↓
 *      stash flow context (user, vault, server, verifier, client creds, ...)
 *      keyed by state in an in-memory map with TTL
 *      ↓
 *      return { authorizationUrl } to the frontend; frontend navigates browser
 *
 *   2. browser → MCP server auth page → user authorizes → MCP server redirects
 *      back to GET /api/mcp-auth/callback?code=…&state=…
 *      ↓
 *      look up state in map (verify CSRF), exchange code+verifier for
 *      access_token at token_endpoint, persist into the user's vault
 *      ↓
 *      redirect browser back to /settings/mcp-auth?status=ok&server=…
 *
 * Discovery / DCR / token exchange are all standard OAuth 2.0 + RFCs that
 * MCP spec mandates for servers offering OAuth. Servers that don't support
 * DCR will need a future "operator pre-configures client_id" fallback.
 */
import { createHash, randomBytes } from "node:crypto"

import { type McpServerConfig, writeVaultEnv } from "./config"

/**
 * Map an MCP server name to the env var name loopat writes the access token
 * to. Spaces / dots / hyphens are normalized to underscores, name is upper-
 * cased, prefixed with `MCP_` and suffixed with `_TOKEN`. Workspace
 * `.mcp.json` references the same name via `${MCP_<NAME>_TOKEN}` substitution.
 *
 * Examples:
 *   github       → MCP_GITHUB_TOKEN
 *   Google Drive → MCP_GOOGLE_DRIVE_TOKEN
 *   linear-mcp   → MCP_LINEAR_MCP_TOKEN
 */
export function mcpServerEnvVarName(serverName: string): string {
  const sanitized = serverName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
  return `MCP_${sanitized || "SERVER"}_TOKEN`
}

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes — generous; OAuth flows are slow

type FlowState = {
  user: string
  vault: string
  serverName: string
  serverUrl: string
  redirectUri: string
  codeVerifier: string
  clientId: string
  clientSecret?: string
  authorizationEndpoint: string
  tokenEndpoint: string
  scope?: string
  createdAt: number
}

/**
 * Pending OAuth flows keyed by `state` parameter. Each entry self-expires
 * after STATE_TTL_MS. Lazy cleanup on insert: every time we add an entry, we
 * sweep expired ones. No background timer needed.
 */
class FlowStateMap {
  private map = new Map<string, FlowState>()

  put(state: string, value: FlowState): void {
    this.sweep()
    this.map.set(state, value)
  }

  /** Returns and **removes** the entry (one-shot consumption). */
  consume(state: string): FlowState | null {
    const v = this.map.get(state)
    if (!v) return null
    this.map.delete(state)
    if (Date.now() - v.createdAt > STATE_TTL_MS) return null
    return v
  }

  private sweep() {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (now - v.createdAt > STATE_TTL_MS) this.map.delete(k)
    }
  }
}

export const flowStates = new FlowStateMap()

// ── helpers ────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function genState(): string {
  return b64url(randomBytes(24))
}

function genPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Try a sequence of `.well-known` candidate URLs derived from a base URL, and
 * return the first that responds with JSON. MCP spec says the protected-
 * resource metadata sits at `<base>/.well-known/oauth-protected-resource` but
 * servers vary on whether the MCP path segment is included.
 */
async function fetchJsonFirstOk(urls: string[], timeoutMs = 5000): Promise<{ url: string; json: any } | null> {
  for (const url of urls) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } })
      clearTimeout(t)
      if (!r.ok) continue
      const json = await r.json().catch(() => null)
      if (json && typeof json === "object") return { url, json }
    } catch {}
  }
  return null
}

// ── RFC 9728 protected-resource metadata ───────────────────────────────

type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: string[]
}

async function discoverProtectedResource(serverUrl: string): Promise<ProtectedResourceMetadata | null> {
  // The MCP server URL may be `https://host/mcp` or just `https://host`.
  // Try both `host/.well-known/oauth-protected-resource/mcp` (path-suffixed)
  // and `host/.well-known/oauth-protected-resource` (root).
  const u = new URL(serverUrl)
  const candidates = [
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`.replace(/\/+$/, ""),
    `${u.origin}/.well-known/oauth-protected-resource`,
  ]
  const r = await fetchJsonFirstOk(candidates)
  if (!r) return null
  const json = r.json
  if (
    !json.authorization_servers ||
    !Array.isArray(json.authorization_servers) ||
    json.authorization_servers.length === 0
  ) {
    return null
  }
  return json as ProtectedResourceMetadata
}

// ── RFC 8414 authorization-server metadata ─────────────────────────────

type AuthServerMetadata = {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  grant_types_supported?: string[]
  code_challenge_methods_supported?: string[]
  /** Optional. If supplied, controls token endpoint authentication. */
  token_endpoint_auth_methods_supported?: string[]
}

async function discoverAuthServer(authServerUrl: string): Promise<AuthServerMetadata | null> {
  const u = new URL(authServerUrl)
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${u.pathname}`.replace(/\/+$/, ""),
    `${u.origin}/.well-known/oauth-authorization-server`,
    // Some MCP servers expose this even when also hosting protected resource.
    // (RFC 8414 doesn't standardize a path, but this is conventional.)
  ]
  const r = await fetchJsonFirstOk(candidates)
  if (!r) return null
  const json = r.json
  if (!json.authorization_endpoint || !json.token_endpoint) return null
  return json as AuthServerMetadata
}

// ── OAuth capability probe ─────────────────────────────────────────────
//
// Tells the UI in advance whether loopat can OAuth into a given MCP server,
// so a "needs auth" button isn't shown for servers it can't actually handle
// (Slack / Google Drive / other consumer providers that don't expose DCR).

export type OAuthSupport =
  /** Auth server exposes registration_endpoint — loopat can DCR + auto-auth. */
  | "dcr"
  /** OAuth flow exists but DCR isn't available — admin would need to manually
   *  register an app with the provider; loopat doesn't (yet) accept static
   *  client_id input, so this is effectively unsupported. */
  | "manual"
  /** Server doesn't advertise OAuth (no .well-known/oauth-protected-resource).
   *  Either public, API-key-based, or some other auth scheme — loopat has
   *  nothing to do; CC connects directly. */
  | "none"
  /** Probe failed — server unreachable, malformed metadata, etc. */
  | "unreachable"

type ProbeResult = { support: OAuthSupport; probedAt: number }

// In-memory cache. Keyed by server URL. TTL differs by result class so a
// transient "unreachable" doesn't get stuck for a day.
const probeCache = new Map<string, ProbeResult>()
const TTL_OK_MS = 24 * 60 * 60 * 1000
const TTL_NEG_MS = 5 * 60 * 1000

export async function probeOAuthSupport(serverUrl: string, opts: { force?: boolean } = {}): Promise<OAuthSupport> {
  const cached = probeCache.get(serverUrl)
  if (!opts.force && cached) {
    const ttl = cached.support === "dcr" || cached.support === "manual" ? TTL_OK_MS : TTL_NEG_MS
    if (Date.now() - cached.probedAt < ttl) return cached.support
  }
  const support = await runProbe(serverUrl)
  probeCache.set(serverUrl, { support, probedAt: Date.now() })
  return support
}

async function runProbe(serverUrl: string): Promise<OAuthSupport> {
  let prm
  try {
    prm = await discoverProtectedResource(serverUrl)
  } catch {
    return "unreachable"
  }
  if (!prm) return "none"
  const authServerUrl = prm.authorization_servers[0]
  let asm
  try {
    asm = await discoverAuthServer(authServerUrl)
  } catch {
    return "unreachable"
  }
  if (!asm) return "unreachable"
  return asm.registration_endpoint ? "dcr" : "manual"
}

/** Clear cached probe result(s). url omitted → clear everything. */
export function evictOAuthProbe(url?: string): void {
  if (url) probeCache.delete(url)
  else probeCache.clear()
}

// ── RFC 7591 dynamic client registration ───────────────────────────────

type DcrResponse = {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  redirect_uris?: string[]
}

async function dynamicRegister(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<DcrResponse | null> {
  const body = {
    client_name: "loopat",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  }
  try {
    const r = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      console.warn(`[loopat] DCR failed (${r.status}): ${await r.text().catch(() => "")}`)
      return null
    }
    return (await r.json()) as DcrResponse
  } catch (e: any) {
    console.warn(`[loopat] DCR error: ${e?.message ?? e}`)
    return null
  }
}

// ── flow: start ────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; authorizationUrl: string; state: string }
  | { ok: false; error: string }

/**
 * Begin an OAuth flow for (user, vault, serverName). The browser-side caller
 * navigates to `authorizationUrl` next.
 */
export async function startMcpAuth(opts: {
  user: string
  vault: string
  serverName: string
  /** Loop the auth request originates from — determines which profiles to
   *  look up. Empty string = no profile context (e.g. Settings page). */
  loopId?: string
  publicBaseUrl: string
}): Promise<StartResult> {
  const { user, vault, serverName, loopId, publicBaseUrl } = opts

  // Walk plugin-bundled .mcp.json files (from the loop's enabled plugins).
  // Reads the loop's merged settings.json for enabledPlugins, then resolves
  // each spec to its host path via lookupPluginInstallPath. Needs the loop
  // to have been spawned at least once (so compose has materialized
  // settings.json). Returns [] if no loopId (settings page case).
  let srv: McpServerConfig | undefined
  const { existsSync } = await import("node:fs")
  const { readFile: rf } = await import("node:fs/promises")
  const { join: pjoin } = await import("node:path")
  const resolved: Array<{ path: string }> = []
  if (loopId) {
    const { lookupPluginInstallPath } = await import("./plugin-installer")
    const { loopClaudeDir } = await import("./paths")
    const settingsPath = pjoin(loopClaudeDir(loopId), "settings.json")
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(await rf(settingsPath, "utf8")) as {
          enabledPlugins?: Record<string, boolean>
        }
        const enabled = Object.entries(settings.enabledPlugins ?? {})
          .filter(([_, v]) => v)
          .map(([k]) => k)
        for (const spec of enabled) {
          const p = await lookupPluginInstallPath(spec)
          if (p) resolved.push({ path: p })
        }
      } catch {}
    }
  }
  for (const p of resolved) {
    const mcpPath = pjoin(p.path, ".mcp.json")
    if (!existsSync(mcpPath)) continue
    try {
      const j = JSON.parse(await rf(mcpPath, "utf8"))
      const candidate = (j?.mcpServers ?? {})[serverName] as McpServerConfig | undefined
      if (candidate) {
        srv = candidate
        break
      }
    } catch {}
  }
  if (!srv) return { ok: false, error: `server "${serverName}" not found in any plugin for this loop's profiles` }
  if (srv.type !== "http" && srv.type !== "sse") {
    return { ok: false, error: `server "${serverName}" is type "${srv.type}"; only http/sse support OAuth` }
  }
  const serverUrl = (srv as any).url as string
  if (!serverUrl) return { ok: false, error: `server "${serverName}" missing url` }

  // 1) discover protected-resource → list of authorization servers
  const prm = await discoverProtectedResource(serverUrl)
  if (!prm) {
    return {
      ok: false,
      error: `failed to discover protected-resource metadata at ${serverUrl} — the server may not implement OAuth, or .well-known/oauth-protected-resource is unreachable`,
    }
  }
  const authServerUrl = prm.authorization_servers[0]

  // 2) discover authorization-server metadata
  const asm = await discoverAuthServer(authServerUrl)
  if (!asm) {
    return { ok: false, error: `failed to discover auth-server metadata at ${authServerUrl}` }
  }

  // 3) DCR (RFC 7591) — if the server doesn't expose registration_endpoint we
  //    refuse with an actionable error. (Future: operator-supplied client_id
  //    fallback.)
  const redirectUri = `${publicBaseUrl.replace(/\/+$/, "")}/api/mcp-auth/callback`
  if (!asm.registration_endpoint) {
    return {
      ok: false,
      error: `auth server ${authServerUrl} does not advertise registration_endpoint (DCR); operator-static client_id fallback not yet implemented`,
    }
  }
  const reg = await dynamicRegister(asm.registration_endpoint, redirectUri)
  if (!reg) return { ok: false, error: `dynamic client registration failed` }

  // 4) PKCE + state, stash, build authorization URL
  const { verifier, challenge } = genPkce()
  const state = genState()

  flowStates.put(state, {
    user,
    vault,
    serverName,
    serverUrl,
    redirectUri,
    codeVerifier: verifier,
    clientId: reg.client_id,
    clientSecret: reg.client_secret,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    scope: asm.scopes_supported?.join(" "),
    createdAt: Date.now(),
  })

  const authUrl = new URL(asm.authorization_endpoint)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("client_id", reg.client_id)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("state", state)
  authUrl.searchParams.set("code_challenge", challenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  if (asm.scopes_supported?.length) {
    authUrl.searchParams.set("scope", asm.scopes_supported.join(" "))
  }

  return { ok: true, authorizationUrl: authUrl.toString(), state }
}

// ── flow: callback ──────────────────────────────────────────────────────

export type CallbackResult =
  | { ok: true; serverName: string }
  | { ok: false; error: string }

/**
 * Process the OAuth redirect coming back from the MCP server. Exchanges
 * code+verifier for an access_token and persists into the user's vault.
 */
export async function completeMcpAuth(opts: {
  state: string
  code: string
}): Promise<CallbackResult> {
  const flow = flowStates.consume(opts.state)
  if (!flow) return { ok: false, error: `unknown or expired state` }

  // token endpoint exchange
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
  })

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }
  if (flow.clientSecret) {
    headers["Authorization"] =
      "Basic " +
      Buffer.from(`${encodeURIComponent(flow.clientId)}:${encodeURIComponent(flow.clientSecret)}`).toString("base64")
  }

  let resp: Response
  try {
    resp = await fetch(flow.tokenEndpoint, { method: "POST", headers, body })
  } catch (e: any) {
    return { ok: false, error: `token exchange network error: ${e?.message ?? e}` }
  }
  if (!resp.ok) {
    return { ok: false, error: `token exchange ${resp.status}: ${await resp.text().catch(() => "")}` }
  }
  const tok = await resp.json().catch(() => null)
  if (!tok?.access_token) return { ok: false, error: `token response missing access_token` }

  // Persist only the access token as a vault env. Refresh/revoke aren't
  // implemented yet, so the OAuth metadata (refresh_token, clientId, token
  // endpoint, etc.) would be dead-on-disk noise — drop it. If/when refresh
  // lands, the natural home is additional env files named like
  // MCP_<NAME>_REFRESH_TOKEN / MCP_<NAME>_CLIENT_ID.
  const envName = mcpServerEnvVarName(flow.serverName)
  await writeVaultEnv(flow.user, flow.vault, envName, tok.access_token)

  // Token is persisted, but **already-running** LoopSessions still hold the
  // old `query()` options. We intentionally do NOT auto-restart them here:
  // that would interrupt long-running generations the user may have started
  // in other loops. The /mcp popover exposes an explicit "Reload" button so
  // the user reloads on their own terms, on the loop they're currently in.
  return { ok: true, serverName: flow.serverName }
}
