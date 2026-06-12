import type { ContextRepoSpec, ProfileEntry } from "../../api"

export type NewLoopStorage = Pick<Storage, "getItem" | "setItem">

export const NEW_LOOP_MEMORY_KEYS = {
  repo: "loopat:newLoop:lastRepo",
  profiles: "loopat:newLoop:lastProfiles",
  vault: "loopat:newLoop:lastVault",
  freshness: "loopat:newLoop:lastFreshness",
} as const

type NewLoopMemory = {
  repo: string | null
  profiles: string[] | null
  vault: string | null
  freshness: "latest" | "cached" | "custom" | null
}

export function readNewLoopMemory(storage: NewLoopStorage): NewLoopMemory {
  return {
    repo: safeGet(storage, NEW_LOOP_MEMORY_KEYS.repo),
    profiles: readProfileList(storage),
    vault: safeGet(storage, NEW_LOOP_MEMORY_KEYS.vault),
    freshness: readFreshness(storage),
  }
}

export function resolveStoredRepo(memory: NewLoopMemory, repos: ContextRepoSpec[]): string {
  return memory.repo && repos.some((repo) => repo.name === memory.repo) ? memory.repo : ""
}

export function resolveStoredProfiles(
  memory: NewLoopMemory,
  profiles: ProfileEntry[],
  defaultProfileNames: string[],
): string[] {
  const available = new Set(profiles.map((profile) => profile.name))

  if (memory.profiles) {
    const restored = memory.profiles.filter((name) => available.has(name) && name !== "base")
    if (restored.length > 0 || memory.profiles.length === 0) return restored
  }

  return defaultProfileNames.filter((name) => available.has(name) && name !== "base")
}

export function resolveStoredVault(memory: NewLoopMemory, vaults: string[]): string {
  if (memory.vault && vaults.includes(memory.vault)) return memory.vault
  if (vaults.includes("default")) return "default"
  if (vaults.length > 0) return vaults[0]
  return "default"
}

export function resolveStoredFreshness(memory: NewLoopMemory): "latest" | "cached" | "custom" {
  return memory.freshness ?? "latest"
}

export function writeNewLoopMemory(
  storage: NewLoopStorage,
  selection: { repo: string; profiles: string[]; vault: string; freshness: "latest" | "cached" | "custom" },
) {
  try {
    storage.setItem(NEW_LOOP_MEMORY_KEYS.repo, selection.repo)
    storage.setItem(NEW_LOOP_MEMORY_KEYS.profiles, JSON.stringify(selection.profiles))
    storage.setItem(NEW_LOOP_MEMORY_KEYS.vault, selection.vault)
    storage.setItem(NEW_LOOP_MEMORY_KEYS.freshness, selection.freshness)
  } catch {
    // localStorage is best-effort; loop creation already succeeded.
  }
}

function safeGet(storage: NewLoopStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function readProfileList(storage: NewLoopStorage): string[] | null {
  const raw = safeGet(storage, NEW_LOOP_MEMORY_KEYS.profiles)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null
  } catch {
    return null
  }
}

function readFreshness(storage: NewLoopStorage): "latest" | "cached" | "custom" | null {
  const raw = safeGet(storage, NEW_LOOP_MEMORY_KEYS.freshness)
  if (raw === "latest" || raw === "cached" || raw === "custom") return raw
  return null
}
