/**
 * memory — two turns in one loop; the second answer must reference the first.
 * Proves conversation context persists across turns, end to end through the UI.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "./helpers";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("the AI remembers a fact from the first turn on the second", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-mem-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "My secret codeword is BANANA42. Just acknowledge it.");
  const reply = await sendAndAwaitReply(page, "What was my secret codeword? Reply with only the word.");
  expect(reply).toContain("BANANA42");
});
