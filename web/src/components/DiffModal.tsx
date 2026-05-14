import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { LoaderIcon } from "lucide-react"

type DiffHunk = {
  header: string
  lines: DiffLine[]
}

type DiffLine = {
  type: "add" | "del" | "ctx"
  oldNum: number | null
  newNum: number | null
  text: string
}

function parseDiff(raw: string): { fileHeader: string; hunks: DiffHunk[] } {
  const lines = raw.split("\n")
  let fileHeader = ""
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let oldNum = 0
  let newNum = 0

  for (const line of lines) {
    if (line.startsWith("diff ")) {
      fileHeader = line
      continue
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk)
      oldNum = parseInt(hunkMatch[1], 10)
      newNum = parseInt(hunkMatch[3], 10)
      currentHunk = { header: line, lines: [] }
      continue
    }

    if (!currentHunk) continue

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", oldNum: null, newNum: newNum, text: line.slice(1) })
      newNum++
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", oldNum: oldNum, newNum: null, text: line.slice(1) })
      oldNum++
    } else {
      currentHunk.lines.push({ type: "ctx", oldNum: oldNum, newNum: newNum, text: line.startsWith(" ") ? line.slice(1) : line })
      oldNum++
      newNum++
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  return { fileHeader, hunks }
}

export function DiffModal({
  filePath,
  diff,
  loading,
  onClose,
}: {
  filePath: string
  diff: string | null
  loading: boolean
  onClose: () => void
}) {
  let parsed: ReturnType<typeof parseDiff> | null = null
  if (diff) {
    try { parsed = parseDiff(diff) } catch {}
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col bg-white p-0 gap-0" showCloseButton={false}>
        <div className="px-4 py-2.5 border-b border-gray-200 shrink-0 flex items-center gap-2">
          <span className="text-sm font-mono text-gray-900 truncate flex-1">{filePath}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm leading-none">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
              <LoaderIcon className="animate-spin" size={16} />
              <span className="text-sm">loading diff...</span>
            </div>
          ) : !parsed ? (
            <div className="py-16 text-center text-sm text-gray-400">empty diff</div>
          ) : (
            <div className="text-xs font-mono leading-5">
              {parsed.hunks.map((hunk, hi) => (
                <div key={hi} className="border-b border-gray-100 last:border-b-0">
                  {/* Hunk header */}
                  <div className="px-4 py-1 bg-blue-50/60 text-blue-700 border-b border-blue-100 sticky top-0">
                    {hunk.header}
                  </div>
                  {/* Hunk lines */}
                  {hunk.lines.map((ln, li) => {
                    const isAdd = ln.type === "add"
                    const isDel = ln.type === "del"
                    return (
                      <div
                        key={li}
                        className={
                          "flex " +
                          (isAdd ? "bg-emerald-50" : isDel ? "bg-red-50" : "")
                        }
                      >
                        {/* Old line number */}
                        <span className="w-14 shrink-0 text-right pr-3 py-px text-gray-300 select-none border-r border-gray-200 bg-gray-50">
                          {ln.oldNum ?? ""}
                        </span>
                        {/* New line number */}
                        <span className={
                          "w-14 shrink-0 text-right pr-3 py-px select-none border-r border-gray-200 " +
                          (isAdd ? "bg-emerald-100/70 text-emerald-700" : isDel ? "bg-red-100/70 text-red-500" : "text-gray-300 bg-gray-50")
                        }>
                          {ln.newNum ?? ""}
                        </span>
                        {/* Content */}
                        <span className={
                          "pl-3 py-px whitespace-pre-wrap break-all flex-1 " +
                          (isAdd ? "text-emerald-800" : isDel ? "text-red-700" : "text-gray-700")
                        }>
                          <span className="select-none">
                            {isAdd ? "+" : isDel ? "−" : " "}
                          </span>
                          {ln.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
