/** archive — archive a loop via API, sidebar drops it; restore brings it back. */
import { test, expect } from "@playwright/test";
import { createLoop, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("archiving a loop hides it from the active sidebar; restore returns it", async ({ page }) => {
  const title = `dogfood-arc-${Date.now()}`;
  loopId = await createLoop(page, title);
  await expect(page.locator("aside").first().getByText(title)).toBeVisible({ timeout: 15000 });
  await page.request.patch(`/api/loops/${loopId}`, { data: { archived: true } });
  await page.reload();
  await expect(page.locator("aside").first().getByText(title)).toBeHidden({ timeout: 15000 });
  await page.request.patch(`/api/loops/${loopId}`, { data: { archived: false } });
  await page.reload();
  await expect(page.locator("aside").first().getByText(title)).toBeVisible({ timeout: 15000 });
});
