/** folder — AI creates a subdir + file; sandbox proves the tree. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, sandboxExec, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("AI creates a nested file the sandbox proves", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-fld-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Create dir sub/ and file sub/DEEP.txt with content deepok in the workdir. Use tools. Reply done.");
  await expect.poll(() => { try { return sandboxExec(loopId, `cat /loopat/loop/${loopId}/workdir/sub/DEEP.txt`).trim(); } catch { return ""; } },
    { timeout: 60000, intervals: [1000,2000,3000] }).toBe("deepok");
});
