import { useEffect, useState } from "react"
import { getPersonalStatus, importPersonal, type PersonalStatus } from "@/api"

/**
 * Personal-repo deploy-key flow, rendered as a settings panel (no Dialog
 * wrapper — meant to live inside SettingsDialog's sidebar layout).
 *
 * Three states, decided by /api/personal/status:
 *   - already imported: read-only summary
 *   - no publicKey from server: report missing openssh-client
 *   - otherwise: pubkey + repo URL form + optional git-crypt key
 *
 * `onDone` lets the host dialog close itself after a successful import
 * (optional — caller may leave the panel open instead).
 */
export function PersonalRepoPanel({ onDone }: { onDone?: () => void } = {}) {
  const [status, setStatus] = useState<PersonalStatus | null>(null)
  const [loading, setLoading] = useState(true)
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
  }, [])

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
      const fresh = await getPersonalStatus()
      setStatus(fresh)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">loading…</div>
  }
  if (!status) {
    return <div className="text-sm text-red-600">failed to load status</div>
  }
  if (status.imported && !success) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-700">
          Imported <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">{status.personalRepo ?? "(unknown remote)"}</code>.
        </div>
        <div className="text-[11px] text-gray-400 leading-relaxed">
          To switch remote or re-import, clear{" "}
          <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">personal/{status.userId}/</code>{" "}
          on the host first, then come back.
        </div>
      </div>
    )
  }
  if (success) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-2 py-2">
          Import succeeded ✓
        </div>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="self-end px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700"
          >
            Done
          </button>
        )}
      </div>
    )
  }
  if (!status.publicKey) {
    return (
      <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-2 leading-relaxed">
        No deploy key available — the server is probably missing{" "}
        <code className="text-[11px] bg-white px-1 rounded">openssh-client</code>.
        Install it and reopen this panel.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-gray-600 leading-relaxed">
        Add the public key below to the deploy keys of your GitHub repo
        (check <b>Allow write access</b>), then click Continue.
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
          If you didn't supply it at registration, fill it in here.
        </span>
      </label>
      {showCryptKeyField && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-700 font-medium">git-crypt key (base64)</span>
          <textarea
            value={cryptKey}
            onChange={(e) => setCryptKey(e.target.value)}
            rows={3}
            placeholder="AEdJVENSWVBUS0VZ... (base64 output of `git-crypt export-key`)"
            className="w-full px-2 py-1.5 text-[11px] font-mono border border-gray-300 rounded outline-none focus:border-gray-500 resize-none"
          />
          <span className="text-[11px] text-gray-400 leading-relaxed">
            Your repo has git-crypt enabled. Paste the base64 output of{" "}
            <code className="text-[11px] bg-gray-100 px-1 rounded">git-crypt export-key</code>.
            Loopat stores it under host-secrets/{status.userId}/ to decrypt secrets/.
          </span>
        </label>
      )}
      {exposedFiles.length > 0 && (
        <div className="text-xs bg-red-50 border border-red-300 rounded p-2.5 leading-relaxed">
          <div className="font-semibold text-red-700 mb-1">⚠️ Your secrets are exposed</div>
          <div className="text-red-700 mb-1.5">
            The following files appear in git history as <b>plaintext</b>. Anyone with repo access can already read them:
          </div>
          <ul className="font-mono text-[10.5px] text-red-800 bg-white/60 rounded p-1.5 max-h-24 overflow-auto">
            {exposedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="text-red-700 mt-2 font-medium">
            Required (in order):
          </div>
          <ol className="list-decimal pl-4 text-red-700 space-y-0.5 mt-0.5">
            <li>Immediately <b>rotate</b> those secrets (regenerate API keys etc.) — the old ones are burned.</li>
            <li>Enable git-crypt locally (expand "How to set up git-crypt" below and follow the steps).</li>
            <li>Plaintext blobs are still in history — clean with <code className="text-[10.5px] bg-white px-1 rounded">git filter-branch</code>, <b>or</b> accept "those secrets are burned and rotated" and move on.</li>
            <li>Push again, return here, paste the new git-crypt key.</li>
          </ol>
          <div className="text-red-600 text-[10.5px] mt-2 italic">
            Loopat refuses to continue importing — otherwise it would carry already-leaked secrets into production.
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
          <span>How to set up git-crypt (read this first)</span>
          <span className="text-gray-400">{showGuide ? "▾" : "▸"}</span>
        </button>
        {showGuide && (
          <div className="px-2.5 pb-2.5 text-[11px] text-gray-600 leading-relaxed border-t border-gray-200">
            <p className="mt-2">
              Loopat's <code className="bg-gray-100 px-1 rounded">.loopat/secrets/</code> must be encrypted into the repo with{" "}
              <code className="bg-gray-100 px-1 rounded">git-crypt</code>; otherwise API keys, ssh private keys, etc. would be pushed in plaintext.
            </p>
            <p className="mt-2 font-medium text-gray-700">One-time local setup:</p>
            <pre className="bg-gray-900 text-gray-100 text-[10.5px] p-2 rounded mt-1 overflow-x-auto">{`# 1. Install git-crypt
sudo apt install git-crypt    # macOS: brew install git-crypt

# 2. Inside your local personal repo
cd <your local personal repo>
git-crypt init                # generate a symmetric key

# 3. Mark which paths should be encrypted
cat > .gitattributes <<'EOF'
.loopat/secrets/** filter=git-crypt diff=git-crypt
EOF

# 4. Mark host-only paths so they stay out of the repo
cat > .gitignore <<'EOF'
/.loopat/host/
EOF

# 5. Export the key as backup (lose it and all secrets are unrecoverable)
mkdir -p ~/.config/loopat
git-crypt export-key ~/.config/loopat/git-crypt.key
chmod 600 ~/.config/loopat/git-crypt.key

# 6. Add secrets, commit, push
mkdir -p .loopat/secrets/anthropic
echo "sk-ant-xxx" > .loopat/secrets/anthropic/ANTHROPIC_API_KEY
git add .gitattributes .gitignore .loopat/
git commit -m "enable git-crypt for secrets"
git push

# 7. base64 the key (paste into the git-crypt key field above)
base64 -w 0 ~/.config/loopat/git-crypt.key && echo`}</pre>
            <p className="mt-2">
              Verify: <code className="bg-gray-100 px-1 rounded">git-crypt status</code> lists which files are <code>encrypted</code>.
              Someone without git-crypt cloning the repo will <code className="bg-gray-100 px-1 rounded">cat</code> a secret and see{" "}
              <code className="bg-gray-100 px-1 rounded">\0GITCRYPT\0...</code> garbage.
            </p>
            <p className="mt-2 text-amber-700">
              <b>⚠️ .gitignore is NOT a substitute for git-crypt</b>: that would keep secrets out of git entirely,
              and loopat would have nothing to clone. You want "ciphertext in git, plaintext in worktree" — only git-crypt provides that.
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
      </div>
    </div>
  )
}
