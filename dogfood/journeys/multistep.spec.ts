/** multistep — one instruction, several tool actions, verified by sandbox truth. */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, sandboxExec, cleanupLoop } from "./helpers";
let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));
test("AI chains read+write+count into one deterministic artifact", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-ms-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, "Read README.md, then write COPY.txt whose content is exactly README.md's first line. Use tools. Reply done.");
  await expect.poll(() => { try { return sandboxExec(loopId, `cat /loopat/loop/${loopId}/workdir/COPY.txt`).trim(); } catch { return ""; } },
    { timeout: 60000, intervals:[1000,2000,3000] }).toBe("hello");
});
