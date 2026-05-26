/**
 * Per-user API tokens for the v1 Loop API.
 *
 * Storage: `$LOOPAT_HOME/api-tokens.json`. Tokens are SHA-256 hashed at rest;
 * the plaintext (`la_<hex>`) is only returned to the caller at creation.
 *
 * Each entry has a stable `tokenId` (independent of the token value) so the
 * web UI can list / revoke without exposing or suffix-matching the secret.
 *
 * Writes are serialized via an in-process promise chain. loopat is
 * single-process so file-level locking isn't needed.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { LOOPAT_HOME } from "./paths"

const TOKENS_PATH = join(LOOPAT_HOME, "api-tokens.json")

type StoredToken = {
  tokenId: string         // stable short id, surfaced to UI
  userId: string
  label: string
  createdAt: string
  lastUsedAt?: string
}

type TokensFile = {
  // keyed by SHA-256(token plaintext)
  tokens: Record<string, StoredToken>
}

let cached: TokensFile | null = null

let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function generateTokenValue(): string {
  return `la_${randomBytes(24).toString("hex")}`
}

function generateTokenId(): string {
  return `tok_${randomBytes(6).toString("hex")}`
}

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
    } else {
      cached = parsed
    }
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

export type ApiTokenView = {
  tokenId: string
  label: string
  createdAt: string
  lastUsedAt?: string
}

/** Resolve `Authorization: Bearer la_...` to a userId, or null. */
export async function resolveApiToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null
  const bearerToken = authHeader.slice("Bearer ".length).trim()
  if (!bearerToken || !bearerToken.startsWith("la_")) return null
  const file = await readTokensFile()
  const entry = file.tokens[hashToken(bearerToken)]
  if (!entry) return null
  // Best-effort lastUsedAt update; don't block resolution on it.
  withWriteLock(async () => {
    const f = await readTokensFile()
    const h = hashToken(bearerToken)
    if (f.tokens[h]) {
      f.tokens[h].lastUsedAt = new Date().toISOString()
      await writeTokensFile(f)
    }
  }).catch(() => {})
  return entry.userId
}

export async function createApiToken(userId: string, label: string): Promise<{
  tokenId: string
  token: string
  label: string
  createdAt: string
}> {
  return withWriteLock(async () => {
    const file = await readTokensFile()
    const token = generateTokenValue()
    const tokenId = generateTokenId()
    const stored: StoredToken = {
      tokenId,
      userId,
      label: (label || "").trim() || "default",
      createdAt: new Date().toISOString(),
    }
    file.tokens[hashToken(token)] = stored
    await writeTokensFile(file)
    return { tokenId, token, label: stored.label, createdAt: stored.createdAt }
  })
}

export async function listApiTokens(userId: string): Promise<ApiTokenView[]> {
  const file = await readTokensFile()
  return Object.values(file.tokens)
    .filter((t) => t.userId === userId)
    .map((t) => ({
      tokenId: t.tokenId,
      label: t.label,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }))
    .sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  return withWriteLock(async () => {
    const file = await readTokensFile()
    const hash = Object.keys(file.tokens).find((h) => {
      const t = file.tokens[h]
      return t.userId === userId && t.tokenId === tokenId
    })
    if (!hash) return false
    delete file.tokens[hash]
    await writeTokensFile(file)
    return true
  })
}

/** Revoke every token belonging to a user. Returns count revoked. Used by
 *  cascade on account deletion. */
export async function revokeAllApiTokens(userId: string): Promise<number> {
  return withWriteLock(async () => {
    const file = await readTokensFile()
    let revoked = 0
    for (const hash of Object.keys(file.tokens)) {
      if (file.tokens[hash].userId === userId) {
        delete file.tokens[hash]
        revoked++
      }
    }
    if (revoked > 0) await writeTokensFile(file)
    return revoked
  })
}

/** For tests only — drops the in-memory cache. */
export function _resetCache(): void {
  cached = null
}
