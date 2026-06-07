/**
 * Auto-name: when a loop's first user-AI turn completes and its title is still
 * "untitled", make a single short LLM call (using the loop's own resolved
 * provider) to propose a 3–7 word title. Idempotent + best-effort: any failure
 * (no provider, network, parse error) is a silent no-op; the title simply
 * stays "untitled".
 *
 * Design notes (see chat history / design discussion):
 *   - Fires exactly once per loop. Tracked via `meta.titleAuto`:
 *     undefined → never tried; true → auto-named (still rewritable if user
 *     hasn't touched it); false → user owns the title, never re-name.
 *   - Tags: the prompt biases toward existing workspace topics but is allowed
 *     to invent a new short slug if none fits. Anti-sprawl guard is intentionally
 *     deferred — add a `count >= 2` filter in listTopics() only if pollution
 *     shows up.
 *   - No new dep: direct fetch() to provider.baseUrl/v1/messages. All loopat
 *     providers are Anthropic-compatible (that's how the CC binary talks to
 *     them via ANTHROPIC_BASE_URL).
 */
import { readFile } from "node:fs/promises"
import { getLoop, patchLoopMeta, listLoops } from "./loops"
import { loopHistoryPath } from "./paths"
import { loadConfig, loadPersonalConfig, type ProviderConfig, getModelByTier, inferTier } from "./config"
import { listTopics } from "./workspace"

const MAX_USER_CHARS = 400
const MAX_ASSISTANT_CHARS = 500
const MAX_TOPICS = 30

async function extractFirstTurn(loopId: string): Promise<{ firstUser: string; firstAssistant: string }> {
  let firstUser = ""
  let firstAssistant = ""
  try {
    const raw = await readFile(loopHistoryPath(loopId), "utf8")
    for (const line of raw.split("\n")) {
      if (!line) continue
      if (firstUser && firstAssistant) break
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (!firstUser && msg.type === "user") {
        const content = msg.message?.content ?? msg.content
        if (typeof content === "string") {
          firstUser = content
        } else if (Array.isArray(content)) {
          const hasToolResult = content.some((b: any) => b?.type === "tool_result")
          if (!hasToolResult) {
            const text = content.find((b: any) => b?.type === "text")
            if (text?.text) firstUser = text.text
          }
        }
      } else if (!firstAssistant && msg.type === "assistant") {
        const content = msg.message?.content ?? msg.content
        if (Array.isArray(content)) {
          const text = content.find((b: any) => b?.type === "text")
          if (text?.text) firstAssistant = text.text
        }
      }
    }
  } catch {}
  return {
    firstUser: firstUser.slice(0, MAX_USER_CHARS).trim(),
    firstAssistant: firstAssistant.slice(0, MAX_ASSISTANT_CHARS).trim(),
  }
}

/** Collect all candidate providers in priority order (loop config → personal
 *  default → workspace default → remaining). Returns array so callers can
 *  fall back to the next provider when a key is invalid/expired. */
async function resolveProvidersForLoop(meta: { createdBy: string; config?: { default_model?: string; vault?: string } }): Promise<ProviderConfig[]> {
  const pCfg = await loadPersonalConfig(meta.createdBy, meta.config?.vault)
  const wCfg = await loadConfig()
  const names = [
    meta.config?.default_model,
    pCfg.default,
    wCfg.default,
    ...Object.keys(pCfg.providers),
    ...Object.keys(wCfg.providers ?? {}),
  ].filter(Boolean) as string[]
  const seen = new Set<string>()
  const result: ProviderConfig[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const p = pCfg.providers[name] ?? wCfg.providers?.[name]
    if (p && p.apiKey) result.push(p)
  }
  return result
}

const SYSTEM_PROMPT = `You name conversations.

Output ONE line: 3–7 words in the language the user wrote in. Plain words. No quotes, no period, no emoji.

If the conversation clearly matches one of the existing tags below, suffix the title with " #tag" (one tag only, lowercase, no inventing if a good existing tag fits). If none fits but the topic has an obvious short slug, you MAY invent a new tag (kebab-case, ≤ 2 words). Otherwise omit the tag entirely.

Reply with the title and nothing else.`

function buildUserPrompt(firstUser: string, firstAssistant: string, topics: string[]): string {
  const tagLine = topics.length > 0
    ? `Existing tags (loop count desc): ${topics.map((t) => "#" + t).join(" ")}`
    : `Existing tags: (none yet)`
  const assistantBlock = firstAssistant
    ? `\n\nAssistant reply (truncated):\n${firstAssistant}`
    : ""
  return `${tagLine}

User's first message:
${firstUser}${assistantBlock}`
}

const AUTH_FAILED = Symbol("auth_failed")

async function callForTitle(provider: ProviderConfig, userPrompt: string): Promise<string | null | typeof AUTH_FAILED> {
  const activeModel = getModelByTier(provider, "haiku") ?? provider.models[0]
  if (!activeModel?.id) return AUTH_FAILED
  const url = provider.baseUrl.replace(/\/+$/, "") + "/v1/messages"
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": provider.apiKey,
      },
      body: JSON.stringify({
        model: activeModel.id,
        max_tokens: 64,
        system: SYSTEM_PROMPT,
        ...(!inferTier(activeModel.id) ? { thinking: { type: "disabled" } } : {}),
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: ctrl.signal,
    })
    if (r.status === 401 || r.status === 403) return AUTH_FAILED
    if (!r.ok) return null
    const j: any = await r.json().catch(() => null)
    if (!j?.content || !Array.isArray(j.content)) return null
    const block = j.content.find((b: any) => b?.type === "text")
    const raw = (block?.text ?? "").trim()
    if (!raw) return null
    const oneLine = raw.split(/\r?\n/)[0].replace(/^["'`]+|["'`]+$/g, "").trim()
    const collapsed = oneLine.replace(/\s+/g, " ")
    if (!collapsed || collapsed.length > 80) return null
    return collapsed
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best-effort: try to auto-name `loopId` if eligible. Safe to call repeatedly
 * (idempotent — bails out if title isn't "untitled" or titleAuto is locked).
 * Never throws. Returns true iff the loop was actually renamed.
 */
export async function maybeAutoName(loopId: string): Promise<boolean> {
  try {
    const meta = await getLoop(loopId)
    if (!meta) return false
    if (meta.titleAuto === false) return false
    if (meta.title !== "untitled") return false

    const { firstUser, firstAssistant } = await extractFirstTurn(loopId)
    if (!firstUser) return false

    const providers = await resolveProvidersForLoop(meta)
    if (providers.length === 0) return false

    const allLoops = await listLoops()
    const topics = await listTopics(allLoops.map((l) => ({ id: l.id, title: l.title })))
    const candidates = topics.slice(0, MAX_TOPICS).map((t) => t.name)

    const prompt = buildUserPrompt(firstUser, firstAssistant, candidates)
    let title: string | null = null
    for (const provider of providers) {
      const result = await callForTitle(provider, prompt)
      if (result === AUTH_FAILED) {
        console.warn(`[auto-name] ${loopId.slice(0, 8)} provider ${provider.baseUrl} auth failed, trying next`)
        continue
      }
      if (result) { title = result; break }
      break
    }
    if (!title) return false

    const fresh = await getLoop(loopId)
    if (!fresh) return false
    if (fresh.titleAuto === false) return false
    if (fresh.title !== "untitled") return false

    await patchLoopMeta(loopId, { title, titleAuto: true })
    console.log(`[auto-name] ${loopId.slice(0, 8)} → ${title}`)
    return true
  } catch (e: any) {
    console.warn(`[auto-name] ${loopId.slice(0, 8)} failed: ${e?.message ?? e}`)
    return false
  }
}
