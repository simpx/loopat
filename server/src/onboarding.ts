/**
 * Onboarding flow for new users.
 *
 * Surface:
 *   - Welcome card on Loops list page (frontend, see WelcomeCard.tsx)
 *   - One built-in skill `/loopat:onboarding` (server/templates/plugins/loopat/)
 *
 * State machine (per user):
 *
 *   fresh   ──"start"──→  started (with loopId)  ──"done"──→  done
 *      │
 *      └──────── "skip" ─────────────────────────────────────→  done
 *
 * "Started" means we spawned an onboarding loop and the user is partway
 * through. "Done" covers both completed and skipped — the Welcome card hides
 * either way; we don't need to distinguish for UX.
 *
 * State lives in personal/<user>/.loopat/config.json under `onboarding`. Cache
 * invalidation: writes go through readPersonalDisk → writeFile, so cached
 * PersonalConfig stays correct via mtime check.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { personalLoopatConfigPath, personalLoopatDir } from "./paths"
import type { OnboardingState, PersonalConfigDisk } from "./config"
import { createLoop } from "./loops"

/** Frontend-facing status. `fresh` = card shows "start"; `started` = card shows "continue". */
export type OnboardingStatus = {
  state: "fresh" | "started" | "done"
  loopId?: string
}

async function readDisk(user: string): Promise<PersonalConfigDisk> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) {
    return { providers: {} }
  }
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as PersonalConfigDisk
    if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {}
    return parsed
  } catch {
    return { providers: {} }
  }
}

async function writeDisk(user: string, disk: PersonalConfigDisk): Promise<void> {
  await mkdir(personalLoopatDir(user), { recursive: true })
  await writeFile(personalLoopatConfigPath(user), JSON.stringify(disk, null, 2) + "\n")
}

export async function getOnboardingStatus(user: string): Promise<OnboardingStatus> {
  const disk = await readDisk(user)
  const o = disk.onboarding
  if (!o) return { state: "fresh" }
  // Treat anything that isn't explicitly "started" as completion. The agent
  // writes this field via natural-language semantics (Edit on config.json),
  // so it might say "done" / "completed" / "finished" / "complete" — they
  // all mean the user has wrapped up the flow. Only "started" stays open.
  if (o.status === "started") return { state: "started", loopId: o.loopId }
  return { state: "done" }
}

export async function setOnboardingState(
  user: string,
  state: OnboardingState,
): Promise<void> {
  const disk = await readDisk(user)
  disk.onboarding = state
  await writeDisk(user, disk)
}

/**
 * Create an onboarding loop and mark state as `started`. The loop itself is
 * a regular loop — no special meta.kind — distinguished only by:
 *   - title "新手引导"
 *   - no repo (workdir is empty)
 *   - no sandbox (no toolchain needed)
 *
 * The kickoff message (`/loopat:onboarding`) is sent by the frontend after
 * navigating to the loop, so we don't seed messages.jsonl from here.
 */
export async function startOnboardingLoop(user: string): Promise<{ loopId: string }> {
  const loop = await createLoop({
    title: "新手引导",
    createdBy: user,
  })
  await setOnboardingState(user, {
    status: "started",
    loopId: loop.id,
    at: new Date().toISOString(),
  })
  return { loopId: loop.id }
}

export async function markOnboardingDone(user: string): Promise<void> {
  const existing = await getOnboardingStatus(user)
  await setOnboardingState(user, {
    status: "done",
    loopId: existing.loopId,
    at: new Date().toISOString(),
  })
}
