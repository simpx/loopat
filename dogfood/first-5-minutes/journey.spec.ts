/**
 * first-5-minutes — the WHOLE first five minutes, end to end:
 *   Task 3: create a loop from a roster repo through the real UI → sandbox
 *           container running.
 *   Task 4: type an instruction in the chat input, send it, and assert the
 *           REAL AI replies (a non-empty assistant message, no error event).
 *   Task 5: open the terminal panel, run `git status` (the regression: the
 *           workdir gitdir bug made this `fatal: not a git repository`), then
 *           make a change + add + commit + push, and verify — via INTEGRATION
 *           TRUTH (podman exec into the fixture origin), not the terminal DOM —
 *           that the commit actually reached `roster1.git`.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) has already booted the
 * real stack and preconfigured the `test` user as ALREADY ONBOARDED with the
 * `idealab` provider and a roster repo `roster1`. We arrive logged in via
 * storageState.
 *
 * Why poll podman instead of the sidebar "Ready" badge: the badge is driven by
 * the /ws/loop-status WebSocket, which races (the update can land before the
 * sidebar subscribes, or after teardown). podman is the integration truth — it
 * cannot lie about whether a container is up. The container is labelled
 * `loopat.loop-id=<id>` (podman.ts) with the same id the loop URL carries.
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

/** `git log --oneline` of the fixture's bare roster1.git — the origin's TRUTH. */
function fixtureRosterLog(): string {
  // The bare repo is owned by the `git` user; `podman exec` defaults to root, so
  // git refuses with "dubious ownership". `-c safe.directory=*` waives that — we
  // only read the log.
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

test.beforeEach(async ({ page }) => {
  // Bypass the "Setup Personal Repo" card for the (preconfigured) account.
  await page.addInitScript(() => {
    localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
  });
});

test("first 5 minutes: create loop → container running → AI replies → terminal git push reaches origin", async ({ page }) => {
  // ── Step 1: land on /loop, logged in. With zero loops the page shows the
  //            empty state (no `aside` sidebar yet), so assert on the always-
  //            present "+ New Loop" button instead. ──
  await page.goto("/loop");
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-${Date.now()}`;

  // Capture the real create request so we know it hit the v1 API (set up before
  // the click so we don't miss it).
  const createReq = page.waitForRequest(
    (req) => req.url().includes("/api/v1/loops") && req.method() === "POST",
    { timeout: 15_000 },
  );

  // ── Step 2: open NewLoopDialog, pick the roster1 repo, create. ──
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });

  // The Repo <select> is the first combobox; its option values are repo names.
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(loopTitle);
  await page.getByRole("button", { name: "create", exact: true }).click();

  const req = await createReq;
  const body = req.postDataJSON();
  expect(body.title).toBe(loopTitle);
  expect(body.repo).toBe("roster1");

  // ── Step 3: navigated to the new loop's page; the sidebar now lists it. ──
  await expect(page).toHaveURL(/\/loop\/[a-f0-9-]+/, { timeout: 15_000 });
  const loopId = page.url().split("/loop/")[1].split(/[?#]/)[0];
  expect(loopId).toMatch(/^[a-f0-9-]+$/);

  const sidebar = page.locator("aside");
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByText(loopTitle)).toBeVisible({ timeout: 10_000 });

  // No container exists for this brand-new loop yet — nothing has touched it.
  expect(runningContainers(loopId), "no container should exist before the terminal opens").toEqual([]);

  // ── Step 4: open the terminal panel. This opens the /ws/loop/:id/term socket,
  //            which makes the backend `ensureContainer` for the loop's sandbox
  //            — git-worktree the workdir off the roster1 mirror (cloned over
  //            real ssh with the fresh vault key) and start the container. No
  //            chat message is sent, so no AI tokens are spent. ──
  await page.getByRole("button", { name: /terminal/ }).first().click();

  // ── Step 5: wait until podman actually has a RUNNING container for this loop.
  //            Real startup (image pull on a cold cache + worktree) is slow →
  //            generous timeout. If the ssh clone of roster1 had failed (bad key
  //            perms / missing authorized_keys / wrong Host alias), the workdir
  //            worktree would fail and the container would never come up — this
  //            poll would time out, which is exactly the signal we want. ──
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);

  // ── Step 6: the sandbox container is up, but on first use the backend may
  //            still be building the per-loop image (mise toolchain install).
  //            While that runs, LoopPage shows the PreparingOverlay — a z-30
  //            backdrop that captures pointer events so you can't type into a
  //            not-yet-ready terminal or fire a chat turn that just queues.
  //            Wait for it to clear before driving chat/terminal. ──
  const preparingOverlay = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparingOverlay).toBeHidden({ timeout: 240_000 });

  // ── Task 4: send a real instruction in the chat input and assert the REAL AI
  //            replies. This is the step that spends idealab tokens. The AI is
  //            non-deterministic, so we assert BEHAVIOR, not words: a non-empty
  //            assistant message appears and NO error event surfaces.
  //            (A backend error event renders as an assistant message prefixed
  //            with "⚠️" — see useLoopRuntime.tsx — so we assert no message
  //            contains that.) ──
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await composer.fill(
    "Create a file notes.txt containing the text hi, then git add it, commit it with message 'add notes', and git push.",
  );
  await page.getByRole("button", { name: "Send message" }).click();

  // The assistant turn streams in. Wait for an assistant message with actual
  // text content. Real AI + a tool-running turn can take a while → generous.
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
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .not.toBe("");

  // No error event anywhere in the transcript.
  const reply = (await assistantMessages.last().innerText()).trim();
  const allAssistantText = (await assistantMessages.allInnerTexts()).join("\n");
  expect(allAssistantText, "no error event should appear in the chat").not.toContain("⚠️");
  console.log(`[dogfood] assistant reply (first 200 chars): ${reply.slice(0, 200)}`);

  // ── Task 5: terminal git — THE regression. The terminal panel is already
  //            open (Step 4). The shell lands in the loop's workdir, which is a
  //            git worktree off the roster1 mirror. The shipped bug made
  //            `git status` there return "fatal: not a git repository"; assert
  //            it does NOT. xterm output is flaky to read, so this is a SOFT
  //            check; the push is verified host-side via podman exec. ──
  const beforeLog = fixtureRosterLog();
  console.log(`[dogfood] fixture roster1.git log BEFORE terminal:\n${beforeLog}`);

  const xterm = page.locator(".xterm-helper-textarea");
  await expect(xterm).toBeVisible({ timeout: 15_000 });
  await xterm.click();
  // The sandbox shell is fish, not bash — keep every command fish-valid
  // (no `2>&1`, no `(subshell)`; use `; and` / `; or`).

  // `git status` with a sentinel that survives the flaky xterm read. Reading the
  // xterm buffer is best-effort (the WebGL renderer makes innerText unreliable),
  // so this is a SOFT check: if we CAN read it, it must show OK, never FATAL.
  // The hard proof that the workdir is a real git repo is the push below
  // reaching the origin — `git push` simply cannot succeed from a non-repo.
  await runInTerminal(
    page,
    'git status > /dev/null 2>/dev/null; and echo DOGFOOD_GIT_OK; or echo DOGFOOD_GIT_FATAL',
  );
  // Give the shell a moment, then try to read the rendered buffer.
  await expect(page.locator(".xterm-screen")).toBeVisible();
  let termText = "";
  for (let i = 0; i < 10; i++) {
    termText = await page.locator(".xterm-screen").innerText().catch(() => "");
    if (termText.includes("DOGFOOD_GIT")) break;
    await page.waitForTimeout(1_000);
  }
  if (termText.includes("DOGFOOD_GIT")) {
    expect(
      termText,
      "git status in the workdir must NOT be `fatal: not a git repository` (the shipped bug)",
    ).not.toContain("DOGFOOD_GIT_FATAL");
    expect(termText).toContain("DOGFOOD_GIT_OK");
    console.log("[dogfood] terminal git status: DOGFOOD_GIT_OK (read from xterm)");
  } else {
    console.log("[dogfood] terminal buffer unreadable (flaky xterm) — relying on push-to-origin as proof of a working workdir git");
  }

  // Make a change + add + commit + push from the terminal. If the AI in Task 4
  // already committed+pushed, this adds an independent terminal commit on top —
  // either way we prove the workdir git works AND the push reaches the origin.
  // Configure identity inline (the sandbox may not have a global one). The push
  // SUCCEEDING is the hard proof the workdir is a real git repository.
  const stamp = Date.now();
  const commitMsg = `dogfood terminal commit ${stamp}`;
  await runInTerminal(page, "git config user.email dogfood@local");
  await runInTerminal(page, "git config user.name dogfood");
  await runInTerminal(page, `echo terminal-${stamp} >> dogfood-terminal.txt`);
  await runInTerminal(page, "git add -A");
  await runInTerminal(page, `git commit -m '${commitMsg}'`);
  await runInTerminal(page, "git push origin HEAD:master", 4_000);

  // ── INTEGRATION TRUTH: poll the fixture origin until the new commit lands.
  //            Don't trust the terminal DOM for the push result. ──
  await expect
    .poll(() => fixtureRosterLog(), {
      message: `expected the terminal commit "${commitMsg}" to reach fixture roster1.git`,
      timeout: 60_000,
      intervals: [1_000, 2_000, 3_000],
    })
    .toContain(commitMsg);

  const afterLog = fixtureRosterLog();
  console.log(`[dogfood] fixture roster1.git log AFTER push:\n${afterLog}`);
  expect(afterLog, "the origin must have received the terminal commit").toContain(commitMsg);
});
