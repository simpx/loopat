import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { getServeDomain, checkAliasAvailable, type LoopMeta } from "../api"
import { Globe, Copy, Check, AlertCircle } from "lucide-react"

export function ShareArtifactDialog({ loop, open, onClose, onSaved }: { loop: LoopMeta; open: boolean; onClose: () => void; onSaved?: () => void }) {
  const [domain, setDomainState] = useState("")
  const [ip, setIp] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [withPort, setWithPort] = useState(false)
  const [https, setHttps] = useState(false)
  const [displayPort, setDisplayPort] = useState(7788)
  const [enabled, setEnabled] = useState(loop.shareEnabled ?? false)
  const [mode, setMode] = useState<"static" | "port">(loop.shareMode ?? "static")
  const [alias, setAlias] = useState(loop.shareAlias ?? "")
  const [port, setPort] = useState(loop.sharePort ?? 10000)
  const [aliasAvailable, setAliasAvailable] = useState<boolean | null>(null)
  const [aliasMsg, setAliasMsg] = useState("")
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [idConflict, setIdConflict] = useState(false)

  const shortId = loop.id.slice(0, 8)

  useEffect(() => {
    if (open) {
      getServeDomain().then((d) => {
        setDomainState(d.domain)
        setIp(d.ip)
        setBaseUrl(d.baseUrl)
        setWithPort(d.withPort ?? false)
        setHttps(d.https ?? false)
        setDisplayPort(d.displayPort ?? 7788)
      })
      setEnabled(loop.shareEnabled ?? false)
      setMode(loop.shareMode ?? "static")
      setAlias(loop.shareAlias ?? "")
      setPort(loop.sharePort ?? 10000)
      setAliasAvailable(null)
      setAliasMsg("")
    }
  }, [open, loop])

  useEffect(() => {
    if (!open) return
    checkAliasAvailable(shortId, loop.id).then((r) => {
      if (!r.available) {
        setIdConflict(true)
        setAliasMsg(`ID "${shortId}" is already in use. Please set an alias.`)
      } else {
        setIdConflict(false)
      }
    })
  }, [open, shortId, loop.id])

  useEffect(() => {
    if (!alias || !open) { setAliasAvailable(null); setAliasMsg(""); return }
    const t = setTimeout(async () => {
      const r = await checkAliasAvailable(alias, loop.id)
      setAliasAvailable(r.available)
      setAliasMsg(r.reason ?? "")
    }, 300)
    return () => clearTimeout(t)
  }, [alias, open, loop.id])

  const shareHost = alias || shortId
  const protocol = https ? "https" : "http"
  const portSuffix = withPort ? `:${displayPort}` : ""
  const shareUrl = `${protocol}://${shareHost}${baseUrl}${portSuffix}`

  const handleSave = async () => {
    setSaving(true)
    const patch: Record<string, any> = { shareEnabled: enabled }
    if (enabled) {
      patch.shareMode = mode
      patch.shareAlias = alias.trim() || undefined
      if (mode === "port") patch.sharePort = port
    } else {
      patch.shareMode = undefined
      patch.shareAlias = undefined
      patch.sharePort = undefined
    }
    await fetch(`/api/loops/${loop.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
    setSaving(false)
    onSaved?.()
    onClose()
  }

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt("Copy this URL:", shareUrl)
    }
  }

  const canSave = !saving && (!idConflict || alias.trim().length > 0) && (mode !== "port" || (port >= 10000 && port <= 20000))

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md bg-white max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Globe size={16} />
            Share Artifact
          </DialogTitle>
          <DialogDescription className="sr-only">
            Share this artifact via a public URL.
          </DialogDescription>
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
              {/* Mode selection */}
              <div>
                <label className="text-[11px] text-gray-500 uppercase tracking-wider">Share mode</label>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => setMode("static")}
                    className={`flex-1 px-3 py-1.5 text-xs rounded border ${mode === "static" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}
                  >
                    Static files
                  </button>
                  <button
                    onClick={() => setMode("port")}
                    className={`flex-1 px-3 py-1.5 text-xs rounded border ${mode === "port" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"}`}
                  >
                    Port forward
                  </button>
                </div>
              </div>

              {/* Alias */}
              <div>
                <label className="text-[11px] text-gray-500 uppercase tracking-wider">
                  Alias {idConflict ? <span className="text-red-500">(required)</span> : "(optional)"}
                </label>
                <input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className={`w-full mt-1 px-2 py-1.5 text-sm border rounded outline-none focus:border-gray-300 ${idConflict ? "border-red-300 bg-red-50" : "border-gray-200"}`}
                  placeholder={idConflict ? "Set an alias to resolve conflict" : "my-project"}
                />
                {idConflict && (
                  <span className="text-[11px] text-red-500 mt-0.5 flex items-center gap-1">
                    <AlertCircle size={11} /> {aliasMsg || `ID "${shortId}" is already in use`}
                  </span>
                )}
                {!idConflict && aliasAvailable === true && <span className="text-[11px] text-emerald-600 mt-0.5">Available</span>}
                {!idConflict && aliasAvailable === false && (
                  <span className="text-[11px] text-red-500 mt-0.5 flex items-center gap-1">
                    <AlertCircle size={11} /> {aliasMsg || "Already in use"}
                  </span>
                )}
              </div>

              {/* Port (when mode is port) */}
              {mode === "port" && (
                <div>
                  <label className="text-[11px] text-gray-500 uppercase tracking-wider">Port (10000-20000)</label>
                  <input
                    type="number"
                    min={10000}
                    max={20000}
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value, 10) || 10000)}
                    className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-200 rounded outline-none focus:border-gray-300"
                  />
                </div>
              )}

              {/* Access URL */}
              <div>
                <label className="text-[11px] text-gray-500 uppercase tracking-wider">Access URL</label>
                <div className="flex gap-2 mt-1">
                  <code className="flex-1 px-2 py-1.5 text-xs bg-gray-50 rounded text-gray-700 truncate">
                    {shareUrl}
                  </code>
                  <button
                    onClick={copyUrl}
                    className="px-2 py-1.5 rounded hover:bg-gray-100 text-gray-500"
                    title="Copy URL"
                  >
                    {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  Domain suffix configured in Settings → Workspace → Workspace Serve
                </p>
              </div>
            </>
          )}

          {/* Save button */}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
