/**
 * attach-detach — regresses the CONFIG-HASH-DRIFT bug.
 *
 * THE BUG WE GUARD: a loop's sandbox container is created once (lazily, on
 * first terminal attach) and must PERSIST across every later open/close of the
 * loop or its terminal. `ensureContainer` (server/src/podman.ts) decides
 * reuse-vs-recreate by comparing a per-loop config hash (`hashCreateArgs`,
 * stamped as the `loopat.config-hash` label) + the resolved image ID against
 * what it recomputes on each call. If that hash ever drifted between two
 * attaches for the SAME loop+vault, ensureContainer would hit its
 *   "running, hash drift → stop + rm + create + start"
 * branch — tearing the container down and SIGKILL-137'ing every in-flight
 * `podman exec` (the PTY shell, an active claude turn, a user's dev server).
 *
 * THE REGRESSION SIGNAL (integration truth via `podman inspect`, not the DOM):
 *   - SAME container ID across detach→reattach, AND
 *   - UNCHANGED `StartedAt` (and `CreatedAt`).
 * A recreate resets `StartedAt`; an unchanged `StartedAt` proves the exact same
 * container process kept running — no drift, no teardown. We cycle
 * detach→reattach TWICE so one lucky no-op can't pass it.
 *
 * NO chat message is sent → zero AI tokens.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user ALREADY ONBOARDED with the idealab
 * provider and roster repo roster1. We arrive logged in via storageState.
 */
import { test, expect, type Page } from "@playwright/test";
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

/** The single running container's identity fields for this loop. Throws unless
 *  exactly one is running — the drift bug would briefly produce zero (during the
 *  rm) or, after recreate, a container with a different Id/StartedAt. */
function containerIdentity(loopId: string): {
  id: string;
  startedAt: string;
  createdAt: string;
} {
  const names = runningContainers(loopId);
  if (names.length !== 1) {
    throw new Error(`expected exactly one running container for loop ${loopId}, got: ${names.join(", ")}`);
  }
  // `.Id` is the full container id; `.State.StartedAt` / `.Created` are RFC3339
  // timestamps that only change when the container is (re)created+started.
  const out = execFileSync("podman", [
    "inspect",
    "--format",
    "{{.Id}}|{{.State.StartedAt}}|{{.Created}}",
    names[0],
  ])
    .toString()
    .trim();
  const [id, startedAt, createdAt] = out.split("|");
  expect(id, "container should have an Id").toBeTruthy();
  expect(startedAt, "container should have a StartedAt").toBeTruthy();
  return { id, startedAt, createdAt };
}

/** Open the terminal panel (opens /ws/loop/:id/term → backend ensureContainer)
 *  and poll podman until this loop's sandbox container is RUNNING. */
async function openTerminalAndWait(page: Page, loopId: string): Promise<void> {
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);
  // First use may still be building the per-loop image behind the
  // PreparingOverlay; wait for it to clear so a later reopen drives a warm,
  // already-running container (the real attach/detach scenario).
  const preparingOverlay = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparingOverlay).toBeHidden({ timeout: 240_000 });
}

test.beforeEach(async ({ page }) => {
  // Bypass the "Setup Personal Repo" card for the (preconfigured) account.
  await page.addInitScript(() => {
    localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
  });
});

test("attach/detach a loop repeatedly does NOT recreate its container (no config-hash drift)", async ({ page }) => {
  // ── Step 1: land on /loop and create a loop from roster1. ──
  await page.goto("/loop");
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-attach-${Date.now()}`;
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
  // v1 ids carry a `loop_` prefix; the loop URL uses the raw uuid.
  const respBody = await resp.json();
  const loopId = String(respBody.id ?? respBody.loop?.id ?? "").replace(/^loop_/, "");
  expect(loopId, `create response should carry the new loop id: ${JSON.stringify(respBody)}`).toMatch(/^[a-f0-9-]+$/);

  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 15_000 });
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByText(loopTitle)).toBeVisible({ timeout: 10_000 });

  // Brand-new loop — nothing has touched it, so no container yet.
  expect(runningContainers(loopId), "no container should exist before the terminal opens").toEqual([]);

  // ── Step 2: first attach — open terminal, wait for the running container,
  //            record its identity. This is the container that must SURVIVE. ──
  await openTerminalAndWait(page, loopId);
  const baseline = containerIdentity(loopId);
  console.log(
    `[dogfood] baseline container: id=${baseline.id.slice(0, 12)} startedAt=${baseline.startedAt} createdAt=${baseline.createdAt}`,
  );

  // ── Steps 3–4, twice: detach (back to /loop list, unmounting the terminal +
  //            closing the term socket) then re-attach (reopen the terminal,
  //            which calls ensureContainer again). After EACH reattach, assert
  //            the container is the SAME and was NOT recreated. ──
  for (let cycle = 1; cycle <= 2; cycle++) {
    // Detach: leave the loop entirely → LoopPage + Terminal unmount, the
    // /ws/loop/:id/term socket closes (the "close the terminal panel and
    // navigate away" half of the danger).
    await page.goto("/loop");
    await expect(
      page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // The container must remain running while detached (idle stop is 30min by
    // default, far beyond this test) — detach alone must not tear it down.
    expect(
      runningContainers(loopId),
      `cycle ${cycle}: container must stay running while detached (detach must not stop it)`,
    ).not.toEqual([]);

    // Re-attach: return to the loop and reopen the terminal → ensureContainer
    // runs again for the SAME loop+vault. If the hash drifted, THIS is where
    // the recreate (stop + rm + create + start) would fire.
    await page.goto(`/loop/${loopId}`);
    await openTerminalAndWait(page, loopId);

    const after = containerIdentity(loopId);
    console.log(
      `[dogfood] cycle ${cycle} after reattach: id=${after.id.slice(0, 12)} startedAt=${after.startedAt}`,
    );

    // INTEGRATION TRUTH: same container ID …
    expect(
      after.id,
      `cycle ${cycle}: reattaching must reuse the SAME container — a different id means ensureContainer ` +
        `recreated it (config-hash drift), which SIGKILLs in-flight exec'd processes`,
    ).toBe(baseline.id);

    // … and it was NOT recreated — StartedAt unchanged. A stop+rm+create+start
    // (the drift path) would reset StartedAt; an identical value is the hard
    // proof the exact same container process kept running.
    expect(
      after.startedAt,
      `cycle ${cycle}: container StartedAt must be unchanged — any change means it was torn down + recreated`,
    ).toBe(baseline.startedAt);

    // CreatedAt is even stronger: it only ever changes on `podman create`.
    expect(
      after.createdAt,
      `cycle ${cycle}: container CreatedAt must be unchanged — a recreate would set a new one`,
    ).toBe(baseline.createdAt);
  }

  console.log(
    `[dogfood] PROVEN stable: container ${baseline.id.slice(0, 12)} survived 2 detach→reattach cycles ` +
      `with unchanged StartedAt (${baseline.startedAt}) — no config-hash drift, no recreate`,
  );
});
