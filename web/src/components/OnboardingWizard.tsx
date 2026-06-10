import { useState, useEffect, useCallback } from "react"
import { submitOnboarding, listPersonalRepos, type OnboardingWizard as WizardData, type OnboardingStatus, type WizardStep } from "../api"

export function OnboardingWizard({
  wizard,
  onAdvance,
}: {
  wizard: WizardData
  onAdvance: (next: OnboardingStatus) => void
}) {
  const [currentStep, setCurrentStep] = useState(() => {
    const first = wizard.steps.findIndex((s) => !s.completed)
    return first >= 0 ? first : wizard.steps.length - 1
  })
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [kvRows, setKvRows] = useState<Array<{ key: string; val: string }>>([{ key: "", val: "" }])
  const [mountRows, setMountRows] = useState<Array<{ key: string; val: string }>>([{ key: "", val: "" }])
  const [tokenValidated, setTokenValidated] = useState(false)

  const steps = wizard.steps
  const step = steps[currentStep]
  const isLast = currentStep === steps.length - 1
  const hasRepoTokenField = step.fields?.some((f) => f.action === "personal-repo-token") ?? false

  const submitStep = async () => {
    setSaving(true)
    setError("")
    try {
      const trimmed: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) {
        const t = v.trim()
        if (t) trimmed[k] = t
      }
      if (step.collapsible && step.sections) {
        for (const row of kvRows) {
          if (row.key.trim() && row.val.trim()) trimmed[row.key.trim()] = row.val.trim()
        }
        for (const row of mountRows) {
          if (row.key.trim() && row.val.trim()) trimmed["__mount__" + row.key.trim()] = row.val.trim()
        }
      } else if (step.mode === "key-value-list") {
        for (const row of kvRows) {
          if (row.key.trim() && row.val.trim()) trimmed[row.key.trim()] = row.val.trim()
        }
      }
      if (Object.keys(trimmed).length === 0 && step.required) {
        setError("请填写必填项")
        return
      }
      if (Object.keys(trimmed).length > 0) {
        const r = await submitOnboarding(trimmed)
        if ("error" in r) { setError(r.error); return }
      }
      if (isLast) {
        const finish: OnboardingStatus = { gated: true, done: true }
        await fetch("/api/onboarding/done", { method: "POST" }).catch(() => {})
        await fetch("/api/personal/pull", { method: "POST" }).catch(() => {})
        await fetch("/api/personal/push", { method: "POST" }).catch(() => {})
        onAdvance(finish)
      } else {
        setCurrentStep((s) => s + 1)
        setValues({})
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto mt-8 px-6 py-8 rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="text-xl font-semibold mb-6">{wizard.title}</div>

      <div className="flex items-center gap-1 mb-8">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1">
            <div
              className={"flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium " + (
                s.completed || i < currentStep
                  ? "bg-green-100 text-green-700"
                  : i === currentStep
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-400"
              )}
            >
              {s.completed || i < currentStep ? "✓" : i + 1}
            </div>
            <span className={"text-xs " + (i === currentStep ? "text-gray-900 font-medium" : "text-gray-400")}>
              {s.label}
            </span>
            {i < steps.length - 1 && <div className="w-6 h-px bg-gray-200 mx-1" />}
          </div>
        ))}
      </div>

      <StepContent
        step={step}
        values={values}
        setValues={setValues}
        kvRows={kvRows}
        setKvRows={setKvRows}
        mountRows={mountRows}
        setMountRows={setMountRows}
        onTokenValidated={setTokenValidated}
      />

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        {step.mode === "link" && step.link ? (
          <a
            href={step.link.url}
            className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 inline-flex items-center"
          >
            {step.link.label} →
          </a>
        ) : hasRepoTokenField && !step.completed && !tokenValidated ? null : (
          <button
            onClick={submitStep}
            disabled={saving}
            className="px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
          >
            {saving ? "处理中…" : isLast ? "完成配置" : "下一步 →"}
          </button>
        )}
      </div>
    </div>
  )
}

function StepContent({
  step,
  values,
  setValues,
  kvRows,
  setKvRows,
  mountRows,
  setMountRows,
  onTokenValidated,
}: {
  step: WizardStep
  values: Record<string, string>
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  kvRows: Array<{ key: string; val: string }>
  setKvRows: React.Dispatch<React.SetStateAction<Array<{ key: string; val: string }>>>
  mountRows: Array<{ key: string; val: string }>
  setMountRows: React.Dispatch<React.SetStateAction<Array<{ key: string; val: string }>>>
  onTokenValidated: (v: boolean) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  if (step.collapsible) {
    return (
      <div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <span>{collapsed ? "▸" : "▾"}</span>
          <span>{step.label}</span>
          <span className="text-xs text-gray-400">(可选)</span>
        </button>
        {!collapsed && (
          <div className="mt-3 pl-4 border-l-2 border-gray-100">
            {step.sections?.map((sec) => (
              <div key={sec.title} className="mb-4">
                <div className="text-xs font-medium text-gray-700 mb-2">{sec.title}</div>
                {sec.mode === "key-value-list" && sec.action === "vault-env" && (
                  <KeyValueList rows={kvRows} setRows={setKvRows} keyPlaceholder="变量名" valPlaceholder="值" />
                )}
                {sec.action === "vault-mount" && (
                  <MountsTree />
                )}
              </div>
            ))}
            {step.fields && <FieldList fields={step.fields} values={values} setValues={setValues} />}
          </div>
        )}
      </div>
    )
  }

  if (step.mode === "radio" && step.fields) {
    return (
      <div>
        {step.description && <p className="text-sm text-gray-600 mb-4">{step.description}</p>}
        <div className="flex gap-3 mb-4">
          {step.fields.map((f) => (
            <button
              key={f.name}
              onClick={() => { setSelected(f.name); setValues({}) }}
              className={"flex-1 px-3 py-2 rounded border text-sm " + (
                selected === f.name
                  ? "border-gray-900 bg-gray-50 font-medium"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              )}
            >
              {f.label}
              {f.meta?.model && <span className="block text-xs text-gray-400 mt-0.5">{f.meta.model}</span>}
            </button>
          ))}
        </div>
        {selected && (() => {
          const field = step.fields!.find((f) => f.name === selected)!
          return (
            <div className="rounded border border-gray-200 p-4">
              {field.meta?.baseUrl && (
                <div className="mb-3">
                  <label className="text-xs text-gray-500">Base URL</label>
                  <div className="text-sm font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded mt-0.5">{field.meta.baseUrl}</div>
                </div>
              )}
              {field.meta?.model && (
                <div className="mb-3">
                  <label className="text-xs text-gray-500">Model</label>
                  <div className="text-sm font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded mt-0.5">{field.meta.model}</div>
                </div>
              )}
              <div>
                <div className="flex items-baseline justify-between">
                  <label className="text-xs font-medium text-gray-700">API Key</label>
                  {field.help && (
                    <a href={field.help} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:text-blue-800">获取 →</a>
                  )}
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  placeholder={field.placeholder ?? "粘贴 key"}
                  className="w-full h-9 px-3 rounded border border-gray-300 text-sm font-mono mt-1 focus:outline-none focus:border-gray-500"
                />
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  const hasRepoTokenField = step.fields?.some((f) => f.action === "personal-repo-token")
  if (hasRepoTokenField && !step.completed) {
    return <RepoTokenStep step={step} values={values} setValues={setValues} onValidated={onTokenValidated} />
  }

  if (step.mode === "link") {
    return (
      <div>
        {step.description && <p className="text-sm text-gray-600 mb-4">{step.description}</p>}
      </div>
    )
  }

  return (
    <div>
      {step.description && <p className="text-sm text-gray-600 mb-4">{step.description}</p>}
      {step.fields && <FieldList fields={step.fields} values={values} setValues={setValues} />}
    </div>
  )
}

function RepoTokenStep({
  step,
  values,
  setValues,
  onValidated,
}: {
  step: WizardStep
  values: Record<string, string>
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onValidated: (v: boolean) => void
}) {
  const field = step.fields?.find((f) => f.action === "personal-repo-token")
  const [token, setToken] = useState("")
  const [repos, setRepos] = useState<Array<{ name: string; path: string }>>([])
  const [login, setLogin] = useState("")
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [err, setErr] = useState("")
  const [repoName, setRepoName] = useState("loopat-personal")

  const fetchRepos = async () => {
    if (!token.trim()) return
    setLoading(true)
    setErr("")
    const r = await listPersonalRepos(token.trim())
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? "验证失败"); return }
    setRepos(r.repos)
    if (r.login) setLogin(r.login)
    setFetched(true)
    onValidated(true)
    const personal = r.repos.find((repo) => repo.name.includes("loopat-personal"))
    const defaultName = personal?.name ?? "loopat-personal"
    setRepoName(defaultName)
    if (field) setValues((v) => ({ ...v, [field.name]: token.trim(), __repoName__: defaultName }))
  }

  if (!field) return null

  return (
    <div>
      {step.description && <p className="text-sm text-gray-600 mb-4">{step.description}</p>}
      {!fetched ? (
        <div className="flex flex-col gap-3">
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-medium text-gray-800">{field.label}</label>
              {field.help && <a href={field.help} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:text-blue-800">获取 →</a>}
            </div>
            <input
              type="password"
              autoComplete="off"
              placeholder="粘贴 Code Private Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full h-9 px-3 rounded border border-gray-300 text-sm font-mono mt-1 focus:outline-none focus:border-gray-500"
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button
            onClick={fetchRepos}
            disabled={loading || !token.trim()}
            className="self-start px-4 h-9 rounded text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
          >
            {loading ? "验证中…" : "验证 Token"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-green-700 bg-green-50 px-3 py-2 rounded">
            ✓ 验证通过{login && ("，用户: " + login)}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">选择或创建个人仓库</label>
            {repos.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {repos.filter((r) => r.name.includes("personal") || r.name.includes("loopat")).map((r) => (
                  <button
                    key={r.name}
                    onClick={() => { setRepoName(r.name); setValues((v) => ({ ...v, __repoName__: r.name })) }}
                    className={"text-left px-3 py-2 rounded border text-sm " + (
                      repoName === r.name ? "border-gray-900 bg-gray-50 font-medium" : "border-gray-200 text-gray-600 hover:border-gray-300"
                    )}
                  >
                    {r.path || r.name}
                    {r.name.includes("loopat-personal") && <span className="text-xs text-gray-400 ml-2">(推荐)</span>}
                  </button>
                ))}
                <div className="mt-2">
                  <label className="text-[11px] text-gray-500">或输入新仓库名：</label>
                  <input
                    value={repoName}
                    onChange={(e) => { setRepoName(e.target.value); setValues((v) => ({ ...v, __repoName__: e.target.value })) }}
                    className="w-full h-8 px-2 rounded border border-gray-300 text-xs font-mono mt-0.5 focus:outline-none focus:border-gray-500"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <label className="text-[11px] text-gray-500">仓库名（将在你的命名空间下创建）</label>
                <input
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  className="w-full h-8 px-2 rounded border border-gray-300 text-xs font-mono mt-0.5 focus:outline-none focus:border-gray-500"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FieldList({
  fields,
  values,
  setValues,
}: {
  fields: Array<{ name: string; label: string; type?: string; help?: string; placeholder?: string }>
  values: Record<string, string>
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
}) {
  return (
    <div className="flex flex-col gap-4">
      {fields.map((f) => (
        <div key={f.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <label className="text-sm font-medium text-gray-800">{f.label}</label>
            {f.help && (
              <a href={f.help} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:text-blue-800">获取 →</a>
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
  )
}

function KeyValueList({
  rows,
  setRows,
  keyPlaceholder = "变量名",
  valPlaceholder = "值",
  valType = "password",
}: {
  rows: Array<{ key: string; val: string }>
  setRows: React.Dispatch<React.SetStateAction<Array<{ key: string; val: string }>>>
  keyPlaceholder?: string
  valPlaceholder?: string
  valType?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, key: e.target.value } : r))}
            className="flex-1 h-8 px-2 rounded border border-gray-300 text-xs font-mono focus:outline-none focus:border-gray-500"
          />
          <input
            placeholder={valPlaceholder}
            type={valType}
            value={row.val}
            onChange={(e) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, val: e.target.value } : r))}
            className="flex-1 h-8 px-2 rounded border border-gray-300 text-xs font-mono focus:outline-none focus:border-gray-500"
          />
          {rows.length > 1 && (
            <button onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-red-500 text-xs px-1">{"✕"}</button>
          )}
        </div>
      ))}
      <button
        onClick={() => setRows((rs) => [...rs, { key: "", val: "" }])}
        className="text-xs text-gray-500 hover:text-gray-700 self-start"
      >
        + 添加
      </button>
    </div>
  )
}

type MountEntry = { name: string; type: "file" | "dir"; children?: MountEntry[] }

const VAULT_MOUNT_PREFIX = ".loopat/vaults/default/mounts/home"

function MountsTree() {
  const [entries, setEntries] = useState<MountEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetch("/api/workspace/files?vault=personal&flat=1")
    if (r.ok) {
      const d = await r.json()
      const flat: string[] = (d.entries ?? [])
        .map((e: any) => typeof e === "string" ? e : e.path ?? e.name)
        .filter(Boolean)
      setEntries(buildTree(flat))
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const uploadTo = async (dirPath: string, file: File) => {
    const filePath = dirPath ? dirPath + "/" + file.name : file.name
    const content = await file.text()
    const r = await fetch("/api/workspace/file?vault=personal&path=" + encodeURIComponent(filePath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    })
    setMsg(r.ok ? ("✓ 已上传 " + file.name) : "上传失败")
    if (r.ok) load()
    setTimeout(() => setMsg(""), 2500)
  }

  const deleteFile = async (path: string) => {
    await fetch("/api/workspace/file?vault=personal&path=" + encodeURIComponent(path), { method: "DELETE" })
    load()
  }

  if (loading) return <div className="text-xs text-gray-400">加载中…</div>

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-mono bg-gray-50 rounded p-2 border border-gray-200 select-none">
        {entries.length > 0 ? (
          <TreeNode entries={entries} prefix="" onDelete={deleteFile} onUpload={uploadTo} depth={0} />
        ) : (
          <div className="text-[11px] text-gray-400">暂无文件，hover 目录点击 + 上传</div>
        )}
      </div>
      {msg && <div className="text-xs text-green-600 mt-1">{msg}</div>}
    </div>
  )
}

function TreeNode({
  entries, prefix, onDelete, onUpload, depth,
}: {
  entries: MountEntry[]
  prefix: string
  onDelete: (path: string) => void
  onUpload: (dirPath: string, file: File) => void
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <>
      {entries.map((e) => {
        const fullPath = prefix ? prefix + "/" + e.name : e.name
        if (e.type === "dir") {
          const isOpen = !collapsed[fullPath]
          return (
            <div key={fullPath}>
              <div
                className="flex items-center gap-1 group py-[1px] hover:bg-gray-100 rounded cursor-pointer"
                style={{ paddingLeft: (depth + 1) * 12 + "px" }}
              >
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [fullPath]: !c[fullPath] }))}
                  className="text-gray-400 hover:text-gray-600 w-3 text-[10px] text-center flex-shrink-0"
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <span
                  className="text-gray-600 flex-1"
                  onClick={() => setCollapsed((c) => ({ ...c, [fullPath]: !c[fullPath] }))}
                >
                  {"📁"} {e.name}/
                </span>
                <UploadBtn dirPath={fullPath} onUpload={onUpload} />
              </div>
              {isOpen && e.children && e.children.length > 0 && (
                <TreeNode entries={e.children} prefix={fullPath} onDelete={onDelete} onUpload={onUpload} depth={depth + 1} />
              )}
            </div>
          )
        }
        return (
          <div
            key={fullPath}
            className="flex items-center gap-1 group py-[1px] hover:bg-gray-100 rounded"
            style={{ paddingLeft: (depth + 1) * 12 + 16 + "px" }}
          >
            <span className="text-gray-500">{"📄"} {e.name}</span>
            <button
              onClick={() => onDelete(fullPath)}
              className="text-red-400 hover:text-red-600 text-[10px] opacity-0 group-hover:opacity-100 ml-1"
            >
              {"✕"}
            </button>
          </div>
        )
      })}
    </>
  )
}

function UploadBtn({ dirPath, onUpload }: { dirPath: string; onUpload: (dir: string, file: File) => void }) {
  return (
    <label
      className="text-gray-400 hover:text-blue-600 cursor-pointer text-[11px] font-bold opacity-0 group-hover:opacity-100 ml-1 px-1"
      title={"上传文件到 " + (dirPath || "~/")}
    >
      +
      <input
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onUpload(dirPath, file)
          e.target.value = ""
        }}
      />
    </label>
  )
}

function buildTree(paths: string[]): MountEntry[] {
  const root: MountEntry[] = []
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean)
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      let existing = current.find((e) => e.name === name)
      if (!existing) {
        existing = { name, type: isLast ? "file" : "dir", children: isLast ? undefined : [] }
        current.push(existing)
      }
      if (!isLast) {
        if (!existing.children) existing.children = []
        existing.type = "dir"
        current = existing.children
      }
    }
  }
  return root
}
