/**
 * concurrent-push — git push CONFLICT RESOLUTION, head-on.
 *
 * The legitimacy test for shared loops: two writers race the SAME branch
 * (`master`) of the SAME origin (the fixture `roster1.git`). The loop is the
 * SECOND writer, so its first push is REJECTED non-fast-forward and it must
 * fetch + rebase + re-push to land its work on top of the other writer's.
 * "Last one resolves." This does NOT avoid the conflict — it forces one and
 * resolves it the standard git way.
 *
 * Flow:
 *   1. Create a loop from roster1; open the terminal; wait container running +
 *      PreparingOverlay clear.
 *   2. In the loop's UI terminal (xterm, fish): set git identity, commit a
 *      Z-BASE state and push it so loop + origin start in sync.
 *   3. Advance origin from OUTSIDE the loop (podman exec into the fixture): clone
 *      roster1.git, commit Y on master, push it back. Origin now has Y the loop
 *      doesn't.
 *   4. In the loop terminal: commit Z on the (now-stale) base and push → it is
 *      REJECTED non-fast-forward. We prove the rejection by STATE: the fixture
 *      origin's tip must STILL be Y (Z did NOT land yet).
 *   5. In the loop terminal: fetch + rebase onto origin/master, push again →
 *      succeeds.
 *   6. INTEGRATION TRUTH: roster1.git log --oneline shows BOTH Y AND Z — the
 *      conflict was resolved, last writer rebased on top, both landed.
 *
 * No chat message is ever sent → zero AI tokens. We drive the real UI terminal
 * (xterm, fish shell — every command is fish-valid) and verify every outcome via
 * integration truth (`podman exec ... git`), never by scraping the flaky xterm.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user ALREADY ONBOARDED with the anthropic
 * provider and roster repo roster1. We arrive logged in via storageState.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The fixture sshd container id, recorded by setup.ts in .test-meta.json. */
function fixtureContainer(): string {
  const meta = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", ".test-meta.json"), "utf8"),
  );
  if (!meta.fixtureContainer) throw new Error("fixtureContainer missing from .test-meta.json");
  return meta.fixtureContainer as string;
}

/** Run a shell command INSIDE the loop's sandbox container, return stdout (the
 *  container's own truth about the loop workdir's local git state). Best-effort:
 *  returns "" on error so it can be used purely for diagnostics. */
function sandboxExec(loopId: string, cmd: string): string {
  try {
    const names = runningContainers(loopId);
    if (names.length !== 1) return "";
    return execFileSync("podman", ["exec", names[0], "sh", "-lc", cmd]).toString();
  } catch (e) {
    return `<exec error: ${e}>`;
  }
}

/** Names of RUNNING sandbox containers for this loop id (empty array = none). */
function runningContainers(loopId: string): string[] {
  return execFileSync("podman", [
    "ps",
    "--filter",
    `label=loopat.loop-id=${loopId}`,
    "--filter",
    "status=running",
    "--format",
    "{{.Names}}",
  ])
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `git log --oneline` of the fixture's bare roster1.git — the origin's TRUTH.
 *  The bare repo is owned by `git`; `podman exec` defaults to root, so git
 *  refuses with "dubious ownership" — `-c safe.directory=*` waives that (read
 *  only). */
function fixtureRosterLog(): string {
  return execFileSync("podman", [
    "exec",
    fixtureContainer(),
    "git",
    "-c",
    "safe.directory=*",
    "-C",
    "/srv/git/roster1.git",
    "log",
    "--oneline",
    "master",
  ])
    .toString()
    .trim();
}

/** Subject of the CURRENT tip of roster1.git's master — origin's authoritative
 *  HEAD. If a push was rejected, this does NOT advance. */
function fixtureRosterTipSubject(): string {
  return execFileSync("podman", [
    "exec",
    fixtureContainer(),
    "git",
    "-c",
    "safe.directory=*",
    "-C",
    "/srv/git/roster1.git",
    "log",
    "-1",
    "--format=%s",
    "master",
  ])
    .toString()
    .trim();
}

/** Advance roster1.git's master from OUTSIDE the loop: clone the bare repo to a
 *  temp dir inside the fixture container, make commit `msg`, push it back. This
 *  is the OTHER writer — it has nothing to do with the loop's worktree. */
function advanceOriginFromOutside(msg: string, fileLine: string): void {
  // Single sh -c so the temp dir / identity stay in one shell. The bare repos
  // are owned by `git` but exec runs as root → safe.directory=* for the read
  // side, and we push over the local filesystem path (no ssh needed from inside
  // the fixture). receive.denyCurrentBranch is irrelevant for a bare repo, so a
  // normal fast-forward push from this fresh clone just works.
  const script = [
    "set -e",
    "export GIT_AUTHOR_NAME=outsider GIT_AUTHOR_EMAIL=outsider@local",
    "export GIT_COMMITTER_NAME=outsider GIT_COMMITTER_EMAIL=outsider@local",
    "export HOME=/root",
    "git config --global --add safe.directory '*'",
    "d=$(mktemp -d)",
    "git clone -q /srv/git/roster1.git \"$d/clone\"",
    "cd \"$d/clone\"",
    `printf '%s\\n' '${fileLine}' >> outside.txt`,
    "git add -A",
    `git commit -qm '${msg}'`,
    "git push -q origin HEAD:master",
    "echo PUSHED_OUTSIDE",
  ].join("\n");
  const out = execFileSync("podman", [
    "exec",
    fixtureContainer(),
    "sh",
    "-c",
    script,
  ]).toString().trim();
  if (!out.includes("PUSHED_OUTSIDE")) {
    throw new Error(`outside push did not confirm: ${out}`);
  }
}

/** Type a shell command into the focused xterm, run it, give it time to execute.
 *  Reading the xterm prompt back is flaky, so we pace with a fixed settle delay
 *  between commands instead of prompt-matching. */
async function runInTerminal(page: Page, cmd: string, settleMs = 1_500): Promise<void> {
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settleMs);
}

/** Best-effort remove this loop's sandbox container so loops/containers don't
 *  accumulate in the shared LOOPAT_HOME across the serial suite. Never throws. */
function cleanupLoopContainer(loopId: string): void {
  if (!loopId) return;
  try {
    const ids = execFileSync("podman", [
      "ps", "-a",
      "--filter", `label=loopat.loop-id=${loopId}`,
      "--format", "{{.ID}}",
    ]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) execFileSync("podman", ["rm", "-f", ...ids]);
  } catch {
    // best-effort teardown — never fail the suite on cleanup.
  }
}

// The loop this case created, so afterEach can reap its container.
let createdLoopId = "";

test.beforeEach(async ({ page }) => {
  createdLoopId = "";
  // Bypass the "Setup Personal Repo" card for the (preconfigured) account.
  await page.addInitScript(() => {
    localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
  });
});

test.afterEach(() => {
  cleanupLoopContainer(createdLoopId);
});

test("concurrent push: loop's stale push is rejected non-ff, then fetch+rebase+re-push resolves and both commits land", async ({ page }) => {
  const stamp = Date.now();
  const Y_MSG = `Y-OUTSIDE-${stamp}`; // the OTHER writer's commit (origin moves to this)
  const Z_MSG = `Z-LOOP-${stamp}`;    // the loop's commit (must rebase on top of Y)

  // ── Step 1: land on /loop, create a loop from roster1 through the real UI. ──
  await page.goto("/loop");
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-concurrent-${stamp}`;
  // Capture the create RESPONSE so we learn THIS loop's id authoritatively. The
  // suite shares one LOOPAT_HOME and loops accumulate across cases, so reading
  // the id from the browser URL can return a STALE loop's id; the create
  // response is the only authoritative source.
  const createResp = page.waitForResponse(
    (resp) => resp.url().includes("/api/v1/loops") && resp.request().method() === "POST",
    { timeout: 15_000 },
  );

  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(loopTitle);
  await page.getByRole("button", { name: "create", exact: true }).click();

  const resp = await createResp;
  const respBody = await resp.json();
  // v1 ids carry a `loop_` prefix; the loop URL uses the raw uuid.
  const loopId = String(respBody.id ?? respBody.loop?.id ?? "").replace(/^loop_/, "");
  expect(loopId, `create response should carry the new loop id: ${JSON.stringify(respBody)}`).toMatch(/^[a-f0-9-]+$/);
  createdLoopId = loopId;

  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 15_000 });
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByText(loopTitle)).toBeVisible({ timeout: 10_000 });
  expect(runningContainers(loopId), "no container before the terminal opens").toEqual([]);

  // ── Step 2: open the terminal → backend ensureContainer (worktree the workdir
  //            off roster1, start the sandbox). No chat turn → no AI tokens.
  //            Poll podman until the sandbox container is RUNNING. ──
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);

  // First use may still be building the per-loop image behind the
  // PreparingOverlay (z-30 backdrop captures pointer events) — wait for it to
  // clear before typing into the terminal.
  const preparingOverlay = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparingOverlay).toBeHidden({ timeout: 240_000 });

  // Focus the xterm. The sandbox shell is fish — keep every command fish-valid
  // (no `2>&1`, no `(subshell)`; use `; and` / `; or`).
  const xterm = page.locator(".xterm-helper-textarea");
  await expect(xterm).toBeVisible({ timeout: 15_000 });
  await xterm.click();

  // ── Step 2 (cont.): set identity, make the loop's Z-BASE commit, and push it
  //            so the loop and origin START IN SYNC. This is the honest starting
  //            point — the loop is NOT yet behind. ──
  await runInTerminal(page, "git config user.email loop@local");
  await runInTerminal(page, "git config user.name loop");
  await runInTerminal(page, `echo zbase-${stamp} >> loop.txt`);
  await runInTerminal(page, "git add -A");
  await runInTerminal(page, `git commit -m 'Z-BASE-${stamp}'`);
  await runInTerminal(page, "git push origin HEAD:master", 6_000);

  // INTEGRATION TRUTH: the Z-BASE push reached origin → loop + origin in sync.
  await expect
    .poll(() => fixtureRosterTipSubject(), {
      message: `expected the loop's Z-BASE push to reach origin (tip should be Z-BASE-${stamp})`,
      timeout: 60_000,
      intervals: [1_000, 2_000, 3_000],
    })
    .toBe(`Z-BASE-${stamp}`);
  console.log(`[dogfood] origin tip after loop Z-BASE push: ${fixtureRosterTipSubject()}`);

  // ── Step 3: advance origin from OUTSIDE the loop. The OTHER writer commits Y
  //            on master and pushes it. The loop's local master ref still points
  //            at Z-BASE, so the loop is now genuinely BEHIND. ──
  advanceOriginFromOutside(Y_MSG, `outside-${stamp}`);
  expect(
    fixtureRosterTipSubject(),
    "after the outside writer pushed Y, origin's tip must be Y",
  ).toBe(Y_MSG);
  const logAfterY = fixtureRosterLog();
  console.log(`[dogfood] origin log after OUTSIDE writer pushed Y:\n${logAfterY}`);
  expect(logAfterY, "origin should contain the outside writer's commit Y").toContain(Y_MSG);

  // ── Step 4: in the loop terminal, commit Z on the (now-stale) base and push.
  //            The loop has NOT fetched, so its master is still at Z-BASE and the
  //            push is a NON-FAST-FORWARD → REJECTED. ──
  await runInTerminal(page, `echo zwork-${stamp} >> loop.txt`);
  await runInTerminal(page, "git add -A");
  await runInTerminal(page, `git commit -m '${Z_MSG}'`);
  await runInTerminal(page, "git push origin HEAD:master", 6_000);

  // PROVE THE REJECTION BY STATE (not by scraping the xterm): give the rejected
  // push time to round-trip, then assert origin's tip is STILL Y and that Z did
  // NOT land. A *successful* push would have moved the tip to Z; a non-ff
  // rejection leaves it at Y. We hold this assertion for several seconds to be
  // sure Z never sneaks in.
  await page.waitForTimeout(4_000);
  for (let i = 0; i < 5; i++) {
    expect(
      fixtureRosterTipSubject(),
      "after the loop's STALE push, origin's tip must STILL be Y — the non-ff push was rejected, Z did NOT land",
    ).toBe(Y_MSG);
    expect(
      fixtureRosterLog(),
      "the loop's commit Z must NOT be in origin yet — the first (stale) push was rejected",
    ).not.toContain(Z_MSG);
    await page.waitForTimeout(1_000);
  }
  console.log(`[dogfood] PROVEN rejected: origin tip still ${Y_MSG}, Z absent — first push was non-ff rejected`);

  // ── Step 5: resolve the standard way — pull --rebase onto origin's master,
  //            then push again. After the rebase, the loop's Z sits on top of Y,
  //            so the push is now a fast-forward and succeeds.
  //            We use `git pull --rebase origin master` (fetch master + rebase
  //            onto FETCH_HEAD) rather than `git rebase origin/master`: the loop
  //            workdir is a worktree off a bare mirror whose fetch refspec maps
  //            origin's master into the LOCAL `refs/heads/master` (not a
  //            `refs/remotes/origin/master` tracking ref), so the explicit
  //            `origin master` pull-rebase is the layout-independent, canonical
  //            "resolve a non-ff" move. ──
  await runInTerminal(page, "git pull --rebase origin master", 6_000);
  await runInTerminal(page, "git push origin HEAD:master", 6_000);

  // DIAGNOSTIC: dump the loop workdir's local git state from the sandbox (truth,
  // not the flaky xterm) so a resolution failure is debuggable.
  const wd = `/loopat/loop/${loopId}/workdir`;
  console.log(`[dogfood] sandbox local log:\n${sandboxExec(loopId, `git -C ${wd} log --oneline -5`)}`);
  console.log(`[dogfood] sandbox rebase state: ${sandboxExec(loopId, `git -C ${wd} status -sb; ls ${wd}/.git/rebase-merge ${wd}/.git/rebase-apply 2>/dev/null; true`)}`);

  // ── Step 6: INTEGRATION TRUTH — origin now contains BOTH Y and Z. The conflict
  //            was resolved; the second writer rebased on top of the first and
  //            both landed. Poll for Z (the rebase+push may still be flushing).
  await expect
    .poll(() => fixtureRosterLog(), {
      message: `expected origin to contain the loop's commit ${Z_MSG} after fetch+rebase+re-push`,
      timeout: 60_000,
      intervals: [1_000, 2_000, 3_000],
    })
    .toContain(Z_MSG);

  const finalLog = fixtureRosterLog();
  console.log(`[dogfood] origin log AFTER fetch+rebase+re-push:\n${finalLog}`);

  // Both writers' commits are in origin's history.
  expect(finalLog, "origin must contain the OUTSIDE writer's commit Y").toContain(Y_MSG);
  expect(finalLog, "origin must contain the LOOP's commit Z").toContain(Z_MSG);

  // And the loop's Z is on TOP (rebased onto Y) — Z is the current tip, Y is
  // strictly below it in history. The rebase put the last writer on top.
  expect(
    fixtureRosterTipSubject(),
    "after resolution, origin's tip must be the loop's rebased Z (last writer on top)",
  ).toBe(Z_MSG);
  const lines = finalLog.split("\n");
  const zIdx = lines.findIndex((l) => l.includes(Z_MSG));
  const yIdx = lines.findIndex((l) => l.includes(Y_MSG));
  expect(zIdx, "Z must appear in the log").toBeGreaterThanOrEqual(0);
  expect(yIdx, "Y must appear in the log").toBeGreaterThanOrEqual(0);
  expect(zIdx, "Z (rebased) must sit above Y in history — last writer rebased on top").toBeLessThan(yIdx);

  console.log(`[dogfood] PROVEN resolved: non-ff conflict → fetch+rebase+re-push → both Y and Z in origin, Z on top`);
});
