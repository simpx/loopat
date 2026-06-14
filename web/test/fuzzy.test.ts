import { describe, expect, test } from "bun:test"
import { fuzzyMatch } from "../src/lib/fuzzy"

describe("fuzzyMatch", () => {
  test("matches query characters in order case-insensitively", () => {
    expect(fuzzyMatch("fpk", "FilePicker.tsx")).toEqual({
      matched: true,
      score: expect.any(Number),
      indices: [0, 4, 7],
    })
  })

  test("does not match characters that appear out of order", () => {
    expect(fuzzyMatch("pf", "FilePicker.tsx")).toEqual({
      matched: false,
      score: 0,
      indices: [],
    })
  })

  test("scores contiguous and boundary matches higher than scattered matches", () => {
    const exactish = fuzzyMatch("fp", "file-picker.tsx")
    const scattered = fuzzyMatch("fp", "file/deep/path.tsx")

    expect(exactish.matched).toBe(true)
    expect(scattered.matched).toBe(true)
    expect(exactish.score).toBeGreaterThan(scattered.score)
  })

  test("returns unmatched metadata for an empty query", () => {
    expect(fuzzyMatch("", "FilePicker.tsx")).toEqual({
      matched: false,
      score: 0,
      indices: [],
    })
  })
})
