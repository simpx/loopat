/**
 * Chat module: SQLite-backed channels + 1:1 DMs.
 *
 * Storage of record is chat.db (bun:sqlite) at LOOPAT_HOME/chat.db.
 * AI never reads the DB; when a loop is spawned from a chat conv, the
 * relevant messages are dumped to a per-loop jsonl snapshot at
 * loops/<id>/context/chat/<convId>.jsonl (last 1024 messages).
 *
 * Permissions (v0):
 *   - any auth user reads any channel and posts to any channel
 *   - any auth user creates channels; only admin deletes
 *   - DMs are strictly 1:1, visible only to the two parties
 */
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { chatDbPath } from "./paths"

export type ConvKind = "channel" | "dm"

export type Conversation = {
  id: string
  kind: ConvKind
  name: string | null
  topic: string | null
  createdBy: string
  createdAt: number
  dmUserA: string | null
  dmUserB: string | null
}

export type Message = {
  id: number
  convId: string
  author: string
  text: string
  ts: number
}

export type ConversationWithUnread = Conversation & {
  unread: number
  lastMessageTs: number | null
  /** For DMs, the "display name" is the other party. */
  peerUserId: string | null
}

let _db: Database | null = null

function db(): Database {
  if (_db) return _db
  const path = chatDbPath()
  // mkdir parent in case LOOPAT_HOME doesn't exist yet (bootstrap order).
  // ensureWorkspaceDirs runs before chat is used, but be defensive.
  const d = new Database(path, { create: true })
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('channel','dm')),
      name        TEXT,
      topic       TEXT,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      deleted_at  INTEGER,
      dm_user_a   TEXT,
      dm_user_b   TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conv_channel_name
      ON conversations(name) WHERE kind = 'channel' AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS conv_dm_pair
      ON conversations(dm_user_a, dm_user_b) WHERE kind = 'dm';

    CREATE TABLE IF NOT EXISTS messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      author   TEXT NOT NULL,
      text     TEXT NOT NULL,
      ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS msg_conv_id_idx ON messages(conv_id, id);

    CREATE TABLE IF NOT EXISTS reads (
      user_id      TEXT NOT NULL,
      conv_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      last_read_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, conv_id)
    );
  `)
  _db = d
  return d
}

function rowToConv(r: any): Conversation {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    topic: r.topic,
    createdBy: r.created_by,
    createdAt: r.created_at,
    dmUserA: r.dm_user_a,
    dmUserB: r.dm_user_b,
  }
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    convId: r.conv_id,
    author: r.author,
    text: r.text,
    ts: r.ts,
  }
}

function isValidChannelName(name: string): boolean {
  // lowercase letters, digits, dash, underscore. 1–32 chars. Slack-like.
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)
}

// ── channels ──────────────────────────────────────────────────────────────

export function listChannels(): Conversation[] {
  const rows = db()
    .query<any, []>(
      `SELECT * FROM conversations
       WHERE kind = 'channel' AND deleted_at IS NULL
       ORDER BY name ASC`,
    )
    .all()
  return rows.map(rowToConv)
}

export function createChannel(opts: { name: string; topic?: string; createdBy: string }): { ok: true; conv: Conversation } | { ok: false; error: string } {
  const name = opts.name.trim().toLowerCase().replace(/^#/, "")
  if (!isValidChannelName(name)) {
    return { ok: false, error: "channel name must be lowercase letters/digits/-/_, 1-32 chars, start with letter/digit" }
  }
  const existing = db().query<any, [string]>(
    `SELECT * FROM conversations WHERE kind = 'channel' AND name = ? AND deleted_at IS NULL`,
  ).get(name)
  if (existing) return { ok: false, error: "channel exists" }
  const id = `c-${randomUUID()}`
  const now = Date.now()
  db().run(
    `INSERT INTO conversations (id, kind, name, topic, created_by, created_at)
     VALUES (?, 'channel', ?, ?, ?, ?)`,
    [id, name, opts.topic?.trim() || null, opts.createdBy, now],
  )
  return { ok: true, conv: rowToConv(db().query<any, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(id)) }
}

export function deleteChannel(id: string): boolean {
  const r = db().run(
    `UPDATE conversations SET deleted_at = ? WHERE id = ? AND kind = 'channel' AND deleted_at IS NULL`,
    [Date.now(), id],
  )
  return r.changes > 0
}

// ── DMs ───────────────────────────────────────────────────────────────────

/** Normalize the (a, b) tuple so DB lookup is canonical regardless of caller order. */
function normalizeDmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export function getOrCreateDm(userA: string, userB: string, createdBy: string): Conversation {
  if (userA === userB) throw new Error("cannot DM yourself")
  const [a, b] = normalizeDmPair(userA, userB)
  const existing = db()
    .query<any, [string, string]>(
      `SELECT * FROM conversations WHERE kind = 'dm' AND dm_user_a = ? AND dm_user_b = ?`,
    )
    .get(a, b)
  if (existing) return rowToConv(existing)
  const id = `d-${randomUUID()}`
  const now = Date.now()
  db().run(
    `INSERT INTO conversations (id, kind, created_by, created_at, dm_user_a, dm_user_b)
     VALUES (?, 'dm', ?, ?, ?, ?)`,
    [id, createdBy, now, a, b],
  )
  return rowToConv(db().query<any, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(id))
}

export function getConv(id: string): Conversation | null {
  const r = db().query<any, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(id)
  return r ? rowToConv(r) : null
}

/** Permission check: can `userId` read/write this conversation? */
export function userCanAccess(conv: Conversation, userId: string): boolean {
  if (conv.kind === "channel") return conv.createdAt > 0 // any auth user
  return conv.dmUserA === userId || conv.dmUserB === userId
}

/** All conversations visible to `userId`: every channel + every DM they're in. */
export function listConversationsForUser(userId: string): ConversationWithUnread[] {
  const rows = db()
    .query<any, [string, string, string]>(
      `SELECT c.*,
              (SELECT MAX(ts) FROM messages WHERE conv_id = c.id) AS last_ts,
              (SELECT MAX(id) FROM messages WHERE conv_id = c.id) AS last_msg_id,
              COALESCE((SELECT last_read_id FROM reads WHERE user_id = ? AND conv_id = c.id), 0) AS last_read_id
         FROM conversations c
        WHERE c.deleted_at IS NULL
          AND (
            c.kind = 'channel'
            OR c.dm_user_a = ?
            OR c.dm_user_b = ?
          )`,
    )
    .all(userId, userId, userId)
  return rows.map((r) => {
    const conv = rowToConv(r)
    const lastId = r.last_msg_id ?? 0
    const lastRead = r.last_read_id ?? 0
    const unread = lastId > lastRead
      ? (db().query<{ n: number }, [string, number]>(
          `SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND id > ?`,
        ).get(conv.id, lastRead)?.n ?? 0)
      : 0
    let peer: string | null = null
    if (conv.kind === "dm") {
      peer = conv.dmUserA === userId ? conv.dmUserB : conv.dmUserA
    }
    return {
      ...conv,
      unread,
      lastMessageTs: r.last_ts ?? null,
      peerUserId: peer,
    }
  })
}

// ── messages ──────────────────────────────────────────────────────────────

export function listMessages(convId: string, opts: { before?: number; limit?: number } = {}): Message[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const before = opts.before
  let rows: any[]
  if (before && before > 0) {
    rows = db()
      .query<any, [string, number, number]>(
        `SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(convId, before, limit)
  } else {
    rows = db()
      .query<any, [string, number]>(
        `SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(convId, limit)
  }
  // Return chronological (oldest → newest) — convenient for UI append.
  return rows.reverse().map(rowToMessage)
}

export function postMessage(convId: string, author: string, text: string): Message {
  const trimmed = text.replace(/\r\n/g, "\n")
  if (!trimmed.trim()) throw new Error("empty message")
  const ts = Date.now()
  const r = db().run(
    `INSERT INTO messages (conv_id, author, text, ts) VALUES (?, ?, ?, ?)`,
    [convId, author, trimmed, ts],
  )
  return {
    id: Number(r.lastInsertRowid),
    convId,
    author,
    text: trimmed,
    ts,
  }
}

export function markRead(userId: string, convId: string, lastReadId: number): void {
  db().run(
    `INSERT INTO reads (user_id, conv_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, conv_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    [userId, convId, lastReadId],
  )
}

// ── jsonl snapshot (for spawn-loop-from-chat) ─────────────────────────────

/**
 * Dump the most-recent `limit` messages from a conversation to a jsonl file.
 * Output rows are chronological (oldest → newest), one JSON per line:
 *   {"ts":"2026-05-16T10:42:00.000Z","author":"simpx","text":"..."}
 *
 * This is a one-shot snapshot. The loop owns its own copy from this moment
 * on; subsequent channel activity does not propagate.
 */
export async function snapshotConvToJsonl(
  convId: string,
  destPath: string,
  limit = 1024,
): Promise<{ messageCount: number }> {
  const rows = db()
    .query<any, [string, number]>(
      `SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(convId, Math.min(Math.max(limit, 1), 10000))
  const chronological = rows.reverse().map(rowToMessage)
  const lines = chronological.map((m) =>
    JSON.stringify({
      ts: new Date(m.ts).toISOString(),
      author: m.author,
      text: m.text,
    }),
  )
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, lines.join("\n") + (lines.length ? "\n" : ""))
  return { messageCount: chronological.length }
}

// ── bootstrap ─────────────────────────────────────────────────────────────

/** Run once on server startup. Opens the DB (creating schema) and seeds a
 *  default `#general` channel if no channels exist. */
export function initChat(bootstrapUser: string): void {
  db() // open + migrate
  const count = db()
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM conversations WHERE kind = 'channel' AND deleted_at IS NULL`,
    )
    .get()?.n ?? 0
  if (count === 0 && bootstrapUser) {
    createChannel({ name: "general", topic: "workspace-wide chatter", createdBy: bootstrapUser })
  }
}
