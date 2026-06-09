/**
 * GitHub device-flow login. Asks the server for a code, shows it, opens the
 * verification page, polls until the user approves — then hands the token to
 * the personal-repo picker (pick existing / create new / paste crypt key). When
 * the repo is imported, re-checks the gate to advance.
 */
import { useEffect, useRef, useState } from "react"
import { deviceStart, devicePoll, getOnboarding, type OnboardingStatus } from "../api"
import { PersonalRepoPanel } from "./dialog/PersonalRepoPanel"
import { copyText } from "@/lib/clipboard"

export function OnboardingDevice({
  show,
  onAdvance,
}: {
  show: { title: string; description?: string }
  onAdvance: (next: OnboardingStatus) => void
}) {
  const [code, setCode] = useState<{ user_code: string; verification_uri: string; device_code: string; interval: number } | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [waiting, setWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  const start = async () => {
    setError("")
    const r = await deviceStart()
    if ("error" in r) { setError(r.error); return }
    setCode(r)
    setWaiting(true)
    // Don't auto-jump — show the code first, let the user open GitHub when ready.
    poll(r.device_code, r.interval)
  }

  const poll = (deviceCode: string, interval: number) => {
    timer.current = window.setTimeout(async () => {
      const r = await devicePoll(deviceCode)
      if (r.status === "ok") { setWaiting(false); setToken(r.token); return }
      if (r.status === "error") { setWaiting(false); setError(r.error); return }
      const next = r.status === "slow_down" ? interval + 5 : interval
      poll(deviceCode, next)
    }, interval * 1000)
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Logged in → hand off to the existing repo picker (token prefilled).
  if (token) {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="text-2xl mb-4">选择个人仓库</div>
        <PersonalRepoPanel initialToken={token} onDone={() => getOnboarding().then((s) => s && onAdvance(s))} />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">{show.title}</div>
      {show.description && <p className="text-sm text-gray-600 leading-relaxed mb-5">{show.description}</p>}

      {!code ? (
        <button onClick={start} className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700">
          用 GitHub 登录 →
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">1. 记下/复制这个码:</p>
          <div className="flex items-center gap-3">
            <code className="text-2xl font-mono tracking-widest bg-gray-50 border border-gray-200 rounded px-4 py-2">{code.user_code}</code>
            <button
              onClick={async () => { if (await copyText(code.user_code)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <p className="text-sm text-gray-600">2. 打开 GitHub 输码授权,完成后<b>回到本标签页</b>,会自动继续:</p>
          <a
            href={code.verification_uri}
            target="_blank"
            rel="noreferrer"
            className="w-fit px-4 h-9 inline-flex items-center rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
          >
            打开 GitHub 授权 →
          </a>
          {waiting && <p className="text-xs text-gray-400">⏳ 等待授权…授权后回到这里,会自动让你选个人仓库,别关页面。</p>}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
