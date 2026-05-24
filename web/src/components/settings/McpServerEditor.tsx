import { useEffect, useState } from "react"
import { Plus, Trash2, Server, Zap } from "lucide-react"

// ── parsers for quick-add ──

/** Try to parse CLI input: `claude mcp add <name> <url> [-t <type>] [-H "K: V"]` */
function parseCli(input: string): McpServerRow | null {
  const s = input.trim()
  if (!s.includes("claude") || !s.includes("mcp") || !s.includes("add")) return null

  // Split into tokens respecting quoted strings
  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    if (s[i] === " " || s[i] === "\t") { i++; continue }
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i]
      const end = s.indexOf(quote, i + 1)
      if (end === -1) { tokens.push(s.slice(i + 1)); break }
      tokens.push(s.slice(i + 1, end))
      i = end + 1
    } else {
      let j = i
      while (j < s.length && s[j] !== " " && s[j] !== "\t") j++
      tokens.push(s.slice(i, j))
      i = j
    }
  }

  // Find "add" and take name + url after it
  const addIdx = tokens.findIndex((t) => t === "add")
  if (addIdx === -1 || addIdx + 2 >= tokens.length) return null

  const name = tokens[Math.min(addIdx + 1, tokens.length - 1)]
  const second = tokens[Math.min(addIdx + 2, tokens.length - 1)]

  // Determine if second token is URL or command
  let url = ""
  let command = ""
  let type: McpServerRow["type"] = "stdio"
  const headers: string[] = []
  const envs: string[] = []

  if (second.startsWith("http://") || second.startsWith("https://")) {
    url = second
    type = "http"
  } else if (!second.startsWith("-")) {
    command = second
  }

  for (let ti = addIdx + 3; ti < tokens.length; ti++) {
    const t = tokens[ti]
    if (t === "-t" || t === "--type") {
      const v = tokens[++ti]
      if (v === "http" || v === "sse" || v === "stdio") type = v
    } else if (t === "-H" || t === "--header") {
      headers.push(tokens[++ti] ?? "")
    } else if (t === "-e" || t === "--env") {
      envs.push(tokens[++ti] ?? "")
    } else if (t === "-a" || t === "--args") {
      // args follow — collect until next flag
    } else if (!t.startsWith("-")) {
      if (!command) command = t
    }
  }

  return {
    name,
    type,
    url,
    command,
    args: "",
    env: envs.join("\n"),
    headers: headers.join("\n"),
  }
}

/** Try to parse JSON input: { "mcpServers": { "name": { ... } } } */
function parseJson(input: string): McpServerRow | null {
  try {
    const obj = JSON.parse(input.trim())
    // Handle both { mcpServers: { name: {...} } } and just { name: {...} }
    let servers: Record<string, any>
    if (obj.mcpServers) {
      servers = obj.mcpServers
    } else if (obj.mcp) {
      servers = obj.mcp
    } else if (typeof Object.values(obj)[0] === "object" && Object.values(obj)[0] !== null && !Array.isArray(Object.values(obj)[0])) {
      servers = obj
    } else {
      return null
    }
    const [name, srv] = Object.entries(servers)[0] ?? []
    if (!name || !srv || typeof srv !== "object") return null

    const type = srv?.type === "http" || srv?.type === "sse" || srv?.type === "remote" ? "http" as const
      : srv?.type === "sse" ? "sse" as const
      : "stdio" as const

    return {
      name,
      type,
      url: srv?.url ?? "",
      command: srv?.command ?? "",
      args: srv?.args ? (Array.isArray(srv.args) ? srv.args.join(" ") : String(srv.args)) : "",
      env: srv?.env ? Object.entries(srv.env).map(([k, v]) => `${k}=${v}`).join("\n") : "",
      headers: srv?.headers ? Object.entries(srv.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "",
    }
  } catch {
    return null
  }
}

function parseQuickAdd(input: string): McpServerRow | null {
  return parseJson(input) ?? parseCli(input)
}

export type McpServerRow = {
  name: string
  type: "stdio" | "http" | "sse"
  url: string
  command: string
  args: string
  env: string
  headers: string
}

function emptyRow(): McpServerRow {
  return { name: "", type: "stdio", url: "", command: "", args: "", env: "", headers: "" }
}

function rowFromJson(name: string, srv: any): McpServerRow {
  return {
    name,
    type: (srv?.type === "http" || srv?.type === "sse" || srv?.type === "remote") ? "http" : "stdio",
    url: srv?.url ?? "",
    command: srv?.command ?? "",
    args: srv?.args ? (Array.isArray(srv.args) ? srv.args.join(" ") : String(srv.args)) : "",
    env: srv?.env ? Object.entries(srv.env).map(([k, v]) => `${k}=${v}`).join("\n") : "",
    headers: srv?.headers ? Object.entries(srv.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "",
  }
}

function rowToJson(r: McpServerRow): any {
  if (r.type === "http" || r.type === "sse") {
    const out: any = { type: r.type, url: r.url }
    if (r.headers.trim()) {
      out.headers = Object.fromEntries(
        r.headers.split("\n").filter(Boolean).map((line) => {
          const colon = line.indexOf(":")
          return colon >= 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] : [line.trim(), ""]
        }),
      )
    }
    return out
  }
  const out: any = { command: r.command }
  if (r.args.trim()) out.args = r.args.split(/\s+/)
  if (r.env.trim()) {
    out.env = Object.fromEntries(
      r.env.split("\n").filter(Boolean).map((line) => {
        const eq = line.indexOf("=")
        return eq >= 0 ? [line.slice(0, eq), line.slice(eq + 1)] : [line, ""]
      }),
    )
  }
  return out
}

export function mcpServersFromJson(obj: Record<string, any> | null): Map<string, any> {
  if (!obj?.mcpServers) return new Map()
  return new Map(Object.entries(obj.mcpServers))
}

export function McpServerEditor({
  servers,
  onChange,
  readonly,
}: {
  servers: Map<string, any>
  onChange: (servers: Record<string, any>) => void
  readonly?: boolean
}) {
  const buildRows = () => [...servers.entries()].map(([k, v]) => rowFromJson(k, v))
  const [rows, setRows] = useState<McpServerRow[]>(buildRows)
  const [adding, setAdding] = useState(false)
  const [newRow, setNewRow] = useState<McpServerRow>(emptyRow())
  const [editing, setEditing] = useState<number | null>(null)

  // Sync rows when servers prop changes (e.g. parent re-fetches data after save)
  useEffect(() => {
    setRows(buildRows())
    setEditing(null)
    setAdding(false)
  }, [servers])

  const emit = (rs: McpServerRow[]) => {
    setRows(rs)
    const out: Record<string, any> = {}
    for (const r of rs) {
      if (!r.name.trim()) continue
      out[r.name] = rowToJson(r)
    }
    onChange(out)
  }

  const update = (i: number, patch: Partial<McpServerRow>) => {
    emit(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  const remove = (i: number) => {
    emit(rows.filter((_, idx) => idx !== i))
    setEditing(null)
  }

  const commitAdd = () => {
    if (!newRow.name.trim()) return
    emit([...rows, newRow])
    setNewRow(emptyRow())
    setAdding(false)
  }

  if (rows.length === 0 && !adding) {
    return (
      <div className="py-3">
        <div className="flex flex-col items-center gap-1.5 text-center py-3">
          <Server size={18} className="text-gray-300" />
          <div className="text-[12px] text-gray-400">No MCP servers</div>
          <div className="text-[11px] text-gray-400/70">
            Add servers to extend Claude with external tools.
          </div>
        </div>
        {!readonly && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
          >
            <Plus size={13} />
            Add MCP server
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const isEditing = editing === i
        return (
          <ServerRow
            key={i}
            row={r}
            isEditing={isEditing}
            readonly={readonly}
            onEdit={() => setEditing(isEditing ? null : i)}
            onCommit={(patch) => {
              update(i, patch)
              if (!isEditing) setEditing(null)
            }}
            onRemove={() => remove(i)}
          />
        )
      })}

      {adding && (
        <div className="rounded-lg border border-gray-200 bg-blue-50/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={newRow.name}
              onChange={(e) => setNewRow((r) => ({ ...r, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") commitAdd(); if (e.key === "Escape") { setAdding(false); setNewRow(emptyRow()) } }}
              placeholder="server name"
              className="flex-1 min-w-0 border border-gray-300 rounded px-2.5 py-1.5 text-[12px] font-medium outline-none focus:border-gray-900 bg-white"
            />
            <select
              value={newRow.type}
              onChange={(e) => setNewRow((r) => ({ ...r, type: e.target.value as McpServerRow["type"] }))}
              className="w-20 shrink-0 border border-gray-300 rounded px-2 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </div>
          {newRow.type === "http" || newRow.type === "sse" ? (
            <input
              value={newRow.url}
              onChange={(e) => setNewRow((r) => ({ ...r, url: e.target.value }))}
              placeholder="https://example.com/mcp"
              className="ip text-[12px] w-full font-mono"
            />
          ) : (
            <div className="space-y-1.5">
              <input
                value={newRow.command}
                onChange={(e) => setNewRow((r) => ({ ...r, command: e.target.value }))}
                placeholder="command (e.g. npx, uvx)"
                className="ip text-[12px] w-full font-mono"
              />
              <input
                value={newRow.args}
                onChange={(e) => setNewRow((r) => ({ ...r, args: e.target.value }))}
                placeholder="args (space-separated)"
                className="ip text-[12px] w-full font-mono"
              />
              <textarea
                value={newRow.env}
                onChange={(e) => setNewRow((r) => ({ ...r, env: e.target.value }))}
                placeholder="env vars (KEY=val, one per line)"
                className="ip text-[12px] w-full font-mono resize-none h-14"
              />
            </div>
          )}
          {(newRow.type === "http" || newRow.type === "sse") && (
            <textarea
              value={newRow.headers}
              onChange={(e) => setNewRow((r) => ({ ...r, headers: e.target.value }))}
              placeholder="headers (Key: Value, one per line)"
              className="ip text-[12px] w-full font-mono resize-none h-14"
            />
          )}
          <div className="flex items-center gap-2">
            <button onClick={commitAdd} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => { setAdding(false); setNewRow(emptyRow()) }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {!readonly && (
        <>
          <QuickAdd onParse={(row) => { setNewRow(row); setAdding(true) }} />
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
          >
            <Plus size={13} />
            Add MCP server
          </button>
        </>
      )}
    </div>
  )
}

function ServerRow({
  row,
  isEditing,
  readonly,
  onEdit,
  onCommit,
  onRemove,
}: {
  row: McpServerRow
  isEditing: boolean
  readonly?: boolean
  onEdit: () => void
  onCommit: (patch: Partial<McpServerRow>) => void
  onRemove: () => void
}) {
  if (!isEditing) {
    return (
      <div
        className="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
        onClick={readonly ? undefined : onEdit}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${row.type === "stdio" ? "bg-purple-400" : "bg-blue-400"}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-gray-800 truncate">{row.name || <span className="text-gray-400 italic">unnamed</span>}</span>
            <span className="text-[10px] text-gray-400 uppercase shrink-0">{row.type}</span>
          </div>
          <div className="text-[11px] text-gray-400 truncate mt-0.5 font-mono">
            {row.type === "http" || row.type === "sse" ? row.url || "—" : row.command || "—"}
          </div>
        </div>
        {!readonly && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            className="shrink-0 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
            title="remove"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <input
          value={row.name}
          onChange={(e) => onCommit({ name: e.target.value })}
          placeholder="server name"
          className="flex-1 min-w-0 border border-gray-300 rounded px-2.5 py-1.5 text-[12px] font-medium outline-none focus:border-gray-900 bg-white"
        />
        <select
          value={row.type}
          onChange={(e) => onCommit({ type: e.target.value as McpServerRow["type"] })}
          className="w-20 shrink-0 border border-gray-300 rounded px-2 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
        <button onClick={onRemove} className="text-gray-300 hover:text-red-500 shrink-0" title="remove">
          <Trash2 size={13} />
        </button>
      </div>
      {row.type === "http" || row.type === "sse" ? (
        <input
          value={row.url}
          onChange={(e) => onCommit({ url: e.target.value })}
          placeholder="https://example.com/mcp"
          className="ip text-[12px] w-full font-mono"
        />
      ) : (
        <div className="space-y-1.5">
          <input
            value={row.command}
            onChange={(e) => onCommit({ command: e.target.value })}
            placeholder="command (e.g. npx, uvx)"
            className="ip text-[12px] w-full font-mono"
          />
          <input
            value={row.args}
            onChange={(e) => onCommit({ args: e.target.value })}
            placeholder="args (space-separated)"
            className="ip text-[12px] w-full font-mono"
          />
          <textarea
            value={row.env}
            onChange={(e) => onCommit({ env: e.target.value })}
            placeholder="env vars (KEY=val, one per line)"
            className="ip text-[12px] w-full font-mono resize-none h-14"
          />
        </div>
      )}
      {(row.type === "http" || row.type === "sse") && (
        <textarea
          value={row.headers}
          onChange={(e) => onCommit({ headers: e.target.value })}
          placeholder="headers (Key: Value, one per line)"
          className="ip text-[12px] w-full font-mono resize-none h-14"
        />
      )}
      <div className="flex items-center gap-2">
        <button onClick={onEdit} className="px-2.5 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Done</button>
      </div>
    </div>
  )
}

// ── quick-add: paste JSON or CLI command ──

function QuickAdd({ onParse }: { onParse: (row: McpServerRow) => void }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [err, setErr] = useState<string | null>(null)

  const handleParse = () => {
    const trimmed = input.trim()
    if (!trimmed) return
    setErr(null)
    const result = parseQuickAdd(trimmed)
    if (!result) {
      setErr("Couldn't parse. Paste a JSON object with mcpServers, or a `claude mcp add ...` command.")
      return
    }
    onParse(result)
    setInput("")
    setOpen(false)
    setErr(null)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
      >
        <Zap size={13} />
        Paste JSON / CLI
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Zap size={13} className="text-amber-500 shrink-0" />
        <span className="text-[12px] font-medium text-gray-700">Paste JSON or CLI command</span>
        <div className="flex-1" />
        <button onClick={() => { setOpen(false); setInput(""); setErr(null) }} className="text-[11px] text-gray-400 hover:text-gray-600">cancel</button>
      </div>
      <textarea
        autoFocus
        value={input}
        onChange={(e) => { setInput(e.target.value); setErr(null) }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleParse()
        }}
        placeholder={`Paste JSON:\n{ "mcpServers": { "name": { "type": "http", "url": "...", "headers": { "Key": "Value" } } } }\n\nOr CLI:\nclaude mcp add name url -t http -H "Key: Value"`}
        className="ip text-[12px] w-full font-mono resize-y min-h-[80px]"
        rows={4}
      />
      {err && (
        <div className="text-[11px] text-red-600">{err}</div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={handleParse} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Parse &amp; Fill</button>
        <span className="text-[10px] text-gray-400">or Ctrl+Enter</span>
      </div>
    </div>
  )
}
