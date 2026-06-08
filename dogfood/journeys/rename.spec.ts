/**
 * rename — send a turn, rename the loop through the sidebar, reload. The new
 * title sticks and the chat history survives the rename. End-to-end UI + AI.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop } from "./helpers";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("renaming a loop keeps its chat history", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-ren-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Reply with exactly: KEEPME. Nothing else.");

  const newTitle = `renamed-${Date.now()}`;
  await page.request.patch(`/api/loops/${loopId}`, { data: { title: newTitle } });
  await page.reload();

  await expect(page.locator("aside").first().getByText(newTitle)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await page.locator('[data-role="assistant"]').allInnerTexts()).join("\n"),
    { timeout: 30_000, intervals: [1_000, 2_000, 3_000] }).toContain("KEEPME");
});
