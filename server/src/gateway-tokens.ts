/**
 * Per-user gateway tokens for the external runtime SSE API.
 *
 * Each loopat user can generate one or more gateway tokens. External callers
 * (Chimp, Slack bots, etc.) authenticate with `Authorization: Bearer <token>`
 * and the request runs under the token owner's identity — using their personal
 * provider config, vault, and API keys.
 *
 * Storage: `$LOOPAT_HOME/gateway-tokens.json`
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { LOOPAT_HOME } from "./paths"

export type GatewayToken = {
  token: string
  userId: string
  label: string
  createdAt: string
}

type TokensFile = {
  tokens: Record<string, GatewayToken>
}

const TOKENS_PATH = join(LOOPAT_HOME, "gateway-tokens.json")

let cached: TokensFile | null = null

async function readTokensFile(): Promise<TokensFile> {
  if (cached) return cached
  if (!existsSync(TOKENS_PATH)) {
    cached = { tokens: {} }
    return cached
  }
  try {
    const raw = await readFile(TOKENS_PATH, "utf8")
    const parsed = JSON.parse(raw) as TokensFile
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      cached = { tokens: {} }
      return cached
    }
    cached = parsed
    return cached
  } catch {
    cached = { tokens: {} }
    return cached
  }
}

async function writeTokensFile(data: TokensFile): Promise<void> {
  await mkdir(dirname(TOKENS_PATH), { recursive: true })
  await writeFile(TOKENS_PATH, JSON.stringify(data, null, 2) + "\n")
  cached = data
}

function generateTokenValue(): string {
  return `gw-${randomBytes(24).toString("hex")}`
}

/**
 * Resolve the loopat userId from an `Authorization: Bearer <token>` header.
 *
 * Looks up the token in gateway-tokens.json. Returns the owning userId
 * or `null` if the token is missing / not found.
 */
export async function resolveGatewayUser(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null
  const bearerToken = authHeader.slice("Bearer ".length).trim()
  if (!bearerToken) return null

  const file = await readTokensFile()
  const entry = file.tokens[bearerToken]
  return entry?.userId ?? null
}

/**
 * Create a new gateway token for a user.
 */
export async function createGatewayToken(userId: string, label: string): Promise<GatewayToken> {
  const file = await readTokensFile()
  const token = generateTokenValue()
  const entry: GatewayToken = {
    token,
    userId,
    label: (label || "").trim() || "default",
    createdAt: new Date().toISOString(),
  }
  file.tokens[token] = entry
  await writeTokensFile(file)
  return entry
}

/**
 * List all gateway tokens for a specific user. Token values are masked
 * (only last 8 chars shown) for security — the full token is only returned
 * at creation time.
 */
export async function listGatewayTokens(userId: string): Promise<Array<{
  tokenHint: string
  label: string
  createdAt: string
}>> {
  const file = await readTokensFile()
  return Object.values(file.tokens)
    .filter((entry) => entry.userId === userId)
    .map((entry) => ({
      tokenHint: `gw-..${entry.token.slice(-8)}`,
      label: entry.label,
      createdAt: entry.createdAt,
    }))
}

/**
 * Revoke a gateway token. Matches by token suffix (last 8 chars) + userId
 * to allow deletion without exposing full token values.
 *
 * Returns true if a token was deleted.
 */
export async function revokeGatewayToken(userId: string, tokenHint: string): Promise<boolean> {
  const suffix = tokenHint.replace(/^gw-\.\./, "").slice(-8)
  if (!suffix) return false

  const file = await readTokensFile()
  const matchKey = Object.keys(file.tokens).find((key) => {
    const entry = file.tokens[key]
    return entry.userId === userId && key.endsWith(suffix)
  })
  if (!matchKey) return false

  delete file.tokens[matchKey]
  await writeTokensFile(file)
  return true
}
