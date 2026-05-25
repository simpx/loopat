/**
 * L1: extractProfileDescription — pull a one-line summary from a profile's
 * CLAUDE.md.
 *
 * Priority order:
 *   1. YAML frontmatter `description:` field
 *   2. First non-empty heading (`# foo`), legacy fallback
 *   3. Otherwise null (no description)
 */
import { test, expect, describe } from "bun:test"

process.env.LOOPAT_HOME ??= `/tmp/loopat-profile-desc-${process.pid}`
const { extractProfileDescription: extract } = await import("../src/tiers")

describe("extractProfileDescription — frontmatter (preferred)", () => {
  test("plain frontmatter description wins over heading", () => {
    const md = `---
description: ML training oncall — sls + spectrum CLI ready
---

# Some Heading
body...`
    expect(extract(md)).toBe("ML training oncall — sls + spectrum CLI ready")
  })

  test("double-quoted description is unquoted", () => {
    const md = `---
description: "with: colons and special chars"
---

# Heading`
    expect(extract(md)).toBe("with: colons and special chars")
  })

  test("single-quoted description is unquoted", () => {
    const md = `---
description: 'has \"nested\" quotes'
---`
    expect(extract(md)).toBe(`has \"nested\" quotes`)
  })

  test("frontmatter with other fields — description still extracted", () => {
    const md = `---
title: Foo
version: 1
description: Real description here
tags: [a, b]
---

content`
    expect(extract(md)).toBe("Real description here")
  })

  test("empty description in frontmatter → falls through to heading fallback", () => {
    const md = `---
description:
---

# Fallback heading`
    expect(extract(md)).toBe("Fallback heading")
  })
})

describe("extractProfileDescription — first-heading fallback (legacy)", () => {
  test("# heading line → text", () => {
    expect(extract("# Patent mode\nbody")).toBe("Patent mode")
  })

  test("## level-2 heading also works", () => {
    expect(extract("## Sub-doctrine\nbody")).toBe("Sub-doctrine")
  })

  test("heading with trailing whitespace is trimmed", () => {
    expect(extract("#   spaced out heading   \nbody")).toBe("spaced out heading")
  })

  test("leading blank lines are skipped", () => {
    expect(extract("\n\n\n# Heading after blanks")).toBe("Heading after blanks")
  })

  test("file with content but NO heading and NO frontmatter → null", () => {
    // First non-empty non-heading line returns null per spec (we don't
    // promote arbitrary prose to "description" — that's noise).
    expect(extract("just some prose, no heading anywhere")).toBeNull()
  })
})

describe("extractProfileDescription — edge cases", () => {
  test("null input → null", () => {
    expect(extract(null)).toBeNull()
  })

  test("empty string → null", () => {
    expect(extract("")).toBeNull()
  })

  test("only frontmatter, no body → description still extracted", () => {
    const md = `---
description: Only-frontmatter file
---
`
    expect(extract(md)).toBe("Only-frontmatter file")
  })

  test("malformed frontmatter (no closing ---) → null (don't guess)", () => {
    // We intentionally don't try to recover from a broken frontmatter fence:
    // returning null surfaces the bug to the author (UI shows no description,
    // they fix the file). Silent recovery would mask config errors.
    const md = `---
description: never closes

# Real heading`
    expect(extract(md)).toBeNull()
  })

  test("frontmatter with no description field → first heading fallback", () => {
    const md = `---
title: Has Title
tags: [x]
---

# Heading wins`
    expect(extract(md)).toBe("Heading wins")
  })

  test("only whitespace → null", () => {
    expect(extract("   \n\n\t  \n")).toBeNull()
  })

  test("CR/LF (windows) line endings — heading still found", () => {
    expect(extract("# CRLF heading\r\nbody")).toBe("CRLF heading")
  })
})
