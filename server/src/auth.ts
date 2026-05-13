/**
 * Account system — single-workspace MVP.
 *
 * users.json (at LOOPAT_HOME/users.json):
 *   { users: [{ id, salt, hash, personalRepo?, createdAt }] }
 *
 * Sessions persist to sessions.json so server restarts don't log everyone out.
 * Cookie is HttpOnly + SameSite=Lax + maxAge 30d.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import type { Context, MiddlewareHandler } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { join } from "node:path"
import { usersPath, workspaceDir } from "./paths"

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

export const COOKIE_NAME = "loopat_session"
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 // 30 days
const SCRYPT_KEYLEN = 64
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export type User = {
  id: string
  salt: string
  hash: string
  personalRepo?: string
  createdAt: string
}

export type PublicUser = { id: string }

type UsersFile = { users: User[] }
type SessionsFile = { sessions: Record<string, string> } // token → userId

let cached: UsersFile | null = null

async function readUsersFile(): Promise<UsersFile> {
  if (cached) return cached
  const path = usersPath()
  if (!existsSync(path)) {
    cached = { users: [] }
    return cached
  }
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as UsersFile
  if (!Array.isArray(parsed.users)) throw new Error("users.json: missing users array")
  cached = parsed
  return cached
}

async function writeUsersFile(data: UsersFile): Promise<void> {
  await mkdir(workspaceDir(), { recursive: true })
  await writeFile(usersPath(), JSON.stringify(data, null, 2) + "\n")
  cached = data
}

export async function listUsers(): Promise<PublicUser[]> {
  const f = await readUsersFile()
  return f.users.map((u) => ({ id: u.id }))
}

export async function findUser(id: string): Promise<User | null> {
  const f = await readUsersFile()
  return f.users.find((u) => u.id === id) ?? null
}

export async function hashPassword(password: string, salt?: string): Promise<{ salt: string; hash: string }> {
  const s = salt ?? randomBytes(16).toString("hex")
  const buf = await scrypt(password, s, SCRYPT_KEYLEN)
  return { salt: s, hash: buf.toString("hex") }
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const buf = await scrypt(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, "hex")
  if (buf.length !== expected.length) return false
  return timingSafeEqual(buf, expected)
}

export function isValidUsername(id: string): boolean {
  return USERNAME_RE.test(id)
}

export async function createUser(input: {
  id: string
  password: string
  personalRepo?: string
}): Promise<User> {
  if (!isValidUsername(input.id)) throw new Error("invalid username (lowercase a-z0-9_- , 1-32 chars, leading alnum)")
  if (!input.password || input.password.length < 1) throw new Error("password required")
  const f = await readUsersFile()
  if (f.users.some((u) => u.id === input.id)) throw new Error("username taken")
  const { salt, hash } = await hashPassword(input.password)
  const user: User = {
    id: input.id,
    salt,
    hash,
    personalRepo: input.personalRepo?.trim() || undefined,
    createdAt: new Date().toISOString(),
  }
  await writeUsersFile({ users: [...f.users, user] })
  return user
}

/**
 * Persist a user's personalRepo URL. Used when the user filled it in after
 * registration (via the import dialog). Idempotent — no-op if the value is
 * unchanged.
 */
export async function setPersonalRepo(userId: string, repoUrl: string): Promise<User | null> {
  const f = await readUsersFile()
  const idx = f.users.findIndex((u) => u.id === userId)
  if (idx < 0) return null
  const updated = { ...f.users[idx], personalRepo: repoUrl.trim() || undefined }
  const users = f.users.slice()
  users[idx] = updated
  await writeUsersFile({ users })
  return updated
}

// ── Persistent sessions (disk-backed, survives restarts) ──

function sessionsPath(): string {
  return join(workspaceDir(), "sessions.json")
}

const sessions = new Map<string, string>() // token → userId

async function loadSessions(): Promise<void> {
  const path = sessionsPath()
  if (!existsSync(path)) return
  try {
    const raw = await readFile(path, "utf8")
    const data = JSON.parse(raw) as SessionsFile
    for (const [token, userId] of Object.entries(data.sessions ?? {})) {
      sessions.set(token, userId)
    }
  } catch {}
}

async function saveSessions(): Promise<void> {
  await mkdir(workspaceDir(), { recursive: true })
  const data: SessionsFile = { sessions: Object.fromEntries(sessions) }
  await writeFile(sessionsPath(), JSON.stringify(data, null, 2) + "\n").catch(() => {})
}

// Load sessions from disk at import time
loadSessions()

export function createSession(userId: string): string {
  const token = randomUUID()
  sessions.set(token, userId)
  saveSessions()
  return token
}

export function destroySession(token: string): void {
  sessions.delete(token)
  saveSessions()
}

export function lookupSession(token: string): string | null {
  return sessions.get(token) ?? null
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" })
}

export function getRequestUserId(c: Context): string | null {
  const token = getCookie(c, COOKIE_NAME)
  if (!token) return null
  return lookupSession(token)
}

/**
 * Hono middleware: requires a valid session cookie. Sets `userId` on context
 * for downstream handlers (`c.get("userId")`).
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const userId = getRequestUserId(c)
  if (!userId) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", userId)
  await next()
}
