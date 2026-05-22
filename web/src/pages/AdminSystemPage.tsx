/**
 * Admin dashboard for the loopat process itself: version info, activity
 * counters, and a "pull latest" button. Polls /api/admin/system every 5s
 * while open. Non-admins get redirected — server also enforces 403.
 *
 * Pull does NOT restart the server. bun --hot picks up code changes
 * in-place. Schema/dep changes need a real restart (ssh in, scripts/stop.sh
 * && scripts/start.sh) — the warning text says so.
 */
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, RefreshCw, Activity, GitBranch, Download } from "lucide-react"
import {
  getAdminSystem,
  adminCheckForUpdates,
  adminPull,
  type AdminSystemInfo,
} from "../api"
import { useWorkspace } from "../ctx"

export function AdminSystemPage() {
  const navigate = useNavigate()
  const ws = useWorkspace()
  const isAdmin = ws.currentUser?.role === "admin"

  const [info, setInfo] = useState<AdminSystemInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [lastPullResult, setLastPullResult] = useState<string>("")
  const [lastPullOk, setLastPullOk] = useState<boolean | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    const next = await getAdminSystem()
    if (next) setInfo(next)
    else setError("forbidden or server unreachable")
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [isAdmin, refresh])

  if (!isAdmin) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-500">
        admin only.&nbsp;
        <button className="underline" onClick={() => navigate("/loop")}>back</button>
      </div>
    )
  }

  async function check() {
    setChecking(true); setError("")
    try {
      const r = await adminCheckForUpdates()
      if (!r.ok) setError(r.error ?? "check failed")
      await refresh()
    } finally { setChecking(false) }
  }

  async function pull() {
    if (!info) return
    if (info.activity.activeLoops > 0) {
      const ok = confirm(
        `${info.activity.activeLoops} loop(s) and ${info.activity.activeUsers} user(s) are active.\n\n` +
        `bun --hot will reload code in-place — most pulls don't disturb anyone. ` +
        `If the pull touches deps or schema, you'll need to ssh in and restart manually.\n\n` +
        `Continue?`
      )
      if (!ok) return
    }
    setPulling(true); setError(""); setLastPullResult("")
    try {
      const r = await adminPull()
      setLastPullOk(r.ok)
      if (!r.ok) {
        setLastPullResult(r.error ?? "pull failed")
      } else if (!r.pulled) {
        setLastPullResult("already up to date")
      } else {
        setLastPullResult(`pulled ${r.oldHead?.slice(0,7)} → ${r.newHead?.slice(0,7)}\n${r.message ?? ""}`.trim())
      }
      await refresh()
    } finally { setPulling(false) }
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700"
            title="back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-semibold text-gray-900">Platform</h1>
          <span className="text-xs text-gray-400 ml-auto">refreshes every 5s</span>
        </div>

        {loading && !info && (
          <div className="text-sm text-gray-400 py-8 text-center">loading…</div>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {info && (
          <>
            <Card icon={<GitBranch className="w-4 h-4" />} title="Version">
              <div className="flex flex-col gap-1 text-sm">
                <div className="text-gray-700">
                  <span className="text-gray-400 mr-2">branch</span>
                  <span className="font-mono">{info.version.branch}</span>
                  <span className="text-gray-400 mx-2">·</span>
                  <span className="text-gray-400 mr-1">commit</span>
                  <span className="font-mono">{info.version.commit.slice(0, 7)}</span>
                </div>
                {info.version.behindBy > 0 ? (
                  <div className="text-amber-700 text-xs">
                    behind by {info.version.behindBy} commit{info.version.behindBy === 1 ? "" : "s"} —{" "}
                    <span className="font-mono">{info.version.latestCommit?.slice(0, 7)}</span>{" "}
                    "{info.version.latestMessage}"
                  </div>
                ) : (
                  <div className="text-xs text-emerald-700">up to date</div>
                )}
                <div className="mt-2">
                  <button
                    onClick={check}
                    disabled={checking}
                    className="text-xs px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
                    {checking ? "checking…" : "Check for updates"}
                  </button>
                </div>
              </div>
            </Card>

            <Card icon={<Activity className="w-4 h-4" />} title="Activity">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-3">
                <Stat label="Active loops" value={info.activity.activeLoops} />
                <Stat label="Active users" value={info.activity.activeUsers} />
                <Stat label="Live WS" value={info.activity.totalWs} />
                <Stat label="SDK streaming" value={info.activity.totalGenerating} />
              </div>
              {info.activity.loops.length === 0 ? (
                <div className="text-xs text-gray-400 text-center py-3">no active loops</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-gray-400 border-b border-gray-200">
                    <tr>
                      <th className="text-left font-normal py-1.5 pr-2">title</th>
                      <th className="text-left font-normal py-1.5 pr-2">driver</th>
                      <th className="text-right font-normal py-1.5 pr-2">WS</th>
                      <th className="text-left font-normal py-1.5">state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.activity.loops.map((l) => (
                      <tr key={l.id} className="border-b border-gray-100 last:border-b-0">
                        <td className="py-1.5 pr-2 truncate max-w-[260px]" title={l.title}>{l.title}</td>
                        <td className="py-1.5 pr-2 text-gray-600">{l.driver}</td>
                        <td className="py-1.5 pr-2 text-right">{l.wsCount}</td>
                        <td className="py-1.5">
                          {l.generating ? (
                            <span className="text-blue-600">streaming…</span>
                          ) : l.lastMsgAgeSec >= 0 && l.lastMsgAgeSec < 60 ? (
                            <span className="text-emerald-600">msg {l.lastMsgAgeSec}s ago</span>
                          ) : (
                            <span className="text-gray-400">idle (attached)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card icon={<Download className="w-4 h-4" />} title="Update">
              <div className="flex flex-col gap-2 text-sm">
                <button
                  onClick={pull}
                  disabled={pulling || info.version.behindBy === 0}
                  className={
                    "self-start text-sm px-3 py-1.5 rounded text-white disabled:opacity-50 " +
                    (info.activity.activeLoops > 0 ? "bg-amber-600 hover:bg-amber-700" : "bg-gray-900 hover:bg-gray-700")
                  }
                >
                  {pulling ? "pulling…" : info.version.behindBy === 0 ? "Pull latest (nothing to pull)" : "Pull latest"}
                </button>
                {info.activity.activeLoops > 0 && info.version.behindBy > 0 && (
                  <div className="text-xs text-amber-700">
                    {info.activity.activeLoops} loop(s) active — bun --hot reloads code in-place.
                    Dep / schema changes need a manual restart.
                  </div>
                )}
                {lastPullResult && (
                  <pre className={
                    "text-xs whitespace-pre-wrap rounded p-2 border " +
                    (lastPullOk ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800")
                  }>
                    {lastPullResult}
                  </pre>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-3">
        <span className="text-gray-400">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</span>
      <span className="text-xl font-semibold text-gray-900 tabular-nums">{value}</span>
    </div>
  )
}
