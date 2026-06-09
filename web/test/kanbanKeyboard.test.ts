import { describe, expect, test } from "bun:test"
import { kanbanTextInputKeyAction } from "../src/components/kanban/kanbanKeyboard"

describe("kanbanTextInputKeyAction", () => {
  test("ignores Enter and Escape while IME composition is active", () => {
    expect(kanbanTextInputKeyAction("Enter", true)).toBe("none")
    expect(kanbanTextInputKeyAction("Escape", true)).toBe("none")
  })

  test("preserves non-composing submit and cancel actions", () => {
    expect(kanbanTextInputKeyAction("Enter", false)).toBe("submit")
    expect(kanbanTextInputKeyAction("Escape", false)).toBe("cancel")
    expect(kanbanTextInputKeyAction("Tab", false)).toBe("none")
  })
})
