/**
 * promote-absorb — ② promote inherently absorbs others' latest. Origin gets an
 * external commit AFTER the loop opened; the loop's AI then writes its own note
 * and promotes (fetch → merge → push). Both contents must land on origin, and
 * no loop/<id> branch may remain there (worktree-local ref invariant).
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop, originAdvanceNotes, originGit } from "../helpers-shared";

let loopId = "";
test.beforeEach(async ({ page }) => { loopId = ""; await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => cleanupLoop(loopId));

test("AI promote merges a moved origin; both works land; no loop branch left", async ({ page }) => {
  loopId = await createLoop(page, `dogfood-pa-${Date.now()}`, { freshness: "Latest" });
  await bootSandbox(page, loopId);
  const stamp = Date.now();
  // Origin moves while the loop works (external second writer).
  originAdvanceNotes(`other-${stamp}.md`, "OTHER_WRITER", "external while loop works");
  // The loop's AI writes its own note and PROMOTES per context-flow:
  const r = await sendAndAwaitReply(page,
    `In /loopat/context/notes/: create mine-${stamp}.md containing MY_WORK. Then promote it: git add, git commit -m 'mine', git fetch origin, git merge origin/HEAD (or origin/main; resolve any conflict), git push origin HEAD:main (use HEAD:master if main does not exist). Reply DONE_PROMOTED when the push succeeded.`, /DONE_PROMOTED|FAIL/);
  expect(r).toContain("DONE_PROMOTED");
  // Origin truth: BOTH files exist in the bare repo's tree.
  const files = originGit("notes", "ls-tree", "-r", "--name-only", "HEAD");
  expect(files, "loop's work landed").toContain(`mine-${stamp}.md`);
  expect(files, "external writer's work survived the merge").toContain(`other-${stamp}.md`);
  // Ungated promote leaves no loop/<id> branch on origin.
  const branches = originGit("notes", "branch", "-a");
  expect(branches, "no worktree-local ref pushed").not.toContain(`loop/${loopId}`);
});
