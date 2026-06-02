/**
 * Generic onboarding form renderer. The active git-host provider fully owns the
 * onboarding flow (see GitHostProvider.onboarding): it returns a form, loopat
 * renders it blindly here, submits the values, and renders whatever the provider
 * returns next — until `done`. loopat knows nothing about what the fields mean.
 */
import { useState } from "react"
import { submitOnboarding, type OnboardingForm as Form, type OnboardingStatus } from "../api"

export function OnboardingForm({
  form,
  onAdvance,
}: {
  form: Form
  // Called with the provider's next view after a successful submit. The parent
  // re-renders the next form, or clears the gate when done.
  onAdvance: (next: OnboardingStatus) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const filledCount = form.fields.filter((f) => (values[f.name] ?? "").trim().length > 0).length
  const canSubmit =
    form.require === "any" ? filledCount >= 1 : filledCount === form.fields.length

  const submit = async () => {
    setSaving(true)
    setError("")
    try {
      const trimmed: Record<string, string> = {}
      for (const f of form.fields) {
        const v = (values[f.name] ?? "").trim()
        if (v) trimmed[f.name] = v
      }
      const next = await submitOnboarding(trimmed)
      if ("error" in next) {
        setError(next.error)
        return
      }
      onAdvance(next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">{form.title}</div>
      {form.description && (
        <p className="text-sm text-gray-600 leading-relaxed mb-5">{form.description}</p>
      )}

      <div className="flex flex-col gap-4">
        {form.fields.map((f) => (
          <div key={f.name} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-medium text-gray-800">{f.label}</label>
              {f.help && (
                <a
                  href={f.help}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  获取 →
                </a>
              )}
            </div>
            <input
              type={f.type === "text" ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={f.placeholder ?? f.label}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className="h-9 px-3 rounded border border-gray-300 text-sm font-mono focus:outline-none focus:border-gray-500"
            />
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSubmit || saving}
          className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "处理中…" : form.submitLabel ?? "继续 →"}
        </button>
        {form.require === "any" && form.fields.length > 1 && (
          <span className="text-xs text-gray-400">至少填一个</span>
        )}
      </div>
    </div>
  )
}
