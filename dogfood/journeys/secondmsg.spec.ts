/** secondmsg — two sequential turns both render distinct replies in the UI. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("two sequential turns both produce replies", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-2m-${Date.now()}`);
  await bootSandbox(page, loopId);
  expect(await sendAndAwaitReply(page, "Reply with exactly: ONEONE.")).toContain("ONEONE");
  expect(await sendAndAwaitReply(page, "Reply with exactly: TWOTWO.")).toContain("TWOTWO");
});
