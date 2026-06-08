/** distill — seed a turn, then distill the loop; expect a non-empty summary. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("distill returns a summary of a real turn", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-dst-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Reply with exactly: DISTILLME.");
  const r = await page.request.post(`/api/loops/${loopId}/distill`, { data: {} });
  expect(r.status()).toBeLessThan(400);
  expect((await r.text()).length).toBeGreaterThan(0);
});
