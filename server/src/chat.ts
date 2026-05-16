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
  /** NULL = thread root (a top-level message); otherwise the root msg id this
   *  reply belongs to. Slack-style single-level threading — replies cannot be
   *  replied to (we reject parent_id on a message that already has one). */
  parentId: number | null
}

/** Thread root surfaced in the main feed. Carries denormalized reply stats
 *  so the UI can render "💬 N replies" without a per-row roundtrip. */
export type ThreadRoot = Message & {
  replyCount: number
  lastReplyTs: number | null
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
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      author    TEXT NOT NULL,
      text      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS msg_conv_id_idx ON messages(conv_id, id);

    CREATE TABLE IF NOT EXISTS reads (
      user_id      TEXT NOT NULL,
      conv_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      last_read_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, conv_id)
    );
  `)
  // Migrate DBs created before parent_id existed. SQLite has no
  // IF NOT EXISTS on ADD COLUMN, so swallow the duplicate-column error.
  // MUST run before the partial index below — `WHERE parent_id IS NOT NULL`
  // fails to parse if the column isn't there yet.
  try {
    d.exec(`ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE`)
  } catch (e: any) {
    if (!/duplicate column/i.test(e?.message ?? "")) throw e
  }
  d.exec(`CREATE INDEX IF NOT EXISTS msg_parent_idx ON messages(parent_id, id) WHERE parent_id IS NOT NULL`)
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
    parentId: r.parent_id ?? null,
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

/** Main-feed listing: thread roots only. Each row carries denormalized
 *  reply_count + last_reply_ts via subqueries so the UI can render the
 *  "💬 N replies" affordance without a second roundtrip. */
export function listMessages(convId: string, opts: { before?: number; limit?: number } = {}): ThreadRoot[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const before = opts.before
  const select = `
    SELECT m.*,
           (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id) AS reply_count,
           (SELECT MAX(ts) FROM messages r WHERE r.parent_id = m.id) AS last_reply_ts
      FROM messages m
     WHERE m.conv_id = ? AND m.parent_id IS NULL`
  let rows: any[]
  if (before && before > 0) {
    rows = db()
      .query<any, [string, number, number]>(`${select} AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(convId, before, limit)
  } else {
    rows = db()
      .query<any, [string, number]>(`${select} ORDER BY m.id DESC LIMIT ?`)
      .all(convId, limit)
  }
  // Return chronological (oldest → newest) — convenient for UI append.
  return rows.reverse().map((r) => ({
    ...rowToMessage(r),
    replyCount: r.reply_count ?? 0,
    lastReplyTs: r.last_reply_ts ?? null,
  }))
}

/** Return a thread (root + all replies, chronological). null if the root id
 *  doesn't exist or is itself a reply (we don't surface "half threads"). */
export function listThread(rootId: number): { root: Message; replies: Message[] } | null {
  const rootRow = db().query<any, [number]>(`SELECT * FROM messages WHERE id = ?`).get(rootId)
  if (!rootRow || rootRow.parent_id != null) return null
  const replyRows = db()
    .query<any, [number]>(`SELECT * FROM messages WHERE parent_id = ? ORDER BY id ASC`)
    .all(rootId)
  return {
    root: rowToMessage(rootRow),
    replies: replyRows.map(rowToMessage),
  }
}

/** Post a message. If parentId is set, it must reference a top-level message
 *  in the same conv (no nested threads, no cross-conv replies). Returns the
 *  new message. */
export function postMessage(convId: string, author: string, text: string, parentId: number | null = null): Message {
  const trimmed = text.replace(/\r\n/g, "\n")
  if (!trimmed.trim()) throw new Error("empty message")
  if (parentId != null) {
    const parent = db().query<any, [number]>(`SELECT conv_id, parent_id FROM messages WHERE id = ?`).get(parentId)
    if (!parent) throw new Error("parent message not found")
    if (parent.conv_id !== convId) throw new Error("parent message belongs to another conversation")
    if (parent.parent_id != null) throw new Error("cannot reply to a reply (threads are single-level)")
  }
  const ts = Date.now()
  const r = db().run(
    `INSERT INTO messages (conv_id, author, text, ts, parent_id) VALUES (?, ?, ?, ?, ?)`,
    [convId, author, trimmed, ts, parentId],
  )
  return {
    id: Number(r.lastInsertRowid),
    convId,
    author,
    text: trimmed,
    ts,
    parentId,
  }
}

export function markRead(userId: string, convId: string, lastReadId: number): void {
  db().run(
    `INSERT INTO reads (user_id, conv_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, conv_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    [userId, convId, lastReadId],
  )
}

// ── jsonl snapshot (for spawn-loop-from-thread) ───────────────────────────

/**
 * Dump a thread (root + all replies) to a jsonl file, chronological order:
 *   {"ts":"2026-05-16T10:42:00.000Z","author":"simpx","text":"..."}
 *
 * A "thread" is the natural semantic unit for AI seeding — every top-level
 * message is a thread of length ≥ 1, so this works whether or not anyone
 * actually replied. Returns null if the root doesn't exist or is itself a
 * reply.
 */
export async function snapshotThreadToJsonl(
  rootId: number,
  destPath: string,
): Promise<{ messageCount: number; convId: string } | null> {
  const t = listThread(rootId)
  if (!t) return null
  const all = [t.root, ...t.replies]
  const lines = all.map((m) =>
    JSON.stringify({
      ts: new Date(m.ts).toISOString(),
      author: m.author,
      text: m.text,
    }),
  )
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, lines.join("\n") + (lines.length ? "\n" : ""))
  return { messageCount: all.length, convId: t.root.convId }
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
