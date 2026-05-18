/**
 * Welcome card shown on the home / Loops list route when the user is
 * ready for onboarding but hasn't finished it.
 *
 * States (driven by GET /api/onboarding):
 *   - fresh   → "Start the onboarding loop" + "Skip" buttons
 *   - started → "Continue your onboarding" link to the in-progress loop
 *   - done    → component renders null (caller should hide)
 *
 * The "Start" flow:
 *   1. POST /api/onboarding/start → server creates a regular loop +
 *      marks state=started, returns loopId
 *   2. Navigate to /loop/<loopId> with router state { kickoff: "/loopat:onboarding" }
 *   3. LoopPage detects router state on WS connect and auto-enqueues that
 *      message, kicking off the loopat-onboarding skill in the agent
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { startOnboarding, markOnboardingDone, type OnboardingStatus } from "@/api"
import { useWorkspace } from "@/ctx"

const KICKOFF = "/loopat:onboarding"

export function WelcomeCard({
  status,
  onChange,
}: {
  status: OnboardingStatus
  /** Called after state mutates so the parent can re-fetch. */
  onChange: () => void
}) {
  const navigate = useNavigate()
  const ws = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status.state === "done") return null

  const start = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await startOnboarding()
    if (r.error || !r.loopId) {
      setBusy(false)
      setError(r.error ?? "启动失败")
      return
    }
    // Refresh the workspace's loops list BEFORE navigating — LoopPage looks
    // up the loop in ws.loops and Navigate("/loop")-redirects if it's missing,
    // which would bounce us right back to this Welcome card.
    await ws.refresh()
    setBusy(false)
    navigate(`/loop/${r.loopId}`, { state: { kickoff: KICKOFF } })
    onChange()
  }

  const resume = () => {
    if (!status.loopId) return
    navigate(`/loop/${status.loopId}`)
  }

  const skip = async () => {
    if (busy) return
    setBusy(true)
    await markOnboardingDone()
    setBusy(false)
    onChange()
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">👋 欢迎使用 loopat</div>
      {status.state === "fresh" ? (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-6">
            你的环境已经准备好。第一次用？大概 2 分钟，我会带你认识 loopat
            的几个核心概念（loop / sandbox / vault），配一条 ssh 挂载，演示几个
            常用动作。
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={start}
              disabled={busy}
              className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? "正在创建引导 loop…" : "开始引导 →"}
            </button>
            <button
              onClick={skip}
              disabled={busy}
              className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
            >
              我已经会了，跳过
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-6">
            你之前开始过新手引导但还没完成。可以继续，也可以直接跳过。
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={resume}
              className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
            >
              继续引导 →
            </button>
            <button
              onClick={skip}
              disabled={busy}
              className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
            >
              跳过，不再提示
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="mt-3 text-xs text-red-600">{error}</div>
      )}
    </div>
  )
}
