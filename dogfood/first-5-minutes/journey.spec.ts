/**
 * first-5-minutes — Task 3: create a loop from a roster repo through the real
 * UI and confirm its sandbox container actually comes up.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) has already booted the
 * real stack and preconfigured the `test` user as ALREADY ONBOARDED with the
 * `idealab` provider and a roster repo `roster1`. We arrive logged in via
 * storageState.
 *
 * This spec deliberately does NOT send a chat message (that's Task 4, and it
 * would burn the AI key). Creating a loop is cheap; opening the terminal panel
 * is what triggers `ensureContainer` (term.ts) — it `git worktree`s the workdir
 * off the roster1 mirror (cloned over real ssh with the fresh vault key) and
 * starts the per-loop podman sandbox. We then assert, against podman directly,
 * that the loop's container is actually RUNNING.
 *
 * Why poll podman instead of the sidebar "Ready" badge: the badge is driven by
 * the /ws/loop-status WebSocket, which races (the update can land before the
 * sidebar subscribes, or after teardown). podman is the integration truth — it
 * cannot lie about whether a container is up. The container is labelled
 * `loopat.loop-id=<id>` (podman.ts) with the same id the loop URL carries.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

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

test.beforeEach(async ({ page }) => {
  // Bypass the "Setup Personal Repo" card for the (preconfigured) account.
  await page.addInitScript(() => {
    localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
  });
});

test("first 5 minutes: create a loop from roster1 → sandbox container running", async ({ page }) => {
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
});
