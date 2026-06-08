/** filestree — AI writes a file; sandbox proves it lands in the workdir. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, sandboxExec, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("AI-created file appears in the workdir listing", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-ft-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Create TREEMARK.md with content hi in the workdir. Use tools. Reply done.");
  await expect.poll(() => { try { return sandboxExec(loopId, `ls /loopat/loop/${loopId}/workdir`); } catch { return ""; } },
    { timeout: 60000, intervals:[1000,2000,3000] }).toContain("TREEMARK.md");
});
