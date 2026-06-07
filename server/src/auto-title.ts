const SYSTEM = "Generate a short title (3-8 words) for this conversation. Output only the title, nothing else. Do not use quotes."

export function buildAuthHeaders(apiKey: string, authScheme?: "bearer"): Record<string, string> {
  if (authScheme === "bearer") {
    return { "Authorization": `Bearer ${apiKey}` }
  }
  return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
}

export async function generateTitle(
  baseUrl: string,
  apiKey: string,
  model: string,
  userText: string,
  assistantText: string,
  authScheme?: "bearer",
): Promise<string | null> {
  const snippet = [
    `User: ${userText.slice(0, 500)}`,
    assistantText ? `Assistant: ${assistantText.slice(0, 500)}` : "",
  ].filter(Boolean).join("\n\n")

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(apiKey, authScheme),
      },
      body: JSON.stringify({
        model,
        max_tokens: 40,
        system: SYSTEM,
        messages: [{ role: "user", content: snippet }],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = await res.json()
    const text: string = body?.content?.[0]?.text ?? ""
    const title = text.trim().replace(/^["']|["']$/g, "").trim()
    if (!title || title.length > 200) return null
    return title
  } catch {
    return null
  }
}
