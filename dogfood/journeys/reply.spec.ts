/**
 * reply — the AI answers a deterministic question through the UI. Proves the
 * full create → boot → chat → real reply path renders in the browser.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "./helpers";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("AI replies with a deterministic token in the chat UI", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-reply-${Date.now()}`);
  await bootSandbox(page, loopId);
  const reply = await sendAndAwaitReply(page, "Reply with exactly one word: PONGDOGFOOD. Nothing else.");
  expect(reply).toContain("PONGDOGFOOD");
});
