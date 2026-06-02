/**
 * context-notes-sync — a loop edits its NOTES context worktree and pushes back
 * to the fixture notes origin (the docs/context-flow.md model in the flesh).
 *
 * Unlike first-5-minutes (which pushes the loop's WORKDIR off a roster repo),
 * this exercises CONTEXT SYNC: the per-loop `/loopat/context/notes` mount is a
 * git worktree whose `origin` is the team notes repo, cloned PER-USER with the
 * VAULT key by the backend's `ensureUserContext` (the notes url comes from the
 * knowledge repo's `.loopat/config.json` — set in seed.sh). The loop writes a
 * file there, commits, and pushes; the push must reach the fixture notes.git.
 *
 * Why this is the high-value case: the per-user knowledge/notes clone path is a
 * DIFFERENT credential/url path than the roster workdir. roster repos clone with
 * absolute `ssh://git@<ip>:<port>/…` urls; the notes url in seed.sh is the Host-
 * alias form `git@loopat-fixture:notes.git`, which must resolve BOTH host-side
 * (the clone in ensureUserContext, via GIT_SSH_COMMAND `-F <vault config>`) AND
 * inside the sandbox (the push, via the vault ssh config mounted at $HOME/.ssh).
 *
 * Truth is INTEGRATION, not the DOM: we drive the push from the terminal (no
 * chat turn → ~no AI tokens) and verify the commit landed by reading the fixture
 * notes.git log via `podman exec`.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user ALREADY ONBOARDED with the idealab
 * provider, roster repo roster1, and a knowledge repo whose `.loopat/config.json`
 * points notes at the fixture notes.git. We arrive logged in via storageState.
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

/** `git log --oneline` of the fixture's bare notes.git — the origin's TRUTH.
 *  The bare repo is owned by `git`; `podman exec` runs as root, so git refuses
 *  with "dubious ownership" — `-c safe.directory=*` waives that (we only read). */
function fixtureNotesLog(): string {
  return execFileSync("podman", [
    "exec",
    fixtureContainer(),
    "git",
    "-c",
    "safe.directory=*",
    "-C",
    "/srv/git/notes.git",
    "log",
    "--oneline",
    "--all",
  ])
    .toString()
    .trim();
}

/** Type a shell command into the focused xterm, run it, and give it time to
 *  execute. Reading the xterm prompt back is flaky, so we pace with a fixed
 *  settle delay between commands instead of prompt-matching. */
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

test("context sync: loop edits its notes worktree and pushes back to the fixture notes origin", async ({ page }) => {
  // ── Step 1: land on /loop, logged in; create a loop from roster1. ──
  await page.goto("/loop");
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-notes-${Date.now()}`;
  // Capture the create RESPONSE so we learn THIS loop's id authoritatively. The
  // suite shares one LOOPAT_HOME and loops accumulate across cases, so reading
  // the id from the browser URL right after the click can return a STALE loop's
  // id; the create response is the only authoritative source.
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
  expect(resp.request().postDataJSON().title).toBe(loopTitle);
  const respBody = await resp.json();
  // The v1 API ids carry a `loop_` prefix; the loop URL uses the raw uuid.
  const loopId = String(respBody.id ?? respBody.loop?.id ?? "").replace(/^loop_/, "");
  expect(loopId, `create response should carry the new loop id: ${JSON.stringify(respBody)}`).toMatch(/^[a-f0-9-]+$/);
  createdLoopId = loopId;

  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 15_000 });

  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByText(loopTitle)).toBeVisible({ timeout: 10_000 });
  expect(runningContainers(loopId), "no container before the terminal opens").toEqual([]);

  // ── Step 2: open the terminal → backend ensureContainer (and, on loop create,
  //            ensureUserContext already cloned the per-user notes repo with the
  //            vault key + ensureContextMounts worktree'd it into the loop). Wait
  //            until the sandbox container is RUNNING. If the per-user notes clone
  //            had failed, the worktree would be empty and the push below would
  //            fail — that's the gap this case is built to surface. ──
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);

  // First use may still be building the per-loop image — the PreparingOverlay
  // captures pointer events until the terminal is usable.
  const preparingOverlay = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparingOverlay).toBeHidden({ timeout: 240_000 });

  // ── Step 3: drive the terminal. The sandbox shell is fish (no `2>&1`, no
  //            `(subshell)`; use `; and` / `; or`). ──
  const xterm = page.locator(".xterm-helper-textarea");
  await expect(xterm).toBeVisible({ timeout: 15_000 });
  await xterm.click();

  const beforeLog = fixtureNotesLog();
  console.log(`[dogfood] fixture notes.git log BEFORE:\n${beforeLog}`);

  // Go to the notes context dir (the V_CONTEXT_NOTES mount) and confirm it is a
  // REAL git worktree, not an empty dir (which is what an empty/failed per-user
  // notes clone would leave — see ensurePerUserContextWorktree). SOFT check via
  // a sentinel; the HARD proof is the push reaching origin below.
  await runInTerminal(page, "cd /loopat/context/notes");
  await runInTerminal(
    page,
    'git rev-parse --is-inside-work-tree > /dev/null 2>/dev/null; and echo DOGFOOD_NOTES_GIT_OK; or echo DOGFOOD_NOTES_GIT_FATAL',
  );
  await expect(page.locator(".xterm-screen")).toBeVisible();
  let termText = "";
  for (let i = 0; i < 10; i++) {
    termText = await page.locator(".xterm-screen").innerText().catch(() => "");
    if (termText.includes("DOGFOOD_NOTES_GIT")) break;
    await page.waitForTimeout(1_000);
  }
  if (termText.includes("DOGFOOD_NOTES_GIT")) {
    expect(
      termText,
      "/loopat/context/notes must be a real git worktree (per-user notes clone must have succeeded)",
    ).not.toContain("DOGFOOD_NOTES_GIT_FATAL");
    expect(termText).toContain("DOGFOOD_NOTES_GIT_OK");
    console.log("[dogfood] notes worktree git OK (read from xterm)");
  } else {
    console.log("[dogfood] terminal buffer unreadable (flaky xterm) — relying on push-to-origin as proof");
  }

  // ── Step 4: write a file into notes, add + commit + push to origin. The push
  //            SUCCEEDING is the hard proof the worktree's origin (the per-user
  //            notes clone, vault-key auth) is wired correctly. ──
  const stamp = Date.now();
  const noteFile = `dogfood-note-${stamp}.md`;
  const commitMsg = `dogfood notes sync ${stamp}`;
  await runInTerminal(page, "git config user.email dogfood@local");
  await runInTerminal(page, "git config user.name dogfood");
  await runInTerminal(page, `echo notes-sync-${stamp} > ${noteFile}`);
  await runInTerminal(page, "git add -A");
  await runInTerminal(page, `git commit -m '${commitMsg}'`);
  // The worktree opens on branch loop/<id> from origin's default (master). Push
  // it to master so it lands on the fixture's default branch.
  await runInTerminal(page, "git push origin HEAD:master", 5_000);

  // ── INTEGRATION TRUTH: poll the fixture notes origin until the commit lands.
  //            Don't trust the terminal DOM for the push result. ──
  await expect
    .poll(() => fixtureNotesLog(), {
      message: `expected the notes commit "${commitMsg}" to reach fixture notes.git`,
      timeout: 60_000,
      intervals: [1_000, 2_000, 3_000],
    })
    .toContain(commitMsg);

  const afterLog = fixtureNotesLog();
  console.log(`[dogfood] fixture notes.git log AFTER push:\n${afterLog}`);
  expect(afterLog, "the notes origin must have received the loop's commit").toContain(commitMsg);
});
