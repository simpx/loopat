import { ShieldIcon, AlertTriangleIcon } from "lucide-react"

interface PermissionPromptProps {
  toolName: string
  title: string
  displayName: string
  onAllow: () => void
  onDeny: () => void
}

export default function PermissionPrompt({
  toolName,
  title,
  displayName,
  onAllow,
  onDeny,
}: PermissionPromptProps) {
  return (
    <div className="rounded-lg border border-amber-200 bg-gradient-to-b from-amber-50/80 to-amber-50/30 p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="flex items-center justify-center h-7 w-7 rounded-full bg-amber-100 shrink-0 mt-0.5">
          <ShieldIcon className="h-3.5 w-3.5 text-amber-600" />
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-amber-800 leading-snug">
            {title || "Permission required"}
          </p>
          <p className="text-[11px] text-amber-600 mt-0.5 leading-relaxed">
            <span className="font-medium">{toolName}</span>
            {displayName && displayName !== toolName ? (
              <span> — {displayName}</span>
            ) : null}
          </p>
        </div>
      </div>

      {/* Warning hint */}
      <div className="flex items-start gap-1.5 text-[10px] text-amber-500 bg-amber-100/50 rounded-md px-2.5 py-1.5">
        <AlertTriangleIcon className="h-3 w-3 shrink-0 mt-px" />
        <span>This tool can modify your system. Only allow if you trust the action.</span>
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onAllow}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Allow
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-700 active:bg-gray-100 transition-colors"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Deny
        </button>
      </div>
    </div>
  )
}
