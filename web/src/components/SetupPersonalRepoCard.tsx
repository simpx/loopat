/**
 * First-thing-after-login card shown when the user hasn't imported their
 * personal repo yet. Explains loopat's "no database" data model and links
 * to Settings → Personal Repo.
 *
 * Dismiss is localStorage-only (`loopat:setupPersonalRepoDismissed`). There's
 * no per-user persistence here on purpose: without a personal repo there's
 * nowhere to store per-user state. The user can still operate loopat using
 * the workspace's shared provider keys; "skip" means "let me explore for now,
 * I'll come back if I need my own credentials."
 *
 * Once imported (personal.imported === true), this card hides naturally
 * regardless of the dismiss flag.
 */
import { useNavigate } from "react-router-dom"

const DISMISS_KEY = "loopat:setupPersonalRepoDismissed"

export function isSetupPersonalRepoDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

export function SetupPersonalRepoCard({
  onDismiss,
  hideSkip,
}: {
  onDismiss: () => void
  // Hard-gate mode (provider requires onboarding): no "skip" — the personal
  // repo is mandatory because the required keys live in its vault.
  hideSkip?: boolean
}) {
  const navigate = useNavigate()

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {}
    onDismiss()
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">👋 欢迎来到 loopat</div>
      <p className="text-sm text-gray-600 leading-relaxed mb-3">
        在你开始之前，建议先配一个<b>个人仓库</b>——
      </p>
      <p className="text-sm text-gray-600 leading-relaxed mb-3">
        loopat 一个反直觉的设计：服务器<b>不存你的数据</b>。你的 API key、ssh、token、
        笔记、memory 全部存在你自己的 GitHub 私有仓库里，由你自己持有解密密钥。
        这是 loopat 跟其他工具最大的不同。
      </p>
      <p className="text-sm text-gray-600 leading-relaxed mb-5">
        配置 3 步，大约 2 分钟：创建一个空的私有仓库 → 把 loopat 的 deploy key
        贴上去 → 把仓库 URL 填进来。配完后回到这个页面，AI 引导会自动接上。
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/settings/personal-repo")}
          className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
        >
          去配置个人仓库 →
        </button>
        {!hideSkip && (
          <button
            onClick={dismiss}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            跳过（先用 workspace 的 key）
          </button>
        )}
      </div>
      <p className="mt-4 text-[11px] text-gray-400 leading-relaxed">
        跳过后这个提示就不再出现。但 loopat 的核心安全模型依赖你的个人仓库 ——
        想用自己的凭据、记自己的 memory 时，从右上角 Settings → Personal Repo
        随时可以补上。
      </p>
    </div>
  )
}
