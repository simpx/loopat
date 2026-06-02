/**
 * Onboarding "info" remediation: instructions the user must act on outside
 * loopat (register an ssh key, request repo access, …). Shows the provider's
 * text + copyable values + help links + a "re-check" button that re-runs the
 * provider's onboarding check. No auto-poll — the user clicks re-check when done.
 */
import { useState } from "react"
import { getOnboarding, type OnboardingStatus } from "../api"

export function OnboardingInfo({
  show,
  onAdvance,
}: {
  show: {
    title: string
    description?: string
    values?: { label: string; value: string }[]
    help?: { label: string; url: string }[]
  }
  onAdvance: (next: OnboardingStatus) => void
}) {
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const recheck = async () => {
    setChecking(true)
    const next = await getOnboarding()
    setChecking(false)
    if (next) onAdvance(next)
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">🔐 {show.title}</div>
      {show.description && (
        <p className="text-sm text-gray-600 leading-relaxed mb-4 whitespace-pre-line">{show.description}</p>
      )}

      {show.values && show.values.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {show.values.map((v) => (
            <div key={v.label}>
              <div className="text-[11px] text-gray-500 mb-1">{v.label}</div>
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 break-all bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-[10px] font-mono">{v.value}</code>
                <button
                  onClick={() => { navigator.clipboard.writeText(v.value); setCopied(v.label); setTimeout(() => setCopied(null), 1500) }}
                  className="shrink-0 text-[11px] text-gray-500 hover:text-gray-800 px-1.5 py-1"
                >
                  {copied === v.label ? "copied" : "copy"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {show.help && show.help.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-5">
          {show.help.map((h) => (
            <a
              key={h.url}
              href={h.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {h.label} →
            </a>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={recheck}
          disabled={checking}
          className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
        >
          {checking ? "检查中…" : "我已配置好,重新检查"}
        </button>
      </div>
    </div>
  )
}
