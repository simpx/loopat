/** Returns a positive score if all chars of `query` appear in order in `text`, null otherwise. */
export function fuzzyMatch(query: string, text: string): number | null {
  if (!query || !text) return null
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let lastIdx = -2

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastIdx === ti - 1 ? 2 : 1
      if (ti === 0 || /[-/.:\s@]/.test(t[ti - 1])) score += 3
      lastIdx = ti
      qi++
    }
  }
  return qi === q.length ? score : null
}
