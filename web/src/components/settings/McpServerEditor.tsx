import { useState } from "react"
import { Plus, Trash2, Server } from "lucide-react"

export type McpServerRow = {
  name: string
  type: "stdio" | "http" | "sse"
  url: string
  command: string
  args: string
  env: string
}

function emptyRow(): McpServerRow {
  return { name: "", type: "stdio", url: "", command: "", args: "", env: "" }
}

function rowFromJson(name: string, srv: any): McpServerRow {
  return {
    name,
    type: (srv?.type === "http" || srv?.type === "sse") ? srv.type : "stdio",
    url: srv?.url ?? "",
    command: srv?.command ?? "",
    args: srv?.args ? (Array.isArray(srv.args) ? srv.args.join(" ") : String(srv.args)) : "",
    env: srv?.env ? Object.entries(srv.env).map(([k, v]) => `${k}=${v}`).join("\n") : "",
  }
}

function rowToJson(r: McpServerRow): any {
  if (r.type === "http" || r.type === "sse") {
    return { type: r.type, url: r.url }
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
  const [rows, setRows] = useState<McpServerRow[]>(
    [...servers.entries()].map(([k, v]) => rowFromJson(k, v)),
  )
  const [adding, setAdding] = useState(false)
  const [newRow, setNewRow] = useState<McpServerRow>(emptyRow())
  const [editing, setEditing] = useState<number | null>(null)

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
              className="ip text-[12px] font-medium flex-1"
            />
            <select
              value={newRow.type}
              onChange={(e) => setNewRow((r) => ({ ...r, type: e.target.value as McpServerRow["type"] }))}
              className="ip text-[12px] w-20 shrink-0"
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
          <div className="flex items-center gap-2">
            <button onClick={commitAdd} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => { setAdding(false); setNewRow(emptyRow()) }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      )}

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
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-gray-800 truncate">{row.name}</span>
            <span className="text-[10px] text-gray-400 uppercase shrink-0">{row.type}</span>
          </div>
          <div className="text-[11px] text-gray-400 font-mono truncate mt-0.5">
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
      <div className="flex items-center gap-2">
        <input
          value={row.name}
          onChange={(e) => onCommit({ name: e.target.value })}
          placeholder="server name"
          className="ip text-[12px] font-medium flex-1"
        />
        <select
          value={row.type}
          onChange={(e) => onCommit({ type: e.target.value as McpServerRow["type"] })}
          className="ip text-[12px] w-20 shrink-0"
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
      <div className="flex items-center gap-2">
        <button onClick={onEdit} className="px-2.5 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Done</button>
      </div>
    </div>
  )
}
