/**
 * Onboarding step shown when the active git-host provider requires it (see
 * GitHostProvider.isOnboarded) and the user is missing required credentials —
 * e.g. an AI api key. The provider supplies the `missing` items (label + help
 * URL); this card collects values and writes them to the user's vault.
 *
 * Hard gate: there is no "skip". Saving any one of the missing keys re-checks
 * onboarding via `onSaved`; once the provider reports done, the app proceeds.
 */
import { useState } from "react"
import { writeVaultEnv, type OnboardingMissing } from "../api"

export function OnboardingKeysCard({
  missing,
  onSaved,
}: {
  missing: OnboardingMissing[]
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const anyFilled = missing.some((m) => (values[m.id] ?? "").trim().length > 0)

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const filled = missing.filter((m) => (values[m.id] ?? "").trim().length > 0)
      for (const m of filled) {
        const r = await writeVaultEnv(m.id, (values[m.id] ?? "").trim())
        if (!r.ok) {
          setError(r.error ?? `couldn't save ${m.label}`)
          return
        }
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-2xl mb-2">🔑 One more step</div>
      <p className="text-sm text-gray-600 leading-relaxed mb-5">
        loopat needs at least one AI API key to run. Add <b>any one</b> of the
        keys below — it's stored in your own encrypted vault, never on the
        server.
      </p>

      <div className="flex flex-col gap-4">
        {missing.map((m) => (
          <div key={m.id} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-medium text-gray-800">{m.label}</label>
              {m.help && (
                <a
                  href={m.help}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  get a key →
                </a>
              )}
            </div>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`paste your ${m.label}`}
              value={values[m.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [m.id]: e.target.value }))}
              className="h-9 px-3 rounded border border-gray-300 text-sm font-mono focus:outline-none focus:border-gray-500"
            />
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={!anyFilled || saving}
          className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save & continue →"}
        </button>
        <span className="text-xs text-gray-400">at least one key required</span>
      </div>
    </div>
  )
}
