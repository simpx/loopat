import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export function SudoPasswordDialog() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const unlisten = listen("server-password-prompt", () => {
      setOpen(true)
      setTimeout(() => inputRef.current?.focus(), 100)
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  const submit = async () => {
    if (busy || !password) return
    setBusy(true)
    try {
      await invoke("write_server_stdin", { input: password + "\n" })
      setPassword("")
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/30 flex items-center justify-center"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[380px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-1">
          sudo 需要密码
        </div>
        <div className="text-xs text-gray-500 mb-4">
          server 正在请求 sudo 权限，请输入密码
        </div>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit() }}
          placeholder="sudo password"
          autoFocus
          autoComplete="current-password"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100"
          >
            cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !password}
            className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? "sending…" : "submit"}
          </button>
        </div>
      </div>
    </div>
  )
}
