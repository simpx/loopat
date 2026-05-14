import { useState } from "react"
import { CheckIcon, ChevronRightIcon, HelpCircleIcon, SendIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface QuestionOption {
  label: string
  description: string
}

interface QuestionDef {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

interface AskUserQuestionRendererProps {
  questions: QuestionDef[]
  toolUseId?: string
  onAnswers?: (toolUseId: string, answers: Record<string, string>) => void
  onDismiss?: (toolUseId: string) => void
  disabled?: boolean
}

export default function AskUserQuestionRenderer({
  questions: rawQuestions,
  toolUseId,
  onAnswers,
  onDismiss,
  disabled = false,
}: AskUserQuestionRendererProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const [activeTab, setActiveTab] = useState(0)

  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.filter(
        (q) =>
          q != null &&
          typeof q.question === "string" &&
          q.question.length > 0 &&
          Array.isArray(q.options),
      )
    : []

  if (questions.length === 0) return null

  const handleSelect = (questionText: string, label: string) => {
    if (disabled || submitted) return
    setCustomInputs((prev) => {
      if (!prev[questionText]) return prev
      const next = { ...prev }
      delete next[questionText]
      return next
    })
    setAnswers((prev) => ({ ...prev, [questionText]: label }))
  }

  const handleMultiSelect = (questionText: string, label: string) => {
    if (disabled || submitted) return
    setCustomInputs((prev) => {
      if (!prev[questionText]) return prev
      const next = { ...prev }
      delete next[questionText]
      return next
    })
    setAnswers((prev) => {
      const current = (prev[questionText] ?? "").split(",").filter(Boolean)
      const idx = current.indexOf(label)
      if (idx >= 0) {
        current.splice(idx, 1)
      } else {
        current.push(label)
      }
      return { ...prev, [questionText]: current.join(",") }
    })
  }

  const handleCustomInput = (questionText: string, value: string) => {
    if (disabled || submitted) return
    setCustomInputs((prev) => ({ ...prev, [questionText]: value }))
    setAnswers((prev) => {
      if (!prev[questionText]) return prev
      const next = { ...prev }
      delete next[questionText]
      return next
    })
  }

  const effectiveAnswer = (q: QuestionDef): string =>
    customInputs[q.question]?.trim() || answers[q.question] || ""

  const allAnswered = questions.every((q) => {
    const ans = effectiveAnswer(q)
    return ans !== undefined && ans !== ""
  })

  const isQuestionAnswered = (q: QuestionDef): boolean => {
    const ans = effectiveAnswer(q)
    return ans !== undefined && ans !== ""
  }

  const handleSubmit = () => {
    if (!allAnswered || !toolUseId || !onAnswers || submitted) return
    setSubmitted(true)
    const merged: Record<string, string> = {}
    for (const q of questions) {
      merged[q.question] = effectiveAnswer(q)
    }
    onAnswers(toolUseId, merged)
  }

  const handleDismiss = () => {
    if (disabled || submitted) return
    setSubmitted(true)
    onDismiss?.(toolUseId || "")
  }

  const goToNextTab = () => {
    setActiveTab((prev) => Math.min(prev + 1, questions.length - 1))
  }

  const tabLabel = (q: QuestionDef, idx: number): string => {
    if (q.header) return q.header
    return `Question ${idx + 1}`
  }

  const q = questions[activeTab]
  const selected = answers[q.question] ?? ""
  const selectedSet = new Set(selected.split(",").filter(Boolean))
  const options = Array.isArray(q.options) ? q.options : []
  const customValue = customInputs[q.question] ?? ""

  return (
    <div className="space-y-3">
      {/* Header with dismiss */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] text-violet-600 font-medium">
          <HelpCircleIcon className="h-3.5 w-3.5" />
          <span>
            {questions.length > 1
              ? `Question ${activeTab + 1} of ${questions.length}`
              : "Question"}
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={disabled || submitted}
          className="flex items-center justify-center h-5 w-5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab bar — only shown when multiple questions */}
      {questions.length > 1 && (
        <div className="flex gap-1 border-b border-gray-200">
          {questions.map((tq, ti) => {
            const answered = isQuestionAnswered(tq)
            const isActive = ti === activeTab
            return (
              <button
                key={ti}
                type="button"
                disabled={disabled || submitted}
                onClick={() => setActiveTab(ti)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium transition-colors border-b-2 -mb-[1px] whitespace-nowrap",
                  isActive
                    ? "border-violet-500 text-violet-700"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
                  (disabled || submitted) && "cursor-default opacity-70",
                )}
              >
                {answered && <CheckIcon className="h-3 w-3 text-emerald-500" />}
                {tabLabel(tq, ti)}
              </button>
            )
          })}
        </div>
      )}

      {/* Active question content — scrollable */}
      <div className="overflow-y-auto max-h-[260px] space-y-1.5">
        {q.header && (
          <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
            {q.header}
          </div>
        )}
        <p className="text-[12px] text-gray-800 font-medium">{q.question}</p>

        {/* Option buttons */}
        <div className="space-y-1">
          {options.map((opt, oi) => {
            const label = typeof opt?.label === "string" ? opt.label : ""
            const desc = typeof opt?.description === "string" ? opt.description : ""
            if (!label) return null

            const isSelected = q.multiSelect
              ? selectedSet.has(label)
              : selected === label
            return (
              <button
                key={oi}
                type="button"
                disabled={disabled || submitted}
                onClick={() =>
                  q.multiSelect
                    ? handleMultiSelect(q.question, label)
                    : handleSelect(q.question, label)
                }
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md border text-[12px] transition-colors",
                  isSelected
                    ? "border-violet-400 bg-violet-50 text-violet-900"
                    : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50",
                  (disabled || submitted) && "cursor-default opacity-70",
                )}
              >
                <div className="flex items-center gap-2">
                  {q.multiSelect ? (
                    <span
                      className={cn(
                        "h-3.5 w-3.5 rounded border flex-shrink-0 flex items-center justify-center",
                        isSelected ? "border-violet-500 bg-violet-500" : "border-gray-300",
                      )}
                    >
                      {isSelected && (
                        <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "h-3.5 w-3.5 rounded-full border flex-shrink-0",
                        isSelected ? "border-violet-500 bg-violet-500" : "border-gray-300",
                      )}
                    >
                      {isSelected && (
                        <span className="block h-1.5 w-1.5 rounded-full bg-white m-0.5" />
                      )}
                    </span>
                  )}
                  <span>{label}</span>
                  {desc && (
                    <span className="text-[10px] text-gray-400">— {desc}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* Custom text input for free-form answers */}
        <input
          type="text"
          value={customValue}
          onChange={(e) => handleCustomInput(q.question, e.target.value)}
          placeholder="Or type your own answer..."
          disabled={disabled || submitted}
          className={cn(
            "w-full px-3 py-1.5 rounded-md border text-[12px] outline-none transition-colors",
            customValue
              ? "border-violet-300 bg-violet-50/50 text-violet-900 placeholder:text-violet-300"
              : "border-gray-200 bg-white text-gray-700 placeholder:text-gray-300 hover:border-gray-300 focus:border-violet-300",
            (disabled || submitted) && "cursor-default opacity-70",
          )}
        />
      </div>

      {/* Bottom bar: next tab + submit */}
      {!submitted && (
        <div className="flex items-center justify-between pt-1">
          {questions.length > 1 && activeTab < questions.length - 1 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={goToNextTab}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Next
              <ChevronRightIcon className="h-3 w-3" />
            </button>
          ) : (
            <div />
          )}
          <button
            type="button"
            disabled={!allAnswered || disabled}
            onClick={handleSubmit}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              allAnswered
                ? "bg-gray-900 text-white hover:bg-gray-800"
                : "bg-gray-100 text-gray-400 cursor-not-allowed",
            )}
          >
            <SendIcon className="h-3 w-3" />
            Submit
          </button>
        </div>
      )}

      {submitted && (
        <p className="text-[11px] text-emerald-600 font-medium text-right">Submitted</p>
      )}
    </div>
  )
}
