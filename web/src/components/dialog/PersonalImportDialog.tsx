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
  const [cryptKey, setCryptKey] = useState("")
  const [showCryptKeyField, setShowCryptKeyField] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exposedFiles, setExposedFiles] = useState<string[]>([])
  const [showGuide, setShowGuide] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSuccess(false)
    setCryptKey("")
    setShowCryptKeyField(false)
    setExposedFiles([])
    setShowGuide(false)
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
    setExposedFiles([])
    setBusy(true)
    try {
      const url = repoUrl.trim() || undefined
      const key = cryptKey.trim() || undefined
      const r = await importPersonal(url, key)
      if (!r.ok) {
        setError(r.error ?? "import failed")
        if (r.needsCryptKey) setShowCryptKeyField(true)
        if (r.secretsExposed) {
          setExposedFiles(r.exposedFiles ?? [])
          setShowGuide(true)
        }
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
            {showCryptKeyField && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-700 font-medium">git-crypt key (base64)</span>
                <textarea
                  value={cryptKey}
                  onChange={(e) => setCryptKey(e.target.value)}
                  rows={3}
                  placeholder="AEdJVENSWVBUS0VZ... (本地 git-crypt export-key 输出的 base64)"
                  className="w-full px-2 py-1.5 text-[11px] font-mono border border-gray-300 rounded outline-none focus:border-gray-500 resize-none"
                />
                <span className="text-[11px] text-gray-400 leading-relaxed">
                  你的 repo 启用了 git-crypt。粘贴 <code className="text-[11px] bg-gray-100 px-1 rounded">git-crypt export-key</code> 的输出（base64）。
                  Loopat 会存到 host-secrets/{status.userId}/ 用来解密 secrets/。
                </span>
              </label>
            )}
            {exposedFiles.length > 0 && (
              <div className="text-xs bg-red-50 border border-red-300 rounded p-2.5 leading-relaxed">
                <div className="font-semibold text-red-700 mb-1">⚠️ 你的 secrets 已经泄露</div>
                <div className="text-red-700 mb-1.5">
                  以下文件在 git 历史里是<b>明文</b>。任何能访问这个 repo 的人都已经能读到它们：
                </div>
                <ul className="font-mono text-[10.5px] text-red-800 bg-white/60 rounded p-1.5 max-h-24 overflow-auto">
                  {exposedFiles.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div className="text-red-700 mt-2 font-medium">
                  必做（按顺序）：
                </div>
                <ol className="list-decimal pl-4 text-red-700 space-y-0.5 mt-0.5">
                  <li>立刻 <b>rotate</b> 这些 secrets（重新生成 API key 等）— 老的已经 burn 了</li>
                  <li>在本地启用 git-crypt（展开下方"How to set up git-crypt"按步骤做）</li>
                  <li>历史里的明文 blob 还在 — 用 <code className="text-[10.5px] bg-white px-1 rounded">git filter-branch</code> 清理，<b>或</b>接受"那批 secret 已 burn，已 rotate"就过</li>
                  <li>重新 push，回来 paste 新生成的 git-crypt key</li>
                </ol>
                <div className="text-red-600 text-[10.5px] mt-2 italic">
                  Loopat 拒绝继续 import — 否则就是帮你把已泄露的 secrets 带进生产环境。
                </div>
              </div>
            )}
            {error && exposedFiles.length === 0 && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                {error}
              </div>
            )}
            <div className="border border-gray-200 rounded">
              <button
                type="button"
                onClick={() => setShowGuide((v) => !v)}
                className="w-full flex justify-between items-center px-2.5 py-1.5 text-[11px] text-gray-600 hover:bg-gray-50"
              >
                <span>How to set up git-crypt（首次必看）</span>
                <span className="text-gray-400">{showGuide ? "▾" : "▸"}</span>
              </button>
              {showGuide && (
                <div className="px-2.5 pb-2.5 text-[11px] text-gray-600 leading-relaxed border-t border-gray-200">
                  <p className="mt-2">
                    Loopat 的 <code className="bg-gray-100 px-1 rounded">.loopat/secrets/</code> 必须用 <code className="bg-gray-100 px-1 rounded">git-crypt</code> 加密入 repo，
                    否则 API key、ssh 私钥等会以明文 push 到远端。
                  </p>
                  <p className="mt-2 font-medium text-gray-700">本地一次性设置：</p>
                  <pre className="bg-gray-900 text-gray-100 text-[10.5px] p-2 rounded mt-1 overflow-x-auto">{`# 1. 装 git-crypt
sudo apt install git-crypt    # macOS: brew install git-crypt

# 2. 在你本地的 personal repo 里
cd <你本地的 personal repo>
git-crypt init                # 生成对称 key

# 3. 标记哪些路径走加密
cat > .gitattributes <<'EOF'
.loopat/secrets/** filter=git-crypt diff=git-crypt
EOF

# 4. 标记 host-only 不入 repo
cat > .gitignore <<'EOF'
/.loopat/host/
EOF

# 5. 导出 key 备份（这把丢了，secrets 全废）
mkdir -p ~/.config/loopat
git-crypt export-key ~/.config/loopat/git-crypt.key
chmod 600 ~/.config/loopat/git-crypt.key

# 6. 添加 secrets、commit、push
mkdir -p .loopat/secrets/anthropic
echo "sk-ant-xxx" > .loopat/secrets/anthropic/ANTHROPIC_API_KEY
git add .gitattributes .gitignore .loopat/
git commit -m "enable git-crypt for secrets"
git push

# 7. 把 key 转成 base64（粘贴到上面的 git-crypt key 输入框）
base64 -w 0 ~/.config/loopat/git-crypt.key && echo`}</pre>
                  <p className="mt-2">
                    验证生效：<code className="bg-gray-100 px-1 rounded">git-crypt status</code> 会列出哪些文件 <code>encrypted</code>。
                    没装 git-crypt 的人 clone 下来，<code className="bg-gray-100 px-1 rounded">cat</code> secrets 会看到 <code className="bg-gray-100 px-1 rounded">\0GITCRYPT\0...</code> 乱码。
                  </p>
                  <p className="mt-2 text-amber-700">
                    <b>⚠️ 不能用 .gitignore 代替 git-crypt</b>：那样 secrets 根本不在 git，loopat clone 不下来。
                    要的就是"密文入 git、明文在 worktree"——只有 git-crypt 满足。
                  </p>
                </div>
              )}
            </div>
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
