/**
 * New Loop dialog. Layout/structure ported from phase1-prototype's
 * NewLoopDialog (DialogField + repo dropdown + slug preview). v5 has
 * the repo picker (5.3); personal-context picker comes later.
 */
import { useEffect, useRef, useState, type FormEvent } from "react"
import { listSandboxes, listRepos, listVaults, type SandboxEntry, type RepoEntry } from "../../api"

export function NewLoopDialog({
  onClose,
  onCreate,
  initialTitle,
}: {
  onClose: () => void
  onCreate: (opts: { title: string; repo?: string; sandbox?: string; vault?: string }) => Promise<string> | string
  initialTitle?: string
}) {
  const [title, setTitle] = useState(initialTitle ?? "")
  const [repo, setRepo] = useState("")
  const [sandbox, setSandbox] = useState("")
  const [vault, setVault] = useState("default")
  const [repos, setRepos] = useState<RepoEntry[]>([])
  const [sandboxes, setSandboxes] = useState<SandboxEntry[]>([])
  const [vaults, setVaults] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listRepos().then(setRepos)
    listSandboxes().then((xs) => {
      setSandboxes(xs)
      // Auto-pick a default when sandboxes exist. Preference: explicit "default"
      // (the conventional name), else the alphabetical first (server already
      // sorts). User can still pick "(none)" to opt out.
      if (xs.length > 0) {
        const preferred = xs.find((e) => e.name === "default") ?? xs[0]
        setSandbox(preferred.name)
      }
    })
    listVaults().then((vs) => {
      setVaults(vs)
      // Preferred default = "default" if available, else first vault, else
      // leave empty (server will warn but loop still spawns).
      if (vs.includes("default")) setVault("default")
      else if (vs.length > 0) setVault(vs[0])
    })
    inputRef.current?.focus()
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onCreate({
        title: title.trim() || "untitled",
        repo: repo || undefined,
        sandbox: sandbox || undefined,
        vault: vault || undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-4">New loop</div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogField label="Repo" hint="决定 workdir。可选 — 不选就是空 workdir。">
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white"
            >
              <option value="">(none — empty workdir)</option>
              {repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                  {r.remote ? ` · ${r.remote}` : ""}
                </option>
              ))}
            </select>
            {repos.length === 0 && (
              <div className="text-[11px] text-gray-400 mt-1">
                还没注册的 repo。在 ~/.loopat/context/repos/ 下 git clone 一个进来。
              </div>
            )}
          </DialogField>

          <DialogField label="Sandbox" hint="runtime toolchain (mise.toml). Not selected = inherit host PATH.">
            <select
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white"
            >
              <option value="">(none)</option>
              {sandboxes.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </select>
            {sandboxes.length === 0 && (
              <div className="text-[11px] text-gray-400 mt-1">
                No sandboxes. Create one in Context → Sandboxes.
              </div>
            )}
          </DialogField>

          <DialogField label="Vault" hint="which keychain to inject — only this vault's secrets are visible inside the loop's sandbox.">
            <select
              value={vault}
              onChange={(e) => setVault(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white"
            >
              {vaults.length === 0 && <option value="default">default</option>}
              {vaults.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {vaults.length === 0 && (
              <div className="text-[11px] text-gray-400 mt-1">
                No vaults yet — using the default. Create more under{" "}
                <code className="bg-gray-100 px-1 rounded">personal/.loopat/vaults/&lt;name&gt;/</code>{" "}
                to isolate prod / test credentials.
              </div>
            )}
          </DialogField>

          <DialogField label="Name" hint="optional · 不填时显示 untitled">
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="refactor-gateway"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
            />
          </DialogField>

          <div className="text-[11px] text-gray-400 -mt-2">
            context (knowledge / notes / personal) 默认全挂；personal 子集 picker 后续 phase 再加
          </div>

          <div className="flex justify-end gap-2 mt-2 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100"
            >
              cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? "creating…" : "create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DialogField({
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
