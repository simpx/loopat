/** contextfiles — loop context API returns the loop's notes/knowledge mounts. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("loop context endpoint responds for a booted loop", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-ctx-${Date.now()}`);
  await bootSandbox(page, loopId);
  const r = await page.request.get(`/api/loops/${loopId}/context`);
  expect(r.status()).toBeLessThan(400);
});
