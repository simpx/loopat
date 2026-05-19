#!/usr/bin/env bun
/**
 * Mock MCP server + OAuth 2.0 authorization server, for end-to-end testing
 * loopat's MCP auth flow without depending on a real internal MCP server.
 *
 * Implements:
 *
 *   - RFC 9728 protected-resource metadata
 *       GET /.well-known/oauth-protected-resource[/mcp]
 *   - RFC 8414 authorization-server metadata
 *       GET /.well-known/oauth-authorization-server
 *   - RFC 7591 dynamic client registration
 *       POST /oauth/register
 *   - Authorization code flow with PKCE
 *       GET  /oauth/authorize  → renders an "Approve" page (auto-approves)
 *       POST /oauth/token      → exchanges code for access_token
 *   - A minimal MCP HTTP endpoint requiring Bearer auth
 *       POST /mcp              → returns one fake tool "mock_echo"
 *
 * Auth is intentionally NOT secure — codes / tokens are stored in-memory and
 * the "Approve" page just auto-redirects. This is for local dev only.
 *
 * Usage:
 *   bun run scripts/mock-mcp-server.ts                 # listens on :7799
 *   PORT=8888 bun run scripts/mock-mcp-server.ts       # custom port
 *
 * Then in your loopat workspace claude.json add:
 *   {
 *     "mcpServers": {
 *       "mock": {
 *         "type": "http",
 *         "url": "http://localhost:7799/mcp"
 *       }
 *     }
 *   }
 *
 * Restart loopat, then Settings → MCP Auth → Connect mock.
 */
import { createHash, randomBytes } from "node:crypto"

const PORT = Number(process.env.PORT) || 7799
const HOST = process.env.HOST || "127.0.0.1"
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://${HOST}:${PORT}`

// ── in-memory stores ───────────────────────────────────────────────────

type Client = {
  client_id: string
  client_secret: string
  redirect_uris: string[]
}

type PendingCode = {
  code: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  scope: string
  createdAt: number
}

type Token = {
  access_token: string
  refresh_token: string
  client_id: string
  scope: string
  expiresAt: number
}

const clients = new Map<string, Client>()
const pendingCodes = new Map<string, PendingCode>()
const tokens = new Map<string, Token>() // by access_token
const refreshTokens = new Map<string, Token>() // by refresh_token

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function rnd(n = 24) {
  return b64url(randomBytes(n))
}

// ── routes ─────────────────────────────────────────────────────────────

function json(body: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })
}

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html" } })
}

const handlers: Record<string, (req: Request, url: URL) => Promise<Response> | Response> = {
  // RFC 9728 protected-resource metadata
  "GET /.well-known/oauth-protected-resource": () =>
    json({
      resource: `${PUBLIC_BASE}/mcp`,
      authorization_servers: [PUBLIC_BASE],
    }),
  "GET /.well-known/oauth-protected-resource/mcp": () =>
    json({
      resource: `${PUBLIC_BASE}/mcp`,
      authorization_servers: [PUBLIC_BASE],
    }),

  // RFC 8414 auth-server metadata
  "GET /.well-known/oauth-authorization-server": () =>
    json({
      issuer: PUBLIC_BASE,
      authorization_endpoint: `${PUBLIC_BASE}/oauth/authorize`,
      token_endpoint: `${PUBLIC_BASE}/oauth/token`,
      registration_endpoint: `${PUBLIC_BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      scopes_supported: ["mock:read", "mock:write"],
    }),

  // RFC 7591 DCR
  "POST /oauth/register": async (req) => {
    const body = await req.json().catch(() => ({})) as any
    const client_id = "mock-" + rnd(8)
    const client_secret = "mocks_" + rnd(16)
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
    clients.set(client_id, { client_id, client_secret, redirect_uris })
    console.log(`[mock-mcp] DCR: registered client ${client_id} (redirect_uris=${JSON.stringify(redirect_uris)})`)
    return json({
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: body.response_types ?? ["code"],
    })
  },

  // Authorization endpoint — renders an auto-approve "Approve" page.
  "GET /oauth/authorize": async (req, url) => {
    const client_id = url.searchParams.get("client_id") ?? ""
    const redirect_uri = url.searchParams.get("redirect_uri") ?? ""
    const state = url.searchParams.get("state") ?? ""
    const code_challenge = url.searchParams.get("code_challenge") ?? ""
    const code_challenge_method = url.searchParams.get("code_challenge_method") ?? "S256"
    const scope = url.searchParams.get("scope") ?? ""

    const client = clients.get(client_id)
    if (!client) return new Response("unknown client", { status: 400 })
    if (!client.redirect_uris.includes(redirect_uri)) {
      return new Response("redirect_uri mismatch", { status: 400 })
    }
    if (!code_challenge) return new Response("missing code_challenge", { status: 400 })

    // Render a tiny consent page that auto-redirects (since this is mock).
    // For realism / debugging you can comment out the meta refresh below and
    // click the link manually.
    const code = "mockcode_" + rnd(16)
    pendingCodes.set(code, {
      code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      createdAt: Date.now(),
    })
    const target = new URL(redirect_uri)
    target.searchParams.set("code", code)
    if (state) target.searchParams.set("state", state)

    return html(`
<!doctype html><meta charset="utf-8"/>
<title>mock-mcp authorize</title>
<meta http-equiv="refresh" content="0;url=${target.toString()}"/>
<style>body{font:14px system-ui;padding:2em;max-width:600px;margin:auto}</style>
<h2>Mock MCP Authorization</h2>
<p>Client <code>${client_id}</code> wants to access scope: <code>${scope || "(default)"}</code>.</p>
<p>Auto-redirecting to <a href="${target.toString()}">${target.toString()}</a>…</p>
`)
  },

  // Token endpoint
  "POST /oauth/token": async (req) => {
    const form = await req.formData()
    const grant_type = form.get("grant_type")?.toString()
    if (grant_type === "authorization_code") {
      const code = form.get("code")?.toString() ?? ""
      const code_verifier = form.get("code_verifier")?.toString() ?? ""
      const redirect_uri = form.get("redirect_uri")?.toString() ?? ""
      const client_id_form = form.get("client_id")?.toString() ?? ""

      const pending = pendingCodes.get(code)
      if (!pending) return json({ error: "invalid_grant", error_description: "unknown code" }, { status: 400 })
      pendingCodes.delete(code)
      if (pending.redirect_uri !== redirect_uri) {
        return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 })
      }
      // PKCE verify
      const expectedChallenge = b64url(createHash("sha256").update(code_verifier).digest())
      if (expectedChallenge !== pending.code_challenge) {
        return json({ error: "invalid_grant", error_description: "PKCE verifier mismatch" }, { status: 400 })
      }
      // (Optional) client auth — accept either Basic or form `client_id`.
      const auth = req.headers.get("authorization") ?? ""
      let authedClientId = ""
      if (auth.startsWith("Basic ")) {
        try {
          const [u] = Buffer.from(auth.slice(6), "base64").toString().split(":")
          authedClientId = decodeURIComponent(u ?? "")
        } catch {}
      } else if (client_id_form) {
        authedClientId = client_id_form
      }
      if (authedClientId && authedClientId !== pending.client_id) {
        return json({ error: "invalid_client", error_description: "client_id mismatch" }, { status: 401 })
      }

      const access_token = "mocka_" + rnd(24)
      const refresh_token = "mockr_" + rnd(24)
      const tok: Token = {
        access_token,
        refresh_token,
        client_id: pending.client_id,
        scope: pending.scope,
        expiresAt: Date.now() + 3600 * 1000,
      }
      tokens.set(access_token, tok)
      refreshTokens.set(refresh_token, tok)
      console.log(`[mock-mcp] issued token for client=${pending.client_id} scope=${pending.scope}`)
      return json({
        access_token,
        refresh_token,
        token_type: "Bearer",
        expires_in: 3600,
        scope: pending.scope,
      })
    }
    if (grant_type === "refresh_token") {
      const rt = form.get("refresh_token")?.toString() ?? ""
      const existing = refreshTokens.get(rt)
      if (!existing) return json({ error: "invalid_grant" }, { status: 400 })
      // rotate
      refreshTokens.delete(rt)
      tokens.delete(existing.access_token)
      const access_token = "mocka_" + rnd(24)
      const refresh_token = "mockr_" + rnd(24)
      const tok: Token = { ...existing, access_token, refresh_token, expiresAt: Date.now() + 3600 * 1000 }
      tokens.set(access_token, tok)
      refreshTokens.set(refresh_token, tok)
      return json({
        access_token,
        refresh_token,
        token_type: "Bearer",
        expires_in: 3600,
        scope: tok.scope,
      })
    }
    return json({ error: "unsupported_grant_type" }, { status: 400 })
  },

  // MCP endpoint — minimal JSON-RPC 2.0 / streamable HTTP. Requires bearer.
  "POST /mcp": async (req) => {
    const auth = req.headers.get("authorization") ?? ""
    if (!auth.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${PUBLIC_BASE}"` } })
    }
    const token = auth.slice(7)
    if (!tokens.has(token)) {
      return new Response("Unauthorized", { status: 401 })
    }
    let payload: any
    try {
      payload = await req.json()
    } catch {
      return json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }, { status: 400 })
    }
    const id = payload.id ?? null
    const method = payload.method
    if (method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "mock-mcp", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      })
    }
    if (method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "mock_echo",
              description: "Echoes back the input — a smoke test for OAuth-protected MCP.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      })
    }
    if (method === "tools/call") {
      const name = payload.params?.name
      const args = payload.params?.arguments ?? {}
      if (name === "mock_echo") {
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `mock-mcp echoes: ${String(args.text ?? "")}` }],
          },
        })
      }
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } })
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 204 })
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } })
  },

  "GET /": () =>
    html(`
<!doctype html><meta charset="utf-8"/>
<title>mock-mcp</title>
<style>body{font:14px system-ui;padding:2em;max-width:700px;margin:auto;line-height:1.5}</style>
<h1>mock-mcp dev server</h1>
<p>Running on <code>${PUBLIC_BASE}</code>. Endpoints:</p>
<ul>
<li><code>GET /.well-known/oauth-protected-resource</code></li>
<li><code>GET /.well-known/oauth-authorization-server</code></li>
<li><code>POST /oauth/register</code></li>
<li><code>GET /oauth/authorize</code></li>
<li><code>POST /oauth/token</code></li>
<li><code>POST /mcp</code> (Bearer required)</li>
</ul>
<p>In your loopat workspace claude.json, add:</p>
<pre>{
  "mcpServers": {
    "mock": {
      "type": "http",
      "url": "${PUBLIC_BASE}/mcp"
    }
  }
}</pre>
`),
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url)
    const key = `${req.method} ${url.pathname}`
    const h = handlers[key]
    if (!h) return new Response("not found", { status: 404 })
    try {
      return h(req, url)
    } catch (e: any) {
      console.error(`[mock-mcp] handler error ${key}:`, e)
      return new Response("server error", { status: 500 })
    }
  },
})

console.log(`[mock-mcp] listening on http://${HOST}:${PORT}  (public base: ${PUBLIC_BASE})`)
console.log(`[mock-mcp] add the snippet at ${PUBLIC_BASE}/ to your workspace claude.json`)
