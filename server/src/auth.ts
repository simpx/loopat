/**
 * Account system — single-workspace MVP.
 *
 * users.json (at LOOPAT_HOME/users.json):
 *   { users: [{ id, salt, hash, personalRepo?, createdAt }] }
 *
 * Sessions are an in-memory Map<token, userId>; server restart logs everyone
 * out. Cookie is HttpOnly + SameSite=Lax, opaque token (no signing — single
 * machine, no production claims).
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import type { Context, MiddlewareHandler } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { usersPath, workspaceDir } from "./paths"

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

export const COOKIE_NAME = "loopat_session"
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

// in-memory session map
const sessions = new Map<string, string>()  // token → userId

export function createSession(userId: string): string {
  const token = randomUUID()
  sessions.set(token, userId)
  return token
}

export function destroySession(token: string): void {
  sessions.delete(token)
}

export function lookupSession(token: string): string | null {
  return sessions.get(token) ?? null
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
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
