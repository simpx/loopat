/**
 * tooluse — the AI uses a real tool to create a file, verified via sandbox
 * truth (podman exec), not the AI's words. A lighter single-tool counterpart to
 * multi-turn-task: one write, one deterministic artifact.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, sandboxExec, cleanupLoop } from "./helpers";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("AI writes a file the sandbox can prove exists", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-tool-${Date.now()}`);
  await bootSandbox(page, loopId);
  await sendAndAwaitReply(page, 'Create a file named MARK.txt in the workdir whose only content is the line DOGFOOD_OK. Use your tools. Reply done when finished.');
  await expect.poll(() => {
    try { return sandboxExec(loopId, `cat /loopat/loop/${loopId}/workdir/MARK.txt`).trim(); } catch { return ""; }
  }, { timeout: 60_000, intervals: [1_000, 2_000, 3_000] }).toBe("DOGFOOD_OK");
});
