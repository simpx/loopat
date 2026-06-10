/**
 * context-isolation — ① pull happens ONCE at creation; after that the loop is
 * isolated (docs/context-flow.md invariant). Advance origin AFTER the loop is
 * up: its AI must NOT see the new file mid-flight.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop, originAdvanceNotes } from "../helpers-shared";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("a commit landing on origin after creation is invisible inside the loop", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-iso-${Date.now()}`, { freshness: "Latest" });
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Reply exactly READY.");
  const stamp = `iso-${Date.now()}`;
  originAdvanceNotes(`${stamp}.md`, "MARKER_ISO", "advance mid-loop");
  const r = await sendAndAwaitReply(page, `Run: ls /loopat/context/notes/ — does ${stamp}.md exist? Reply exactly YES_SEEN or NO_MISSING.`, /YES_SEEN|NO_MISSING/);
  expect(r, "mid-loop origin commits must not leak in").toContain("NO_MISSING");
});
