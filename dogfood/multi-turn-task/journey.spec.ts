/**
 * multi-turn-task — proof that the real AI can do a multi-STEP task with tool
 * use, not just emit a one-line reply.
 *
 * first-5-minutes proves the AI *replies*; this proves the AI *acts*. One chat
 * instruction forces several distinct tool actions (read a file, write a new
 * file, git add, git commit). We then assert the AI actually DID the work via
 * INTEGRATION TRUTH — `podman exec` into the loop's sandbox container to read the
 * file it produced and the commit it made — never the AI's (non-deterministic)
 * words.
 *
 * Deterministic artifact: the roster1 fixture's README.md is the single line
 * `hello` (seed.sh), so SUMMARY.md's first line must be exactly `DOGFOOD hello`,
 * and the loop's latest commit subject must be `add summary`. Fixed sentinels =
 * a stable assertion despite AI nondeterminism.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user ALREADY ONBOARDED with the idealab
 * provider and roster repo roster1. We arrive logged in via storageState.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

const README_FIRST_LINE = "hello"; // roster1 README.md, seeded by seed.sh
const SENTINEL = "DOGFOOD";
const EXPECTED_FIRST_LINE = `${SENTINEL} ${README_FIRST_LINE}`;
const COMMIT_MSG = "add summary";

/** Names of RUNNING sandbox containers for this loop id (empty array = none).
 *  The container is labelled loopat.loop-id=<id> (podman.ts) with the same id
 *  the loop URL carries. */
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

/** The single running sandbox container for this loop (throws otherwise). */
function sandboxContainer(loopId: string): string {
  const names = runningContainers(loopId);
  if (names.length !== 1) {
    throw new Error(`expected exactly one running sandbox container for loop ${loopId}, got: ${names.join(", ")}`);
  }
  return names[0];
}

/** Run a shell command INSIDE the loop's sandbox container and return stdout.
 *  This is the container's own truth about what the AI produced — the workdir is
 *  bind-mounted at V_LOOP_WORKDIR = /loopat/loop/<id>/workdir (podman.ts). */
function sandboxExec(loopId: string, cmd: string): string {
  return execFileSync("podman", [
    "exec",
    sandboxContainer(loopId),
    "sh",
    "-lc",
    cmd,
  ])
    .toString();
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

test("multi-turn task: AI reads README, writes a deterministic SUMMARY.md, and commits it", async ({ page }) => {
  // ── Step 1: land on /loop, create a loop from roster1 through the real UI. ──
  await page.goto("/loop");
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-mtt-${Date.now()}`;
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
  const body = resp.request().postDataJSON();
  expect(body.title).toBe(loopTitle);
  expect(body.repo).toBe("roster1");
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

  // ── Step 2: open the terminal → backend ensureContainer (worktree the workdir
  //            off roster1, start the sandbox). No chat turn yet → no AI tokens.
  //            Poll podman until the sandbox container is RUNNING. ──
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);

  // ── Step 3: first use may still be building the per-loop image — the
  //            PreparingOverlay captures pointer events (z-30 backdrop) so a chat
  //            turn fired now would just queue. Wait for it to clear. ──
  const preparingOverlay = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparingOverlay).toBeHidden({ timeout: 240_000 });

  // ── Step 4: send ONE instruction that forces several tool actions. This is the
  //            step that spends idealab tokens. Crisp + deterministic so the AI
  //            completes the full tool chain reliably on the first run. ──
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await composer.fill(
    `Do these steps in the current workdir, using your tools:\n` +
      `1. Read the file README.md and note its first line.\n` +
      `2. Create a new file named SUMMARY.md whose ONLY content is a single line: ` +
      `the word ${SENTINEL}, then one space, then README.md's first line. ` +
      `(For this repo that line is exactly "${EXPECTED_FIRST_LINE}".)\n` +
      `3. Run \`git add SUMMARY.md\` and then \`git commit -m '${COMMIT_MSG}'\`.\n` +
      `Do not push. Report the final commit hash when done.`,
  );
  await page.getByRole("button", { name: "Send message" }).click();

  // The assistant turn streams in. Wait for an assistant message with actual
  // text content. Real AI + a multi-tool turn is slow → generous timeout.
  const assistantMessages = page.locator('[data-role="assistant"]');
  await expect
    .poll(
      async () => {
        const n = await assistantMessages.count();
        for (let i = 0; i < n; i++) {
          const t = (await assistantMessages.nth(i).innerText()).trim();
          if (t.length > 0) return t;
        }
        return "";
      },
      {
        message: "expected a non-empty assistant reply from the real AI",
        timeout: 180_000,
        intervals: [2_000, 3_000, 5_000],
      },
    )
    .not.toBe("");

  // No error event anywhere in the transcript (a backend error renders as an
  // assistant message prefixed with "⚠️" — see useLoopRuntime.tsx).
  const allAssistantText = (await assistantMessages.allInnerTexts()).join("\n");
  expect(allAssistantText, "no error event should appear in the chat").not.toContain("⚠️");
  console.log(`[dogfood] assistant reply (first 200 chars): ${(await assistantMessages.last().innerText()).trim().slice(0, 200)}`);

  // ── INTEGRATION TRUTH: don't trust the AI's words. Read the artifact + commit
  //    straight out of the sandbox container. The AI's tool turn may still be
  //    flushing the last action to disk after the reply renders, so POLL. ──

  // (a) SUMMARY.md exists and its first line is exactly the deterministic sentinel.
  await expect
    .poll(
      () => {
        try {
          // `head -1` so trailing content (if the AI added any) can't break the
          // assertion — we only pin the FIRST line, which is the deterministic part.
          return sandboxExec(loopId, `head -1 /loopat/loop/${loopId}/workdir/SUMMARY.md`).trim();
        } catch {
          return ""; // file not written yet
        }
      },
      {
        message: `expected SUMMARY.md first line "${EXPECTED_FIRST_LINE}" in the loop workdir`,
        timeout: 60_000,
        intervals: [1_000, 2_000, 3_000],
      },
    )
    .toBe(EXPECTED_FIRST_LINE);
  console.log(`[dogfood] SUMMARY.md first line (from sandbox): ${EXPECTED_FIRST_LINE}`);

  // (b) the AI actually committed it — latest commit subject is the expected msg.
  await expect
    .poll(
      () => {
        try {
          return sandboxExec(
            loopId,
            `git -C /loopat/loop/${loopId}/workdir log --oneline -1`,
          ).trim();
        } catch {
          return "";
        }
      },
      {
        message: `expected the loop's latest commit subject to be "${COMMIT_MSG}"`,
        timeout: 60_000,
        intervals: [1_000, 2_000, 3_000],
      },
    )
    .toContain(COMMIT_MSG);

  const lastCommit = sandboxExec(loopId, `git -C /loopat/loop/${loopId}/workdir log --oneline -1`).trim();
  console.log(`[dogfood] loop workdir latest commit (from sandbox): ${lastCommit}`);
  expect(lastCommit, "the AI's commit must be the latest in the workdir").toContain(COMMIT_MSG);

  // (c) SUMMARY.md is tracked by git at that commit (not just an untracked file).
  const tracked = sandboxExec(
    loopId,
    `git -C /loopat/loop/${loopId}/workdir ls-files SUMMARY.md`,
  ).trim();
  expect(tracked, "SUMMARY.md must be committed (tracked by git), not left untracked").toBe("SUMMARY.md");
  console.log("[dogfood] PROVEN: AI read README, wrote deterministic SUMMARY.md, and committed it");
});
