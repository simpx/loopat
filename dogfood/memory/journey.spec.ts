/**
 * memory — two turns in one loop; the second answer must reference the first.
 * Proves conversation context persists across turns, end to end through the UI.
 * Uses a neutral project codename (not a "secret") so opus doesn't refuse to
 * echo it as sensitive — the failure mode confirmed via trace.jsonl.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "../helpers-shared";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("the AI remembers a fact from the first turn on the second", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-mem-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Our project codename is BANANA42 — remember it for later. Just acknowledge.");
  const reply = await sendAndAwaitReply(page, "What is our project codename? Reply with only that word.");
  expect(reply).toContain("BANANA42");
});
