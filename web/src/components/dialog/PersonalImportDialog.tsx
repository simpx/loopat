import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getPersonalStatus, importPersonal, type PersonalStatus } from "@/api"

/**
 * Manage the personal-repo deploy-key flow after registration. Two entry
 * states:
 *   - never imported: show pubkey + repo URL form (if not on file) + Continue
 *   - already imported: show summary (read-only, no destructive action)
 *
 * On open, hits /api/personal/status. If the keypair was missing (e.g.
 * registered before ssh-keygen was installed) the server lazily generates
 * one and returns the pubkey here — no explicit "regen" button needed.
 */
export function PersonalImportDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [status, setStatus] = useState<PersonalStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [repoUrl, setRepoUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSuccess(false)
    setLoading(true)
    getPersonalStatus()
      .then((s) => {
        setStatus(s)
        setRepoUrl(s?.personalRepo ?? "")
      })
      .finally(() => setLoading(false))
  }, [open])

  const copy = async () => {
    if (!status?.publicKey) return
    try {
      await navigator.clipboard.writeText(status.publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const submit = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const url = repoUrl.trim() || undefined
      const r = await importPersonal(url)
      if (!r.ok) {
        setError(r.error ?? "import failed")
        return
      }
      setSuccess(true)
      // refresh status so the imported state shows immediately if user reopens
      const fresh = await getPersonalStatus()
      setStatus(fresh)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md bg-white">
        <DialogHeader>
          <DialogTitle>Personal repo</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="text-sm text-gray-500 py-6 text-center">loading…</div>
        ) : !status ? (
          <div className="text-sm text-red-600">failed to load status</div>
        ) : status.imported && !success ? (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-gray-700">
              已导入 <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">{status.personalRepo ?? "(unknown remote)"}</code>。
            </div>
            <div className="text-[11px] text-gray-400 leading-relaxed">
              想换 remote 或重新 import,先在 host 上清空{" "}
              <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">personal/{status.userId}/</code>{" "}
              再回来。
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-1 self-end px-3 h-8 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        ) : success ? (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-2 py-2">
              Import 成功 ✓
            </div>
            <button
              type="button"
              onClick={onClose}
              className="self-end px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700"
            >
              Done
            </button>
          </div>
        ) : !status.publicKey ? (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-2 leading-relaxed">
              没拿到 deploy key — 服务端可能缺 <code className="text-[11px] bg-white px-1 rounded">openssh-client</code>。
              安装后重新打开本对话框即可。
            </div>
            <button
              type="button"
              onClick={onClose}
              className="self-end px-3 h-8 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-gray-600 leading-relaxed">
              把下面这把公钥贴到 GitHub repo 的 deploy keys(勾 <b>Allow write access</b>),
              然后回来点 Continue。
            </div>
            <div className="relative">
              <textarea
                readOnly
                value={status.publicKey}
                rows={3}
                className="w-full text-[11px] font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 outline-none resize-none"
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
              <button
                type="button"
                onClick={copy}
                className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-700 font-medium">Repo URL</span>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="git@github.com:you/loopat-personal.git"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
              />
              <span className="text-[11px] text-gray-400">
                注册时没填也没关系,这里补即可。
              </span>
            </label>
            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                {error}
              </div>
            )}
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={submit}
                disabled={busy || !repoUrl.trim()}
                className="flex-1 px-3 h-9 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {busy ? "cloning…" : "Continue"}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-3 h-9 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
