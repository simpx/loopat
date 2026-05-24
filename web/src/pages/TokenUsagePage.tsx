import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { BarChart3, Hash, MessageSquare, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"
import { getDailyTokenUsage, getLoopTokenUsage, type DailyUsage, type LoopTokenUsage } from "@/api"

type ViewMode = "models" | "daily" | "loops"
type TimeRange = "today" | "7d" | "30d" | "all"
type SortDir = "asc" | "desc" | null

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function fmtDateFull(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function nextSortDir(current: SortDir): SortDir {
  if (!current) return "desc"
  if (current === "desc") return "asc"
  return null
}

function SortableTh({ label, field, sortField, sortDir, onSort, className }: {
  label: string
  field: string
  sortField: string | null
  sortDir: SortDir
  onSort: (f: string) => void
  className?: string
}) {
  const active = sortField === field
  return (
    <th
      className={`px-4 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700 transition-colors ${className ?? ""}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && sortDir === "desc" ? <ArrowDown className="h-3 w-3" />
          : active && sortDir === "asc" ? <ArrowUp className="h-3 w-3" />
          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  )
}

// ── Simple SVG horizontal bar chart ──

function HBarChart({ data, maxVal, height = 24, gap = 6 }: {
  data: { label: string; input: number; output: number }[]
  maxVal: number
  height?: number
  gap?: number
}) {
  const w = 280
  const totalH = data.length * (height + gap)
  return (
    <svg width={w} height={totalH} className="shrink-0">
      {data.map((d, i) => {
        const y = i * (height + gap)
        const inputW = maxVal > 0 ? (d.input / maxVal) * w : 0
        const outputW = maxVal > 0 ? (d.output / maxVal) * w : 0
        return (
          <g key={d.label}>
            <rect x={0} y={y} width={inputW} height={height} rx={3} fill="#3b82f6" opacity={0.7} />
            <rect x={inputW} y={y} width={outputW} height={height} rx={3} fill="#22c55e" opacity={0.7} />
            <text x={inputW + outputW + 4} y={y + height / 2} dominantBaseline="central" className="fill-gray-500 text-[10px]">{d.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Simple SVG area chart ──

function AreaChart({ data, w = 600, h = 180 }: {
  data: { date: string; input: number; output: number }[]
  w?: number
  h?: number
}) {
  const pad = { top: 10, right: 10, bottom: 24, left: 50 }
  const pw = w - pad.left - pad.right
  const ph = h - pad.top - pad.bottom
  const maxVal = Math.max(1, ...data.map(d => d.input + d.output))

  const xScale = (i: number) => pad.left + (data.length > 1 ? (i / (data.length - 1)) * pw : pw / 2)
  const yScale = (v: number) => pad.top + ph - (v / maxVal) * ph

  const inputPoints = data.map((d, i) => `${xScale(i)},${yScale(d.input)}`).join(" ")
  const totalPoints = data.map((d, i) => `${xScale(i)},${yScale(d.input + d.output)}`).join(" ")
  const bottomLine = `${xScale(data.length - 1)},${pad.top + ph} ${xScale(0)},${pad.top + ph}`

  // Y axis ticks
  const yTicks = [0, maxVal / 2, maxVal].map(v => ({
    y: yScale(v),
    label: formatTokens(v),
  }))

  return (
    <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {yTicks.map(t => (
        <g key={t.label}>
          <line x1={pad.left} y1={t.y} x2={w - pad.right} y2={t.y} stroke="#e5e7eb" strokeDasharray="3,2" />
          <text x={pad.left - 6} y={t.y} textAnchor="end" dominantBaseline="central" className="fill-gray-400 text-[9px]">{t.label}</text>
        </g>
      ))}
      {/* Area: output (stacked on top of input) */}
      <polygon points={`${totalPoints} ${bottomLine}`} fill="#22c55e" opacity={0.2} />
      <polyline points={totalPoints} fill="none" stroke="#22c55e" strokeWidth={1.5} opacity={0.6} />
      {/* Area: input only */}
      <polygon points={`${inputPoints} ${bottomLine}`} fill="#3b82f6" opacity={0.2} />
      <polyline points={inputPoints} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
      {/* Date labels */}
      {data.filter((_, i) => data.length <= 14 || i % Math.ceil(data.length / 14) === 0 || i === data.length - 1).map((d, i) => {
        const origIdx = data.indexOf(d)
        return (
          <text key={d.date} x={xScale(origIdx)} y={h - 4} textAnchor="middle" className="fill-gray-400 text-[9px]">
            {fmtDate(d.date)}
          </text>
        )
      })}
    </svg>
  )
}

// ── Model summary view ──

function ModelsView({ dailyUsage, timeRange }: { dailyUsage: DailyUsage; timeRange: TimeRange }) {
  const [sortField, setSortField] = useState<string | null>("total")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const rawEntries = useMemo(() => {
    const cutoff = timeRange === "today" ? daysAgo(0)
      : timeRange === "7d" ? daysAgo(7)
      : timeRange === "30d" ? daysAgo(30)
      : ""
    const modelMap: Record<string, { inputTokens: number; outputTokens: number }> = {}
    for (const [model, dates] of Object.entries(dailyUsage)) {
      for (const [date, u] of Object.entries(dates)) {
        if (cutoff && date < cutoff) continue
        const entry = modelMap[model] ?? { inputTokens: 0, outputTokens: 0 }
        entry.inputTokens += u.inputTokens
        entry.outputTokens += u.outputTokens
        modelMap[model] = entry
      }
    }
    return Object.entries(modelMap)
      .map(([model, u]) => ({ model, ...u, total: u.inputTokens + u.outputTokens }))
  }, [dailyUsage, timeRange])

  const entries = useMemo(() => {
    const sorted = [...rawEntries]
    if (sortField && sortDir) {
      sorted.sort((a: any, b: any) => {
        const va = sortField === "model" ? a.model : a[sortField] ?? 0
        const vb = sortField === "model" ? b.model : b[sortField] ?? 0
        if (typeof va === "string" && typeof vb === "string") return sortDir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb)
        return sortDir === "desc" ? (vb as number) - (va as number) : (va as number) - (vb as number)
      })
    }
    return sorted
  }, [rawEntries, sortField, sortDir])

  const handleSort = (f: string) => {
    if (sortField === f) {
      const next = nextSortDir(sortDir)
      if (!next) { setSortField(null); setSortDir(null) }
      else setSortDir(next)
    } else {
      setSortField(f)
      setSortDir("desc")
    }
  }

  const grandTotal = entries.reduce((s, e) => s + e.total, 0)
  const maxTotal = entries[0]?.total ?? 1
  const chartData = entries.map(e => ({ label: e.model, input: e.inputTokens, output: e.outputTokens }))

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] text-gray-500 mb-1">Total Tokens</div>
          <div className="text-xl font-semibold text-gray-900">{formatTokens(grandTotal)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] text-gray-500 mb-1">Prompt</div>
          <div className="text-xl font-semibold text-blue-600">{formatTokens(entries.reduce((s, e) => s + e.inputTokens, 0))}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] text-gray-500 mb-1">Completion</div>
          <div className="text-xl font-semibold text-green-600">{formatTokens(entries.reduce((s, e) => s + e.outputTokens, 0))}</div>
        </div>
      </div>

      {/* Bar chart + legend */}
      {entries.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-4 mb-3">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Token Distribution</span>
            <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500 opacity-70" /> Input</span>
            <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2.5 h-2.5 rounded-sm bg-green-500 opacity-70" /> Output</span>
          </div>
          <div className="overflow-x-auto">
            <HBarChart data={chartData.slice(0, 12)} maxVal={maxTotal} />
          </div>
        </div>
      )}

      {/* Model table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/50">
              <SortableTh label="Model" field="model" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-left" />
              <SortableTh label="Input" field="inputTokens" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableTh label="Output" field="outputTokens" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableTh label="Total" field="total" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">%</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.model} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                <td className="px-4 py-2.5">
                  <code className="text-[12px] text-gray-800">{e.model}</code>
                </td>
                <td className="px-4 py-2.5 text-right text-[12px] text-blue-600 tabular-nums">{formatTokens(e.inputTokens)}</td>
                <td className="px-4 py-2.5 text-right text-[12px] text-green-600 tabular-nums">{formatTokens(e.outputTokens)}</td>
                <td className="px-4 py-2.5 text-right text-[12px] text-gray-900 font-medium tabular-nums">{formatTokens(e.total)}</td>
                <td className="px-4 py-2.5 text-right text-[11px] text-gray-400 tabular-nums">
                  {grandTotal > 0 ? ((e.total / grandTotal) * 100).toFixed(1) : 0}%
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[12px] text-gray-400 italic">No token usage data</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Daily breakdown view ──

function DailyView({ dailyUsage, timeRange }: { dailyUsage: DailyUsage; timeRange: TimeRange }) {
  const { dates, models, data, chartData } = useMemo(() => {
    const modelSet = new Set(Object.keys(dailyUsage))
    const dateSet = new Set<string>()
    for (const m of Object.keys(dailyUsage)) {
      for (const d of Object.keys(dailyUsage[m])) dateSet.add(d)
    }
    const sortedDates = Array.from(dateSet).sort()
    const sortedModels = Array.from(modelSet).sort()

    const cutoff = timeRange === "today" ? daysAgo(0)
      : timeRange === "7d" ? daysAgo(7)
      : timeRange === "30d" ? daysAgo(30)
      : ""
    const filteredDates = cutoff ? sortedDates.filter(d => d >= cutoff) : sortedDates

    const data: Record<string, Record<string, number>> = {}
    for (const model of sortedModels) {
      data[model] = {}
      for (const date of filteredDates) {
        data[model][date] = (dailyUsage[model]?.[date]?.inputTokens ?? 0) + (dailyUsage[model]?.[date]?.outputTokens ?? 0)
      }
    }

    const chartData = filteredDates.map(date => {
      let input = 0; let output = 0
      for (const m of sortedModels) {
        input += dailyUsage[m]?.[date]?.inputTokens ?? 0
        output += dailyUsage[m]?.[date]?.outputTokens ?? 0
      }
      return { date, input, output }
    })

    return { dates: filteredDates, models: sortedModels, data, chartData }
  }, [dailyUsage, timeRange])

  if (dates.length === 0) {
    return <div className="text-center py-8 text-[12px] text-gray-400 italic">No daily data for this time range</div>
  }

  return (
    <div>
      {/* Area chart */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-4 mb-2">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Daily Trend</span>
          <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500 opacity-70" /> Input</span>
          <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2.5 h-2.5 rounded-sm bg-green-500 opacity-20" /> Output</span>
        </div>
        <AreaChart data={chartData} />
      </div>

      {/* Pivot table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[500px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/50">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50/50">Date</th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Total</th>
                {models.map(m => (
                  <th key={m} className="text-right px-3 py-2.5 text-[10px] font-medium text-gray-400 uppercase tracking-wider max-w-[120px]">
                    <span className="truncate block">{m}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map(d => (
                <tr key={d} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                  <td className="px-4 py-2 text-[12px] text-gray-700 sticky left-0 bg-white">{fmtDate(d)}</td>
                  <td className="px-4 py-2 text-right text-[12px] text-gray-900 font-medium tabular-nums">
                    {formatTokens(models.reduce((s, m) => s + (data[m]?.[d] ?? 0), 0))}
                  </td>
                  {models.map(m => (
                    <td key={m} className="px-3 py-2 text-right text-[11px] text-gray-500 tabular-nums">
                      {data[m]?.[d] ? formatTokens(data[m][d]) : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Per-loop view ──

function LoopsView({ loopUsage, timeRange }: { loopUsage: LoopTokenUsage[]; timeRange: TimeRange }) {
  const [sortField, setSortField] = useState<string | null>("lastActivity")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const cutoff = timeRange === "today" ? daysAgo(0)
    : timeRange === "7d" ? daysAgo(7)
    : timeRange === "30d" ? daysAgo(30)
    : ""
  const filtered = useMemo(() => {
    let list = cutoff
      ? loopUsage.filter(l => (l.lastActivity ?? "").slice(0, 10) >= cutoff)
      : [...loopUsage]
    if (sortField && sortDir) {
      list.sort((a: any, b: any) => {
        let va: any, vb: any
        if (sortField === "total") {
          va = a.inputTokens + a.outputTokens
          vb = b.inputTokens + b.outputTokens
        } else if (sortField === "title" || sortField === "lastActivity") {
          va = a[sortField] ?? ""
          vb = b[sortField] ?? ""
        } else {
          va = a[sortField] ?? 0
          vb = b[sortField] ?? 0
        }
        if (typeof va === "string" && typeof vb === "string") return sortDir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb)
        return sortDir === "desc" ? (vb as number) - (va as number) : (va as number) - (vb as number)
      })
    }
    return list
  }, [loopUsage, cutoff, sortField, sortDir])

  const handleSort = (f: string) => {
    if (sortField === f) {
      const next = nextSortDir(sortDir)
      if (!next) { setSortField(null); setSortDir(null) }
      else setSortDir(next)
    } else {
      setSortField(f)
      setSortDir("desc")
    }
  }

  const grandTotal = filtered.reduce((s, l) => s + l.inputTokens + l.outputTokens, 0)
  const navigate = useNavigate()

  return (
    <div>
      {/* Summary row */}
      <div className="flex items-center gap-4 mb-4 px-1">
        <span className="text-[13px] text-gray-600">
          <span className="font-semibold text-gray-900">{filtered.length}</span> loops ·{" "}
          <span className="font-semibold text-gray-900">{formatTokens(grandTotal)}</span> total tokens
        </span>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/50">
              <SortableTh label="Loop" field="title" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-left" />
              <th className="hidden sm:table-cell text-left px-4 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Models</th>
              <SortableTh label="Input" field="inputTokens" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableTh label="Output" field="outputTokens" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableTh label="Total" field="total" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableTh label="Last active" field="lastActivity" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right hidden sm:table-cell" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => {
              const total = l.inputTokens + l.outputTokens
              return (
                <tr
                  key={l.loopId}
                  className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors cursor-pointer"
                  onClick={() => navigate(`/loop/${l.loopId}`)}
                >
                  <td className="px-4 py-2.5">
                    <span className="text-[12px] text-gray-800 font-medium hover:text-blue-600">{l.title}</span>
                  </td>
                  <td className="hidden sm:table-cell px-4 py-2.5">
                    <code className="text-[11px] text-gray-500">{l.model}</code>
                  </td>
                  <td className="px-4 py-2.5 text-right text-[12px] text-blue-600 tabular-nums">{formatTokens(l.inputTokens)}</td>
                  <td className="px-4 py-2.5 text-right text-[12px] text-green-600 tabular-nums">{formatTokens(l.outputTokens)}</td>
                  <td className="px-4 py-2.5 text-right text-[12px] text-gray-900 font-medium tabular-nums">{formatTokens(total)}</td>
                  <td className="hidden sm:table-cell px-4 py-2.5 text-right text-[11px] text-gray-400">{fmtDateFull(l.lastActivity)}</td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[12px] text-gray-400 italic">
                  No loops with token usage{cutoff ? " in this range" : ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ──

const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
]

const VIEWS: { id: ViewMode; label: string; icon: React.ReactNode }[] = [
  { id: "models", label: "By Model", icon: <Hash className="h-3.5 w-3.5" /> },
  { id: "daily", label: "Daily", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: "loops", label: "By Loop", icon: <MessageSquare className="h-3.5 w-3.5" /> },
]

export function TokenUsagePage() {
  const navigate = useNavigate()
  const [view, setView] = useState<ViewMode>("models")
  const [timeRange, setTimeRange] = useState<TimeRange>("30d")
  const [dailyUsage, setDailyUsage] = useState<DailyUsage>({})
  const [loopUsage, setLoopUsage] = useState<LoopTokenUsage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      getDailyTokenUsage().then(setDailyUsage),
      getLoopTokenUsage().then(setLoopUsage),
    ]).finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="text-[13px] text-gray-400">loading token data…</div>
      </div>
    )
  }

  return (
    <div>
        {/* View tabs + time filter */}
        <div className="flex items-center gap-1 mb-6">
          {VIEWS.map(v => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium transition-colors ${
                view === v.id
                  ? "bg-white border border-gray-200 text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {v.icon}
              {v.label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex items-center gap-0.5">
            {TIME_RANGES.map(tr => (
              <button
                key={tr.id}
                type="button"
                onClick={() => setTimeRange(tr.id)}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                  timeRange === tr.id
                    ? "bg-white border border-gray-200 text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {view === "models" && <ModelsView dailyUsage={dailyUsage} timeRange={timeRange} />}
        {view === "daily" && <DailyView dailyUsage={dailyUsage} timeRange={timeRange} />}
        {view === "loops" && <LoopsView loopUsage={loopUsage} timeRange={timeRange} />}
    </div>
  )
}
