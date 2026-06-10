/**
 * structure-automerge — conflict chain layer 1: different writers, different
 * files → git auto-merges, no AI conflict resolution needed. Two loops each
 * write their OWN file in notes and promote one after the other; both land.
 * (Single-server light version of sync S4.)
 */
import { test, expect } from "@playwright/test";
import { createLoop, bootSandbox, sendAndAwaitReply, cleanupLoop, originGit } from "../helpers-shared";

const ids: string[] = [];
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1")); });
test.afterEach(() => ids.splice(0).forEach(cleanupLoop));

// Deterministic promote: resolve origin's default branch FIRST, merge it, push
// to it — no main/master guessing (the ambiguity that split pushes across two
// branches in the first cut of this case).
const PROMOTE = (f: string, c: string) =>
  `In /loopat/context/notes/: create ${f} containing ${c}. Then run exactly: ` +
  `git add ${f} && git commit -m '${f}' && git fetch origin && ` +
  `DEF=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|origin/||') && ` +
  `git merge origin/$DEF && git push origin HEAD:$DEF. Reply DONE_X only after the push succeeds.`;

test("two loops, two files, both promotes land without conflict", async ({ page }) => {
  const stamp = Date.now();
  const a = await createLoop(page, `dogfood-sa-a-${stamp}`, { freshness: "Latest" }); ids.push(a);
  await bootSandbox(page, a);
  expect(await sendAndAwaitReply(page, PROMOTE(`a-${stamp}.md`, "FROM_A"), /DONE_X/)).toContain("DONE_X");
  const b = await createLoop(page, `dogfood-sa-b-${stamp}`, { freshness: "Latest" }); ids.push(b);
  await bootSandbox(page, b);
  expect(await sendAndAwaitReply(page, PROMOTE(`b-${stamp}.md`, "FROM_B"), /DONE_X/)).toContain("DONE_X");
  const files = originGit("notes", "ls-tree", "-r", "--name-only", "HEAD");
  expect(files).toContain(`a-${stamp}.md`);
  expect(files).toContain(`b-${stamp}.md`);
});
