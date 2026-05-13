import { useState, type FormEvent } from "react"
import { useWorkspace } from "../ctx"
import { importPersonal } from "../api"

type Mode = "login" | "register"

/**
 * Post-register import stage. Server has provisioned an empty personal/<user>/
 * + generated an ed25519 deploy keypair. User has to:
 *   1. Copy the public key.
 *   2. Add it as a deploy key (with write access) on their personal repo on
 *      GitHub / GitLab.
 *   3. Click Continue → server clones the repo using the managed private key.
 */
type ImportStage = {
  publicKey: string
  personalRepo: string
}

export function AuthPage({ onClose }: { onClose?: () => void } = {}) {
  const ws = useWorkspace()
  const [mode, setMode] = useState<Mode>("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [personalRepo, setPersonalRepo] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importStage, setImportStage] = useState<ImportStage | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      if (mode === "login") {
        const r = await ws.login(username.trim().toLowerCase(), password)
        if (r.error) setError(r.error)
        else if (onClose) onClose()
        return
      }
      const r = await ws.register({
        username: username.trim().toLowerCase(),
        password,
        personalRepo: personalRepo.trim() || undefined,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      if (r.needsImport && r.publicKey && r.personalRepo) {
        // Stay on the page; switch to import stage. User has been logged in
        // server-side already (cookie set), but we hold the modal until the
        // clone completes (or they skip).
        setImportStage({ publicKey: r.publicKey, personalRepo: r.personalRepo })
        return
      }
      if (onClose) onClose()
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const r = await importPersonal()
      if (!r.ok) {
        setError(r.error ?? "import failed")
        return
      }
      if (onClose) onClose()
    } finally {
      setBusy(false)
    }
  }

  const skipImport = () => {
    if (onClose) onClose()
  }

  return (
    <div
      className={
        onClose
          ? "fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          : "h-full w-full flex items-center justify-center bg-gray-50"
      }
      onClick={onClose ? () => onClose() : undefined}
    >
      <div
        className="w-full max-w-[420px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-5">
          <span className="text-xl leading-none">🧶</span>
          <span className="text-base font-semibold text-gray-900">loopat</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto text-gray-400 hover:text-gray-700 px-1"
              aria-label="close"
            >
              ✕
            </button>
          )}
        </div>

        {importStage ? (
          <ImportPanel
            stage={importStage}
            busy={busy}
            error={error}
            onContinue={runImport}
            onSkip={skipImport}
          />
        ) : (
          <>
            <div className="flex border-b border-gray-200 mb-5">
              {(["login", "register"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m)
                    setError(null)
                  }}
                  className={
                    mode === m
                      ? "px-3 py-2 text-sm border-b-2 border-gray-900 text-gray-900 font-medium"
                      : "px-3 py-2 text-sm text-gray-500 hover:text-gray-800"
                  }
                >
                  {m === "login" ? "Login" : "Register"}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field label="Username" hint="lowercase a-z 0-9 _ - · 1-32 chars">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="simpx"
                  autoFocus
                  autoComplete="username"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
                />
              </Field>
              {mode === "register" && (
                <Field
                  label="Personal repo"
                  hint="optional · 注册后系统会生成 deploy key,你贴到 GitHub 后再导入"
                >
                  <input
                    type="text"
                    value={personalRepo}
                    onChange={(e) => setPersonalRepo(e.target.value)}
                    placeholder="git@github.com:you/loopat-personal.git"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
                  />
                </Field>
              )}
              {error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={busy || !username || !password}
                className="px-3 h-9 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {busy ? (mode === "login" ? "logging in…" : "registering…") : mode === "login" ? "Login" : "Register"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

function ImportPanel({
  stage,
  busy,
  error,
  onContinue,
  onSkip,
}: {
  stage: ImportStage
  busy: boolean
  error: string | null
  onContinue: () => void
  onSkip: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stage.publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold text-gray-900">Add deploy key</div>
      <div className="text-xs text-gray-600 leading-relaxed">
        要把 <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">{stage.personalRepo}</code>{" "}
        clone 进你的 personal/,需要先把下面这把公钥贴到 GitHub repo 的 deploy keys。
        <ul className="list-disc pl-5 mt-2 space-y-1 text-gray-500">
          <li>GitHub → 你的 repo → Settings → Deploy keys → Add deploy key</li>
          <li>勾上 <b>Allow write access</b>(loopat 要 push memory 更新)</li>
          <li>粘贴下面这段公钥,Save</li>
          <li>回到这里点 Continue</li>
        </ul>
      </div>
      <div className="relative">
        <textarea
          readOnly
          value={stage.publicKey}
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
      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="flex gap-2 mt-1">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="flex-1 px-3 h-9 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {busy ? "cloning…" : "Continue"}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="px-3 h-9 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>
      <div className="text-[11px] text-gray-400 leading-relaxed">
        Skip 也没关系 — personal/ 已经初始化为空 git repo,你随时可以稍后在设置里触发 import。
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-700 font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  )
}
