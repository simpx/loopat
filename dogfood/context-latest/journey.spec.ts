/**
 * context-latest — ① pull freshness has REAL behavioral difference. Advance the
 * notes origin externally, then create a Latest loop (origin/HEAD): its AI must
 * see the new file. Create a Cached loop (HEAD, local clone predates the
 * advance): its AI must NOT see it. Browser + real AI + fixture-origin truth.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop, originAdvanceNotes } from "../helpers-shared";

const ids: string[] = [];
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => ids.splice(0).forEach(cleanupLoop));

test("Latest loop sees a fresh origin commit; Cached loop does not", async ({ page }) => {
  // Prime the local clone: any loop create materializes the per-user notes clone.
  const warm = await createLoop(page, `dogfood-cl-warm-${Date.now()}`, { freshness: "Latest" }); ids.push(warm);
  // Advance origin AFTER the clone exists — the difference Latest/Cached must surface.
  const stamp = `fresh-${Date.now()}`;
  originAdvanceNotes(`${stamp}.md`, "MARKER_LATEST", "advance after clone");

  const cached = await createLoop(page, `dogfood-cl-cached-${Date.now()}`, { freshness: "Cached" }); ids.push(cached);
  await bootSandbox(page, cached);
  const r1 = await sendAndAwaitReply(page, `Run: ls /loopat/context/notes/ — does a file named ${stamp}.md exist? Reply exactly YES_SEEN or NO_MISSING.`, /YES_SEEN|NO_MISSING/);
  expect(r1, "cached loop must NOT see the post-clone commit").toContain("NO_MISSING");

  const latest = await createLoop(page, `dogfood-cl-latest-${Date.now()}`, { freshness: "Latest" }); ids.push(latest);
  await bootSandbox(page, latest);
  const r2 = await sendAndAwaitReply(page, `Run: ls /loopat/context/notes/ — does a file named ${stamp}.md exist? Reply exactly YES_SEEN or NO_MISSING.`, /YES_SEEN|NO_MISSING/);
  expect(r2, "latest loop must see the post-clone commit").toContain("YES_SEEN");
});
