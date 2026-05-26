/**
 * Account system — single-workspace MVP.
 *
 * users.json (at LOOPAT_HOME/users.json):
 *   { users: [{ id, salt, hash, role, status, personalRepo?, createdAt, activatedAt? }] }
 *
 * Open registration: anyone can register. New accounts default to
 * role:"member", status:"pending" and must be activated by an admin before
 * login is allowed. The first account ever to register bootstraps as
 * role:"admin", status:"active" so the system isn't unreachable.
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

export type UserRole = "admin" | "member"
export type UserStatus = "active" | "pending"

export type User = {
  id: string
  /** scrypt salt + hash. Empty strings for token-only accounts (no password). */
  salt: string
  hash: string
  role: UserRole
  status: UserStatus
  personalRepo?: string
  createdAt: string
  activatedAt?: string
  /**
   * Account ownership. `null` (or missing) means this is a personal account —
   * the human who owns it logs in via password. A non-null value points at
   * another user.id who manages this account. Owned accounts can only be
   * accessed via API token (no password login), cannot own further accounts
   * (no nesting), and cannot issue tokens (only their owner can).
   *
   * Naming convention: shares the flat global namespace with personal users.
   * Whoever registers a name first owns it.
   */
  ownerId?: string | null
}

export type PublicUser = {
  id: string
  role: UserRole
  status: UserStatus
  personalRepo?: string
  createdAt: string
  activatedAt?: string
  ownerId?: string | null
}

function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    role: u.role,
    status: u.status,
    personalRepo: u.personalRepo,
    createdAt: u.createdAt,
    activatedAt: u.activatedAt,
    ownerId: u.ownerId ?? null,
  }
}

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
  return f.users.map(toPublic)
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

/**
 * Open registration. Anyone with a valid username + password can create an
 * account. New accounts default to status:"pending" — they cannot log in
 * until an admin activates them. The very first account ever created
 * bootstraps as role:"admin", status:"active" so the system is reachable
 * without manual seeding.
 */
export async function createUser(input: {
  id: string
  /** Password for personal accounts. Omit for owned (token-only) accounts. */
  password?: string
  personalRepo?: string
  /** If set, this account is owned by another user (a "public account").
   *  No password is stored; access is API-token only. */
  ownerId?: string | null
}): Promise<User> {
  if (!isValidUsername(input.id)) throw new Error("invalid username (lowercase a-z0-9_- , 1-32 chars, leading alnum)")
  const f = await readUsersFile()
  if (f.users.some((u) => u.id === input.id)) throw new Error("username taken")
  const isOwned = !!input.ownerId
  if (isOwned) {
    const owner = f.users.find((u) => u.id === input.ownerId)
    if (!owner) throw new Error(`owner not found: ${input.ownerId}`)
    if (owner.ownerId) throw new Error("cannot own from a non-personal account (no nesting)")
    if (input.password) throw new Error("owned accounts cannot have a password")
  } else {
    if (!input.password || input.password.length < 1) throw new Error("password required")
  }
  const { salt, hash } = isOwned
    ? { salt: "", hash: "" }
    : await hashPassword(input.password!)
  const isFirst = f.users.length === 0
  const now = new Date().toISOString()
  const user: User = {
    id: input.id,
    salt,
    hash,
    // Owned accounts: always member, never first-admin special-cased.
    role: isOwned ? "member" : (isFirst ? "admin" : "member"),
    // Owned accounts: active immediately (their owner is the real human, already vetted).
    status: isOwned ? "active" : (isFirst ? "active" : "pending"),
    personalRepo: input.personalRepo?.trim() || undefined,
    createdAt: now,
    activatedAt: (isOwned || isFirst) ? now : undefined,
    ownerId: input.ownerId ?? undefined,
  }
  await writeUsersFile({ users: [...f.users, user] })
  return user
}

export async function activateUser(id: string): Promise<User | null> {
  const f = await readUsersFile()
  const idx = f.users.findIndex((u) => u.id === id)
  if (idx < 0) return null
  if (f.users[idx].status === "active") return f.users[idx]
  const updated: User = { ...f.users[idx], status: "active", activatedAt: new Date().toISOString() }
  const users = f.users.slice()
  users[idx] = updated
  await writeUsersFile({ users })
  return updated
}

export async function setUserRole(id: string, role: UserRole): Promise<User | null> {
  const f = await readUsersFile()
  const idx = f.users.findIndex((u) => u.id === id)
  if (idx < 0) return null
  const target = f.users[idx]
  if (target.role === role) return target
  if (target.role === "admin" && role !== "admin") {
    const adminCount = f.users.filter((u) => u.role === "admin").length
    if (adminCount <= 1) throw new Error("cannot demote the last admin")
  }
  const updated: User = { ...target, role }
  const users = f.users.slice()
  users[idx] = updated
  await writeUsersFile({ users })
  return updated
}

/**
 * Remove a user from users.json. Does NOT touch personal/<id>/ on disk —
 * data is preserved for safety. Caller must guard against self-delete and
 * last-admin removal at the route layer (see /api/admin/users/:id).
 */
export async function deleteUser(id: string): Promise<boolean> {
  const f = await readUsersFile()
  const idx = f.users.findIndex((u) => u.id === id)
  if (idx < 0) return false
  const target = f.users[idx]
  if (target.role === "admin") {
    const adminCount = f.users.filter((u) => u.role === "admin").length
    if (adminCount <= 1) throw new Error("cannot delete the last admin")
  }
  const users = f.users.filter((u) => u.id !== id)
  await writeUsersFile({ users })
  // Drop any sessions belonging to this user so the deletion is immediate.
  for (const [token, uid] of sessions.entries()) {
    if (uid === id) sessions.delete(token)
  }
  await saveSessions()
  return true
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

/**
 * Hono middleware: requires the session user to be role:"admin".
 * Layer this *after* requireAuth (or on its own — it re-checks the cookie).
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const userId = getRequestUserId(c)
  if (!userId) return c.json({ error: "unauthorized" }, 401)
  const user = await findUser(userId)
  if (!user || user.role !== "admin") return c.json({ error: "forbidden" }, 403)
  c.set("userId", userId)
  await next()
}
