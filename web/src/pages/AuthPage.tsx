import { useEffect, useState, type FormEvent } from "react"
import { useWorkspace } from "../ctx"

type Mode = "login" | "register"

/**
 * Login / register. Registration only creates the account — personal repo
 * setup lives in Settings → Personal Repo (token → pick/create flow), and the
 * SetupPersonalRepoCard nudges new users there after they land. Keeping auth
 * lean avoids duplicating the repo-picker UI in two places.
 */
export function AuthPage({ onClose }: { onClose?: () => void } = {}) {
  const ws = useWorkspace()
  const [mode, setMode] = useState<Mode>("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingNotice, setPendingNotice] = useState<string | null>(null)
  const [externalAuth, setExternalAuth] = useState<{ enabled: boolean; label?: string } | null>(null)

  useEffect(() => {
    let alive = true
    fetch("/api/auth/external/status")
      .then((r) => r.json())
      .then((r: any) => { if (alive) setExternalAuth(r) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

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
        return
      }
      if (onClose) onClose()
    } finally {
      setBusy(false)
    }
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
        {mode === "login" && externalAuth?.enabled && (
          <div className="flex flex-col gap-2 mb-4">
            <a
              href="/api/auth/external/start"
              className="flex items-center justify-center gap-2 h-9 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 font-medium"
            >
              {externalAuth.label ?? "SSO Login"}
            </a>
            <div className="flex items-center gap-2 text-xs text-gray-400 my-1">
              <div className="flex-1 border-t border-gray-200" />
              or
              <div className="flex-1 border-t border-gray-200" />
            </div>
          </div>
        )}
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
            <div className="text-[11px] text-gray-400 leading-relaxed">
              Just creates your account. Set up your personal repo afterwards in
              Settings → Personal Repo.
            </div>
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
