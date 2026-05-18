/**
 * Shared MCP status display, used by:
 *   - Settings → MCP tab (full panel with Connect / Disconnect)
 *   - /mcp slash command popover (compact view)
 *
 * Shows all MCP servers grouped by tier (Workspace, Personal). Each tier
 * lists its config file path so users know where to add servers, even when
 * the tier is empty.
 */
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Check, AlertTriangle, RefreshCw, Link2, Unlink, X, ExternalLink } from "lucide-react"
import {
  getMcpAuth,
  startMcpAuth,
  deleteMcpAuth,
  listMcpServers,
  type McpAuthStatus,
  type McpServerInventory,
} from "@/api"

type Variant = "settings" | "popover"

export function McpStatusPanel({
  variant,
  vault: vaultProp,
  onClose,
}: {
  variant: Variant
  vault?: string
  onClose?: () => void
}) {
  const navigate = useNavigate()
  const [inventory, setInventory] = useState<McpServerInventory | null>(null)
  const [status, setStatus] = useState<McpAuthStatus>({})
  const [vault, setVault] = useState<string>(vaultProp ?? "default")
  const [loading, setLoading] = useState(true)
  const [busyFor, setBusyFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [inv, st] = await Promise.all([listMcpServers(), getMcpAuth(vault)])
    setInventory(inv)
    setStatus(st)
    setLoading(false)
  }, [vault])

  useEffect(() => { refresh() }, [refresh])

  const connect = async (serverName: string) => {
    if (busyFor) return
    setBusyFor(serverName)
    setError(null)
    const r = await startMcpAuth(serverName, vault)
    setBusyFor(null)
    if (r.error || !r.authorizationUrl) {
      setError(r.error ?? "start failed")
      return
    }
    window.location.href = r.authorizationUrl
  }

  const disconnect = async (serverName: string) => {
    if (busyFor) return
    if (variant === "settings" && !confirm(`Disconnect ${serverName}?`)) return
    setBusyFor(serverName)
    await deleteMcpAuth(serverName, vault)
    setBusyFor(null)
    refresh()
  }

  const goSettings = () => {
    onClose?.()
    navigate(`/settings/mcp`)
  }

  return (
    <div className="text-sm">
      {/* Header (popover only) */}
      {variant === "popover" && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
          <div className="text-[13px] font-medium text-gray-700">MCP servers</div>
          <div className="flex items-center gap-1">
            <button onClick={refresh} className="p-1 text-gray-400 hover:text-gray-700 rounded" title="reload">
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded" title="close">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Vault selector (settings only) */}
      {variant === "settings" && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-[11px] font-medium text-gray-500">Vault:</label>
          <input
            type="text"
            value={vault}
            onChange={(e) => setVault(e.target.value)}
            className="px-2 py-1 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 w-32"
          />
          <button
            type="button"
            onClick={refresh}
            className="px-2 h-7 text-xs rounded text-gray-700 hover:bg-gray-100 flex items-center gap-1"
            title="reload"
          >
            <RefreshCw size={12} /> refresh
          </button>
        </div>
      )}

      {variant === "settings" && (
        <p className="text-[12px] text-gray-500 leading-relaxed mb-4">
          loopat performs the OAuth flow on your behalf — sandboxed CC processes
          receive pre-authenticated transports. Tokens are stored inside this
          vault (encrypted with git-crypt), so they travel with your personal repo.
        </p>
      )}

      {error && (
        <div className={`${variant === "settings" ? "mb-3" : "mx-3 mt-3"} rounded px-3 py-2 text-[12px] bg-red-50 text-red-800 border border-red-200`}>
          {error}
        </div>
      )}

      {loading && !inventory ? (
        <div className={`${variant === "settings" ? "" : "px-3 py-4"} text-[12px] text-gray-400`}>loading…</div>
      ) : (
        <div className={variant === "popover" ? "max-h-[60vh] overflow-y-auto" : ""}>
          {inventory?.tiers.map((tier) => (
            <div key={tier.id} className={variant === "popover" ? "py-2" : "mb-5"}>
              {/* Tier header */}
              <div className={`${variant === "popover" ? "px-3 py-1" : "mb-1.5"}`}>
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
                  {tier.label}
                </div>
                <div className="text-[11px] text-gray-400 font-mono mt-0.5 truncate">
                  {tier.path}
                </div>
              </div>

              {/* Empty state */}
              {tier.servers.length === 0 ? (
                <div className={`${variant === "popover" ? "px-3 py-1.5" : "py-2"} text-[12px] text-gray-400 italic`}>
                  No servers yet. Add to <code className="bg-gray-100 px-1 rounded font-mono text-[11px]">{tier.path}</code>.
                </div>
              ) : (
                <ServerRows
                  tier={tier.id}
                  servers={tier.servers}
                  status={status}
                  variant={variant}
                  busyFor={busyFor}
                  onConnect={connect}
                  onDisconnect={disconnect}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Popover footer with link to full settings */}
      {variant === "popover" && (
        <div className="border-t border-gray-200 px-3 py-2 flex items-center justify-between text-[11px]">
          <span className="text-gray-400">vault: {vault}</span>
          <button onClick={goSettings} className="text-gray-600 hover:text-gray-900 flex items-center gap-1">
            Settings → MCP <ExternalLink size={10} />
          </button>
        </div>
      )}
    </div>
  )
}

function ServerRows({
  tier,
  servers,
  status,
  variant,
  busyFor,
  onConnect,
  onDisconnect,
}: {
  tier: "workspace" | "personal"
  servers: import("@/api").McpServerEntry[]
  status: McpAuthStatus
  variant: Variant
  busyFor: string | null
  onConnect: (n: string) => void
  onDisconnect: (n: string) => void
}) {
  return (
    <div className={variant === "settings" ? "border border-gray-200 rounded overflow-hidden" : ""}>
      {servers.map((s, i) => {
        const st = status[s.name]
        const isConnected = !!st?.connected
        const isHttp = s.type === "http" || s.type === "sse"
        const needsAuth = isHttp && !isConnected
        const busy = busyFor === s.name

        return (
          <div
            key={s.name}
            className={
              variant === "settings"
                ? `flex items-center gap-3 px-3 py-2 ${i > 0 ? "border-t border-gray-100" : ""}`
                : "flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50"
            }
          >
            <span className="text-[14px] text-gray-300 leading-none">
              {isConnected ? "●" : needsAuth ? "○" : "·"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-gray-700 text-[13px]">{s.name}</span>
                <span className="text-[10px] text-gray-400 uppercase">{s.type}</span>
                {tier === "personal" && s.shadowsWorkspace && (
                  <span className="text-[10px] text-amber-600 bg-amber-50 px-1 rounded" title="shadows a same-named workspace entry">
                    shadows ws
                  </span>
                )}
              </div>
              {s.url && (
                <div className="text-[11px] text-gray-400 font-mono truncate">{s.url}</div>
              )}
            </div>
            <div className="shrink-0">
              {isConnected ? (
                <span className="text-[11px] text-green-700 inline-flex items-center gap-1">
                  <Check size={11} /> connected
                  {variant === "settings" && (
                    <button
                      onClick={() => onDisconnect(s.name)}
                      disabled={busy}
                      className="ml-2 px-1.5 h-6 text-[11px] rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <Unlink size={10} />
                    </button>
                  )}
                </span>
              ) : !isHttp ? (
                <span className="text-[11px] text-gray-400">stdio</span>
              ) : (
                <button
                  onClick={() => onConnect(s.name)}
                  disabled={busy}
                  className={`inline-flex items-center gap-1 text-[11px] ${
                    variant === "settings"
                      ? "px-2.5 h-7 rounded bg-gray-900 text-white hover:bg-gray-700"
                      : "px-2 h-6 rounded text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200"
                  } disabled:opacity-50`}
                >
                  <AlertTriangle size={10} />
                  {busy ? "connecting…" : "needs auth"}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
