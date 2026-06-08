import { describe, expect, test } from "bun:test"
import {
  NEW_LOOP_MEMORY_KEYS,
  readNewLoopMemory,
  resolveStoredProfiles,
  resolveStoredRepo,
  resolveStoredVault,
  writeNewLoopMemory,
  type NewLoopStorage,
} from "../src/components/dialog/newLoopMemory"

function storage(initial: Record<string, string | null> = {}): NewLoopStorage {
  const values = new Map(Object.entries(initial).filter((entry): entry is [string, string] => entry[1] !== null))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe("new loop memory", () => {
  test("restores a stored repo only when the freshly loaded repo list still contains it", () => {
    const repoStorage = storage({ [NEW_LOOP_MEMORY_KEYS.repo]: "loopat" })
    const memory = readNewLoopMemory(repoStorage)

    expect(resolveStoredRepo(memory, [{ name: "loopat", git: "git@example.com:loopat.git" }])).toBe("loopat")
    expect(resolveStoredRepo(memory, [{ name: "other", git: "git@example.com:other.git" }])).toBe("")
  })

  test("restores stored profiles after filtering base and stale profile names", () => {
    const profileStorage = storage({
      [NEW_LOOP_MEMORY_KEYS.profiles]: JSON.stringify(["base", "docs", "missing", "ops"]),
    })
    const memory = readNewLoopMemory(profileStorage)

    expect(
      resolveStoredProfiles(
        memory,
        [
          { name: "base" },
          { name: "docs" },
          { name: "ops" },
        ],
        ["default-profile"],
      ),
    ).toEqual(["docs", "ops"])
  })

  test("falls back to default profiles when stored profiles are absent or invalid", () => {
    const emptyMemory = readNewLoopMemory(storage())
    const invalidMemory = readNewLoopMemory(storage({ [NEW_LOOP_MEMORY_KEYS.profiles]: "not json" }))
    const profiles = [{ name: "base" }, { name: "default-profile" }, { name: "stale-default" }]

    expect(resolveStoredProfiles(emptyMemory, profiles, ["base", "default-profile", "missing"])).toEqual([
      "default-profile",
    ])
    expect(resolveStoredProfiles(invalidMemory, profiles, ["default-profile"])).toEqual(["default-profile"])
  })

  test("restores a stored vault only when the freshly loaded vault list still contains it", () => {
    const vaultStorage = storage({ [NEW_LOOP_MEMORY_KEYS.vault]: "prod" })
    const memory = readNewLoopMemory(vaultStorage)

    expect(resolveStoredVault(memory, ["default", "prod"])).toBe("prod")
    expect(resolveStoredVault(memory, ["default", "dev"])).toBe("default")
    expect(resolveStoredVault(memory, ["dev"])).toBe("dev")
    expect(resolveStoredVault(memory, [])).toBe("default")
  })

  test("writes selected repo, profiles, and vault after successful creation", () => {
    const memoryStorage = storage()

    writeNewLoopMemory(memoryStorage, {
      repo: "loopat",
      profiles: ["docs", "ops"],
      vault: "prod",
    })

    expect(memoryStorage.getItem(NEW_LOOP_MEMORY_KEYS.repo)).toBe("loopat")
    expect(memoryStorage.getItem(NEW_LOOP_MEMORY_KEYS.profiles)).toBe(JSON.stringify(["docs", "ops"]))
    expect(memoryStorage.getItem(NEW_LOOP_MEMORY_KEYS.vault)).toBe("prod")
  })
})
