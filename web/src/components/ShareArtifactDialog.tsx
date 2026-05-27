import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { getServeConfig, checkAliasAvailable, getAvailablePort, checkPortAvailable, type LoopMeta, type ServeConfig } from "../api"
import { Globe, Copy, Check, AlertCircle, Shuffle } from "lucide-react"

type ShareMode = "static" | "port" | "direct"

export function ShareArtifactDialog({ loop, open, onClose, onSaved }: { loop: LoopMeta; open: boolean; onClose: () => void; onSaved?: () => Promise<any> | void }) {
  const [sc, setSc] = useState<ServeConfig | null>(null)
  const [enabled, setEnabled] = useState(loop.shareEnabled ?? false)
  const [mode, setMode] = useState<ShareMode>(
    loop.shareExternalPort ? "direct" : (loop.shareMode ?? "static") as ShareMode
  )
  const [alias, setAlias] = useState(loop.shareAlias ?? "")
  const [port, setPort] = useState(loop.sharePort ?? 3000)
  const [externalPort, setExternalPort] = useState(loop.shareExternalPort ?? 10000)
  const [protocol, setProtocol] = useState<"tcp" | "udp" | "static">((loop.shareProtocol as any) ?? "tcp")
  const [aliasAvailable, setAliasAvailable] = useState<boolean | null>(null)
  const [aliasMsg, setAliasMsg] = useState("")
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [idConflict, setIdConflict] = useState(false)
  const [portError, setPortError] = useState("")
  const [portChecking, setPortChecking] = useState(false)
  const [savedMsg, setSavedMsg] = useState("")
  const [error, setError] = useState("")
  // Tab state when both serves are enabled
  const [tab, setTab] = useState<"standard" | "direct">(
    loop.shareExternalPort ? "direct" : "standard"
  )

  const shortId = loop.id.slice(0, 8)
  const standardOnly = sc && sc.serveEnabled && !sc.serveDynamicEnabled
  const directOnly = sc && !sc.serveEnabled && sc.serveDynamicEnabled
  const bothOn = sc && sc.serveEnabled && sc.serveDynamicEnabled

  useEffect(() => {
    if (open) {
      getServeConfig().then(setSc)
      setEnabled(loop.shareEnabled ?? false)
      setMode(loop.shareExternalPort ? "direct" : (loop.shareMode ?? "static") as ShareMode)
      setAlias(loop.shareAlias ?? "")
      setPort(loop.sharePort ?? 3000)
      setExternalPort(loop.shareExternalPort ?? 10000)
      setProtocol(loop.shareProtocol ?? "tcp")
      setTab(loop.shareExternalPort ? "direct" : "standard")
      setAliasAvailable(null)
      setAliasMsg("")
      setPortError("")
    }
  }, [open, loop])

  // Auto-pick port after serve config loads. Only for fresh loops that
  // have never had share enabled — if the user already saved a config
  // (any mode), leave it alone.
  useEffect(() => {
    if (!open || !sc) return
    if (!sc.serveDynamicEnabled) return
    if (loop.shareEnabled && loop.shareExternalPort) return // already configured
    if (!loop.shareEnabled && !loop.shareExternalPort) {
      getAvailablePort().then((r) => {
        if (r.port) setExternalPort(r.port)
      })
    }
  }, [open, sc, loop.shareEnabled, loop.shareExternalPort])

  useEffect(() => {
    if (!open) return
    checkAliasAvailable(shortId, loop.id).then((r) => {
      if (!r.available) { setIdConflict(true); setAliasMsg(`ID "${shortId}" is already in use. Please set an alias.`) }
      else setIdConflict(false)
    })
  }, [open, shortId, loop.id])

  useEffect(() => {
    if (!alias || !open) { setAliasAvailable(null); setAliasMsg(""); return }
    const t = setTimeout(async () => {
      const r = await checkAliasAvailable(alias, loop.id)
      setAliasAvailable(r.available); setAliasMsg(r.reason ?? "")
    }, 300)
    return () => clearTimeout(t)
  }, [alias, open, loop.id])

  // URL building
  const shareHost = alias || shortId
  const protocolPrefix = sc?.https ? "https" : "http"
  const portSuffix = sc?.withPort ? `:${sc.displayPort}` : ""
  const subdomainUrl = sc ? `${protocolPrefix}://${shareHost}${sc.baseUrl}${portSuffix}` : ""

  const dynHost = sc?.serveDynamicDomain || sc?.ip || "<host-ip>"
  const directUrl = protocol === "static"
    ? `http://${dynHost}:${externalPort}`
    : `tcp://${dynHost}:${externalPort}`

  const isDirectTab = directOnly || (bothOn && tab === "direct")
  const shareUrl = isDirectTab ? directUrl : subdomainUrl

  // Validate external port availability (debounced)
  useEffect(() => {
    if (!open || !isDirectTab) return
    const t = setTimeout(async () => {
      setPortChecking(true)
      const r = await checkPortAvailable(externalPort, loop.id)
      setPortChecking(false)
      if (!r.available) setPortError(r.reason ?? "Port unavailable")
      else setPortError("")
    }, 400)
    return () => clearTimeout(t)
  }, [externalPort, open, mode, loop.id])

  const handleSave = async () => {
    setSaving(true)
    // Final port check on save
    if (isDirectTab) {
      const r = await checkPortAvailable(externalPort, loop.id)
      if (!r.available) {
        setPortError(r.reason ?? "Port unavailable")
        setSaving(false)
        return
      }
    }
    const patch: Record<string, any> = { shareEnabled: enabled }
    if (enabled) {
      if (isDirectTab) {
        patch.shareMode = "port"
        patch.sharePort = port
        patch.shareExternalPort = externalPort
        patch.shareProtocol = protocol
        patch.shareAlias = undefined
      } else {
        patch.shareMode = mode
        patch.shareAlias = alias.trim() || undefined
        if (mode === "port") patch.sharePort = port
        patch.shareExternalPort = undefined
        patch.shareProtocol = undefined
      }
    } else {
      patch.shareMode = undefined; patch.shareAlias = undefined; patch.sharePort = undefined
      // Keep shareExternalPort and shareProtocol — restoring on re-enable
    }
    const r = await fetch(`/api/loops/${loop.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    })
    setSaving(false)
    if (r.ok) {
      setSavedMsg("Saved")
      await onSaved?.()
      setTimeout(() => { setSavedMsg(""); onClose() }, 800)
    } else {
      try { const j = await r.json(); setError(j.error ?? `Save failed (${r.status})`) }
      catch { setError(`Save failed (${r.status})`) }
    }
  }

  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) }
    catch { window.prompt("Copy this URL:", shareUrl) }
  }

  const canSave =
    !saving && !portError && !portChecking &&
    (!isDirectTab || (externalPort >= 1024)) &&
    (!isDirectTab || (port >= 1 || protocol === "static")) &&
    (isDirectTab || mode !== "port" || (!idConflict || alias.trim().length > 0)) &&
    (isDirectTab || mode !== "port" || (port >= 1024))

  if (!sc) return null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md bg-white max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Globe size={16} />
            Share Artifact
          </DialogTitle>
          <DialogDescription className="sr-only">Share this artifact via a public URL.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-[13px]">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">Enable sharing</span>
            <button
              onClick={() => setEnabled(!enabled)}
              className={`w-10 h-5 rounded-full transition-colors ${enabled ? "bg-blue-600" : "bg-gray-300"}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </div>

          {enabled && (
            <>
              {/* Tabs when both serves enabled */}
              {bothOn && (
                <div className="flex gap-1.5 border-b border-gray-200 pb-2">
                  <button onClick={() => { setTab("standard"); setMode("static") }}
                    className={`px-3 py-1 text-xs rounded-t ${tab === "standard" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-500 hover:text-gray-700"}`}>
                    Subdomain
                  </button>
                  <button onClick={() => { setTab("direct"); setMode("direct") }}
                    className={`px-3 py-1 text-xs rounded-t ${tab === "direct" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-500 hover:text-gray-700"}`}>
                    Direct Port
                  </button>
                </div>
              )}

              {/* ── Standard (subdomain) modes ── */}
              {(standardOnly || (bothOn && tab === "standard")) && (
                <>
                  <div>
                    <label className="text-[11px] text-gray-500 uppercase tracking-wider">Share mode</label>
                    <div className="grid grid-cols-2 gap-1.5 mt-1">
                      <button onClick={() => setMode("static")}
                        className={`px-2 py-1.5 text-xs rounded border ${mode === "static" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}>
                        Static files
                      </button>
                      <button onClick={() => setMode("port")}
                        className={`px-2 py-1.5 text-xs rounded border ${mode === "port" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}>
                        Port proxy
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-gray-500 uppercase tracking-wider">
                      Alias {idConflict ? <span className="text-red-500">(required)</span> : "(optional)"}
                    </label>
                    <input value={alias}
                      onChange={(e) => setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      className={`w-full mt-1 px-2 py-1.5 text-sm border rounded outline-none focus:border-gray-300 ${idConflict ? "border-red-300 bg-red-50" : "border-gray-200"}`}
                      placeholder={idConflict ? "Set an alias to resolve conflict" : "my-project"} />
                    {idConflict && <span className="text-[11px] text-red-500 mt-0.5 flex items-center gap-1"><AlertCircle size={11} /> {aliasMsg || `ID "${shortId}" is already in use`}</span>}
                    {!idConflict && aliasAvailable === true && <span className="text-[11px] text-emerald-600 mt-0.5">Available</span>}
                    {!idConflict && aliasAvailable === false && <span className="text-[11px] text-red-500 mt-0.5 flex items-center gap-1"><AlertCircle size={11} /> {aliasMsg || "Already in use"}</span>}
                  </div>

                  {mode === "port" && (
                    <div>
                      <label className="text-[11px] text-gray-500 uppercase tracking-wider">Port (1024-65535)</label>
                      <input type="number" min={1024} max={65535} value={port}
                        onChange={(e) => setPort(parseInt(e.target.value, 10) || 3000)}
                        className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-200 rounded outline-none focus:border-gray-300" />
                    </div>
                  )}
                </>
              )}

              {/* ── Direct Port mode ── */}
              {(directOnly || (bothOn && tab === "direct")) && (
                <>
                  <div>
                    <label className="text-[11px] text-gray-500 uppercase tracking-wider">External port</label>
                    <div className="flex gap-1.5 mt-1">
                      <input type="number" min={1024} max={65535} value={externalPort}
                        onChange={(e) => setExternalPort(parseInt(e.target.value, 10) || 10000)}
                        className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded outline-none focus:border-gray-300" placeholder="10000" />
                      <button
                        onClick={async () => {
                          const r = await getAvailablePort()
                          if (r.port) setExternalPort(r.port)
                        }}
                        className="px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-100 text-gray-500"
                        title="Pick a random available port"
                      >
                        <Shuffle size={14} />
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5">The public port clients connect to</p>
                    {portChecking && <span className="text-[11px] text-gray-400 mt-0.5">Checking availability…</span>}
                    {portError && <span className="text-[11px] text-red-500 mt-0.5 flex items-center gap-1"><AlertCircle size={11} /> {portError}</span>}
                    {!portChecking && !portError && <span className="text-[11px] text-emerald-600 mt-0.5">Available</span>}
                  </div>

                  {protocol !== "static" && (
                    <div>
                      <label className="text-[11px] text-gray-500 uppercase tracking-wider">Container port</label>
                      <input type="number" min={1} max={65535} value={port}
                        onChange={(e) => setPort(parseInt(e.target.value, 10) || 3000)}
                        className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-200 rounded outline-none focus:border-gray-300" />
                      <p className="text-[10px] text-gray-400 mt-0.5">The port your app listens on inside the sandbox</p>
                    </div>
                  )}

                  <div>
                    <label className="text-[11px] text-gray-500 uppercase tracking-wider">Protocol</label>
                    <div className="flex gap-1.5 mt-1">
                      <button onClick={() => setProtocol("tcp")}
                        className={`flex-1 px-2 py-1.5 text-xs rounded border ${protocol === "tcp" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}>TCP</button>
                      {sc.serveDynamicUdpEnabled && (
                        <button onClick={() => setProtocol("udp")}
                          className={`flex-1 px-2 py-1.5 text-xs rounded border ${protocol === "udp" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}>UDP</button>
                      )}
                      {sc.serveDynamicStaticEnabled && (
                        <button onClick={() => setProtocol("static")}
                          className={`flex-1 px-2 py-1.5 text-xs rounded border ${protocol === "static" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}>Static</button>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* Access URL */}
              <div>
                <label className="text-[11px] text-gray-500 uppercase tracking-wider">Access URL</label>
                <div className="flex gap-2 mt-1">
                  <code className="flex-1 px-2 py-1.5 text-xs bg-gray-50 rounded text-gray-700 truncate">{shareUrl}</code>
                  <button onClick={copyUrl} className="px-2 py-1.5 rounded hover:bg-gray-100 text-gray-500" title="Copy URL">
                    {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  {isDirectTab
                    ? "Direct TCP/UDP access — no domain needed"
                    : "Domain suffix configured in Settings → Workspace → Workspace Serve"}
                </p>
              </div>
            </>
          )}

          {/* Save button */}
          <div className="flex items-center justify-end gap-2 pt-2">
            {error && <span className="text-xs text-red-500">{error}</span>}
            {savedMsg && <span className="text-xs text-emerald-600 flex items-center gap-1"><Check size={12} /> {savedMsg}</span>}
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200">Cancel</button>
            <button onClick={handleSave} disabled={!canSave}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
