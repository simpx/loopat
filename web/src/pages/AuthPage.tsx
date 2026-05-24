import { useState, type FormEvent } from "react"
import { useWorkspace } from "../ctx"
import { importPersonal } from "../api"

type Mode = "login" | "register"

/**
 * Post-register import stage. Server has provisioned an empty personal/<user>/
 * + generated an ed25519 deploy keypair. User has to:
 *   1. Copy the public key.
 *   2. Add it as a deploy key (with write access) on their (empty) personal
 *      repo on GitHub / GitLab.
 *   3. Click Continue → server clones the repo, runs `git-crypt init`,
 *      pushes the encrypted scaffold, and returns the freshly-generated
 *      git-crypt key for the user to back up.
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
  const [backupKey, setBackupKey] = useState<string | null>(null)
  const [pendingNotice, setPendingNotice] = useState<string | null>(null)

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
      // Pending account: no session was issued — show a notice and bounce
      // back to the login tab. They can't proceed until an admin activates.
      if (r.user && r.user.status === "pending") {
        setPendingNotice(`账号 ${r.user.id} 已创建,等待管理员激活后即可登录。`)
        setMode("login")
        setPassword("")
        setPersonalRepo("")
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
      // Auto-init returned a one-time crypt key — force the user through a
      // backup acknowledgement before closing. Recovery / no-init paths
      // don't return a key, so we can close right away.
      if (r.autoInitialized && r.cryptKey) {
        setBackupKey(r.cryptKey)
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

  const finishBackup = () => {
    setBackupKey(null)
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

        {backupKey ? (
          <BackupKeyPanel cryptKey={backupKey} onDone={finishBackup} />
        ) : importStage ? (
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
                    setPendingNotice(null)
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
                  hint="optional · a fresh, empty private GitHub repo. Loopat will set up git-crypt for you on first import — you don't need git-crypt installed."
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
              {pendingNotice && !error && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  {pendingNotice}
                </div>
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
        Loopat is about to clone{" "}
        <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">{stage.personalRepo}</code>{" "}
        and bootstrap it with git-crypt. The repo must be a <b>fresh, empty</b>{" "}
        private GitHub repo — no README, no <code className="text-[11px] bg-gray-100 px-1 rounded">.loopat/</code>.
        <ul className="list-disc pl-5 mt-2 space-y-1 text-gray-500">
          <li>GitHub → your repo → Settings → Deploy keys → Add deploy key</li>
          <li>Tick <b>Allow write access</b> (loopat will push the encrypted scaffold)</li>
          <li>Paste the public key below, Save</li>
          <li>Come back and click Continue</li>
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
          {busy ? "initializing…" : "Continue"}
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
        Skip is fine — personal/ is already an empty local git repo. You can
        finish this later in Settings → Personal repo.
      </div>
    </div>
  )
}

function BackupKeyPanel({
  cryptKey,
  onDone,
}: {
  cryptKey: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [ack, setAck] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cryptKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold text-gray-900">Back up your git-crypt key</div>
      <div className="text-xs text-gray-600 leading-relaxed">
        Loopat just initialized your repo with git-crypt. The symmetric key below
        decrypts everything under <code className="text-[11px] bg-gray-100 px-1 rounded">.loopat/vaults/</code>.
        It's saved on this host, but if this host dies and you don't have your
        own copy, all secrets are unrecoverable.
      </div>
      <div className="relative">
        <textarea
          readOnly
          value={cryptKey}
          rows={4}
          className="w-full text-[11px] font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 outline-none resize-none break-all"
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
      <div className="text-[11px] text-gray-500 leading-relaxed bg-gray-50 border border-gray-200 rounded p-2">
        <b>Suggested:</b> stash this in your password manager. To restore on a new
        host later, paste this value into the Recovery field on the new host.
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="accent-gray-900"
        />
        I've saved this key somewhere safe.
      </label>
      <button
        type="button"
        onClick={onDone}
        disabled={!ack}
        className="self-end px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
      >
        Done
      </button>
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
