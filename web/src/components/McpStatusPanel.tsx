/**
 * MCP servers popover, opened from the /mcp slash command.
 *
 * Single source: the loop's merged settings.json (team + profile + personal
 * + plugin defaults). Each row shows the `authed` badge (env file exists
 * for this server's Bearer template) and a "Re-authorize" / "Forget" pair
 * for OAuth-eligible HTTP/SSE servers. `authed` is existence-only, no
 * validity check — click Re-authorize if the token is rejected at runtime.
 *
 * Settings page no longer surfaces MCP tokens separately: tokens are
 * indistinguishable from other vault envs (per design).
 */
import { useCallback, useEffect, useState } from "react"
import { Check, AlertTriangle, RefreshCw, Link2, Unlink, X, RotateCw, ExternalLink, KeyRound } from "lucide-react"
import {
  startMcpAuth,
  listMcpServers,
  deleteEnv,
  restartLoopSession,
  parseMcpSetup,
  type McpServerEntry,
} from "@/api"

export function McpStatusPanel({
  onClose,
  loopId,
}: {
  onClose?: () => void
  /** Loop the popover is opened from. /mcp is loop-scoped — both the server
   *  list and any OAuth flow originate here. */
  loopId: string
}) {
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busyFor, setBusyFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadFlash, setReloadFlash] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const inv = await listMcpServers(loopId)
    setServers(inv.servers)
    setLoading(false)
  }, [loopId])

  useEffect(() => { refresh() }, [refresh])

  const connect = async (serverName: string) => {
    if (busyFor) return
    setBusyFor(serverName)
    setError(null)
    const r = await startMcpAuth(serverName, loopId)
    setBusyFor(null)
    if (r.error || !r.authorizationUrl) {
      setError(r.error ?? "start failed")
      return
    }
    window.location.href = r.authorizationUrl
  }

  const forget = async (envName: string) => {
    if (busyFor) return
    setBusyFor(envName)
    await deleteEnv(envName)
    setBusyFor(null)
    refresh()
  }

  // Parse a pasted MCP URL into the server's vault secrets. Returns an error
  // string on failure, null on success (and refreshes so authed flips).
  const parseSetup = async (serverName: string, pastedUrl: string): Promise<string | null> => {
    const r = await parseMcpSetup(serverName, pastedUrl, loopId)
    if (!r.ok) return r.error
    await refresh()
    return null
  }

  const reloadSession = async () => {
    setReloadFlash(null)
    const r = await restartLoopSession(loopId)
    if (r.error) {
      setError(r.error)
    } else {
      setReloadFlash(
        r.restarted
          ? "Loop SDK session restarted. Send a message to re-spawn with new MCP tokens."
          : "No active SDK session — next message will spawn fresh.",
      )
    }
  }

  return (
    <div className="text-sm">
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

      {error && (
        <div className="mx-3 mt-3 rounded px-3 py-2 text-[12px] bg-red-50 text-red-800 border border-red-200">
          {error}
        </div>
      )}

      {reloadFlash && (
        <div className="mx-3 mt-3 rounded px-3 py-2 text-[12px] bg-blue-50 text-blue-800 border border-blue-200">
          {reloadFlash}
        </div>
      )}

      <div className="max-h-[60vh] overflow-y-auto">
        {loading && servers.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-gray-400">loading…</div>
        ) : servers.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-gray-400 italic">
            No MCP servers in this loop's merged settings.json. Add servers to
            team/personal/profile <code className="bg-gray-100 px-1 rounded font-mono text-[11px]">settings.json</code>'s
            <code className="bg-gray-100 px-1 rounded font-mono text-[11px]">mcpServers</code>.
          </div>
        ) : (
          servers.map((s) => (
            <ServerRow
              key={s.name}
              server={s}
              busy={busyFor === s.name || (s.authTokenEnv !== null && busyFor === s.authTokenEnv)}
              onConnect={() => connect(s.name)}
              onForget={s.authTokenEnv ? () => forget(s.authTokenEnv!) : undefined}
              onParseSetup={(pasted) => parseSetup(s.name, pasted)}
            />
          ))
        )}
      </div>

      <div className="border-t border-gray-200 px-3 py-2 flex items-center justify-end text-[11px]">
        <button
          onClick={reloadSession}
          className="text-gray-600 hover:text-gray-900 flex items-center gap-1"
          title="Restart the SDK session so newly-connected MCPs take effect. Conversation history is preserved."
        >
          <RotateCw size={10} /> Reload session
        </button>
      </div>
    </div>
  )
}

function ServerRow({
  server,
  busy,
  onConnect,
  onForget,
  onParseSetup,
}: {
  server: McpServerEntry
  busy: boolean
  onConnect: () => void
  onForget?: () => void
  onParseSetup: (pastedUrl: string) => Promise<string | null>
}) {
  const isHttp = server.type === "http" || server.type === "sse"
  // Connect is offered only when OAuth via DCR is feasible AND we know which
  // env to write. Servers without a Bearer template don't get a button.
  const connectable = isHttp && server.oauthSupport === "dcr" && !!server.authTokenEnv
  // Paste-the-URL setup is offered when the server declares a setup resource
  // (its secrets live in the url/headers as ${VAR}s, parsed from a pasted URL).
  const hasSetup = !!server.setupResource
  const [setupOpen, setSetupOpen] = useState(false)
  const [paste, setPaste] = useState("")
  const [saving, setSaving] = useState(false)
  const [setupErr, setSetupErr] = useState<string | null>(null)
  const saveSetup = async () => {
    setSaving(true)
    setSetupErr(null)
    const e = await onParseSetup(paste.trim())
    setSaving(false)
    if (e) setSetupErr(e)
    else { setSetupOpen(false); setPaste("") }
  }

  return (
    <div className="border-b border-gray-50 last:border-0">
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50">
      <span className="text-[14px] text-gray-300 leading-none">
        {server.authed ? "●" : connectable ? "○" : "·"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-gray-700 text-[13px]">{server.name}</span>
          <span className="text-[10px] text-gray-400 uppercase">{server.type}</span>
        </div>
        {server.url && (
          <div className="text-[11px] text-gray-400 font-mono truncate">{server.url}</div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {server.authed && (
          <span className="text-[11px] text-green-700 inline-flex items-center gap-1">
            <Check size={11} /> authed
          </span>
        )}
        {connectable && (
          <button
            onClick={onConnect}
            disabled={busy}
            className={`inline-flex items-center gap-1 text-[11px] px-2 h-6 rounded ${
              server.authed
                ? "text-gray-600 hover:bg-gray-100 border border-gray-200"
                : "text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200"
            } disabled:opacity-50`}
            title={server.authed ? "Re-run OAuth and overwrite the existing token" : "Run OAuth to obtain a token"}
          >
            {server.authed ? <Link2 size={10} /> : <AlertTriangle size={10} />}
            {busy ? "…" : server.authed ? "re-auth" : "auth"}
          </button>
        )}
        {server.authed && onForget && (
          <button
            onClick={onForget}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 h-6 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-50"
            title="Delete the env file backing this server's token"
          >
            <Unlink size={10} /> forget
          </button>
        )}
        {hasSetup && (
          <button
            onClick={() => setSetupOpen((o) => !o)}
            className={`inline-flex items-center gap-1 text-[11px] px-2 h-6 rounded ${
              server.authed
                ? "text-gray-600 hover:bg-gray-100 border border-gray-200"
                : "text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200"
            }`}
            title="Paste your MCP URL from the provider's page to set this server's secrets"
          >
            <KeyRound size={10} />
            {server.authed ? "re-setup" : "setup"}
          </button>
        )}
        {!hasSetup && !connectable && !server.authed && isHttp && (
          server.oauthSupport === "manual" ? (
            <span
              className="text-[11px] text-gray-500 italic"
              title="This provider requires admin to register an OAuth app (no DCR). Loopat doesn't support manual client_id setup."
            >
              manual setup
            </span>
          ) : server.oauthSupport === "none" ? (
            <span className="text-[11px] text-gray-400" title="No OAuth metadata — server is public or uses non-OAuth auth (e.g. API key).">
              no oauth
            </span>
          ) : server.oauthSupport === "unreachable" ? (
            <span className="text-[11px] text-red-500" title="Probe failed — server unreachable or returned malformed metadata.">
              unreachable
            </span>
          ) : server.authTokenEnv === null ? (
            <span
              className="text-[11px] text-gray-400 italic"
              title="No Bearer ${VAR} template in Authorization header — loopat can't determine which env to write."
            >
              no bearer template
            </span>
          ) : null
        )}
        {!isHttp && <span className="text-[11px] text-gray-400">stdio</span>}
      </div>
    </div>
    {setupOpen && hasSetup && (
      <div className="px-3 pb-2.5 pt-0.5 bg-gray-50/60">
        <div className="text-[11px] text-gray-500 mb-1.5">
          到{" "}
          <a
            href={server.setupResource}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5"
          >
            这个页面 <ExternalLink size={9} />
          </a>{" "}
          复制你的 MCP URL,粘贴到下面 —— 会自动解析出{" "}
          {(server.requiredEnvs ?? []).join("、") || "所需密钥"} 并存进你的 vault。
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="https://…?key=…"
          rows={2}
          spellCheck={false}
          className="w-full px-2 py-1 rounded border border-gray-300 text-[11px] font-mono focus:outline-none focus:border-gray-500 resize-none"
        />
        {setupErr && <div className="text-[11px] text-red-600 mt-1">{setupErr}</div>}
        <div className="mt-1.5 flex items-center gap-2">
          <button
            onClick={saveSetup}
            disabled={!paste.trim() || saving}
            className="text-[11px] px-2.5 h-6 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
          >
            {saving ? "解析中…" : "解析并保存"}
          </button>
          <button
            onClick={() => { setSetupOpen(false); setPaste(""); setSetupErr(null) }}
            className="text-[11px] text-gray-500 hover:text-gray-800"
          >
            取消
          </button>
        </div>
      </div>
    )}
    </div>
  )
}
