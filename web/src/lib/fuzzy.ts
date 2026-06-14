export interface FuzzyMatchResult {
  matched: boolean
  score: number
  indices: number[]
}

const WORD_BOUNDARY = /[-\/.:\s@_]/

function noMatch(): FuzzyMatchResult {
  return {
    matched: false,
    score: 0,
    indices: [],
  }
}

export function fuzzyMatch(query: string, text: string): FuzzyMatchResult {
  if (!query || !text) return noMatch()

  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const indices: number[] = []
  let queryIndex = 0
  let score = 0
  let lastMatchIndex = -2

  for (let textIndex = 0; textIndex < t.length && queryIndex < q.length; textIndex += 1) {
    if (t[textIndex] !== q[queryIndex]) continue

    const isConsecutive = lastMatchIndex === textIndex - 1
    const isBoundary = textIndex === 0 || WORD_BOUNDARY.test(t[textIndex - 1])

    score += isConsecutive ? 2 : 1
    if (isBoundary) score += 3

    indices.push(textIndex)
    lastMatchIndex = textIndex
    queryIndex += 1
  }

  if (queryIndex !== q.length) return noMatch()

  return {
    matched: true,
    score,
    indices,
  }
}
