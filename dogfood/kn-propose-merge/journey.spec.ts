/**
 * kn-propose-merge — the gated promote end to end. The loop's AI writes into
 * its knowledge worktree (rw now — the gate moved to the promote edge),
 * commits on loop/<id> and STOPS. The proposal shows up in the proposals API;
 * merging it (the no-AI UI loop: fetch→merge→push with the user's key) lands
 * it on the fixture knowledge origin; nothing reached main before the merge.
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop, originGit } from "../helpers-shared";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("AI proposes a knowledge change; review&merge lands it on origin", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-knp-${Date.now()}`, { freshness: "Latest" });
  await bootSandbox(page, loopId);
  const stamp = Date.now();

  // 1. The AI can WRITE knowledge now, commits, and stops (gated promote).
  const r = await sendAndAwaitReply(page,
    `In /loopat/context/knowledge/: create kn-${stamp}.md containing KN_PROPOSAL. Then git add and git commit -m 'kn proposal ${stamp}'. Do NOT push anywhere. Reply DONE_COMMITTED.`,
    /DONE_COMMITTED/);
  expect(r).toContain("DONE_COMMITTED");

  // 2. Gate held: nothing on origin's default branch yet.
  expect(originGit("knowledge", "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(`kn-${stamp}.md`);

  // 3. The proposal is visible to the review API.
  const props = await (await page.request.get("/api/knowledge/proposals")).json();
  const mine = (props.proposals ?? []).find((p: any) => p.branch === `loop/${loopId}`);
  expect(mine, `proposal for loop/${loopId} listed: ${JSON.stringify(props)}`).toBeTruthy();

  // 4. Review & merge → lands on the fixture knowledge origin.
  const merge = await page.request.post("/api/knowledge/proposals/merge", { data: { branch: `loop/${loopId}` } });
  expect(merge.ok(), `merge: ${await merge.text()}`).toBeTruthy();
  expect(originGit("knowledge", "ls-tree", "-r", "--name-only", "HEAD")).toContain(`kn-${stamp}.md`);
});
