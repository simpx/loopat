import { describe, expect, test } from "bun:test"
import { gapToColumnFinalIndex } from "../src/components/kanban/kanbanReorder"

describe("gapToColumnFinalIndex", () => {
  test("converts a forward insertion gap to the final arrayMove index", () => {
    expect(gapToColumnFinalIndex(0, 3, 4)).toBe(2)
  })

  test("keeps a backward insertion gap as the final arrayMove index", () => {
    expect(gapToColumnFinalIndex(3, 1, 4)).toBe(1)
  })

  test("clamps the final index to the ordered file list", () => {
    expect(gapToColumnFinalIndex(0, 99, 4)).toBe(3)
    expect(gapToColumnFinalIndex(2, -5, 4)).toBe(0)
  })
})
