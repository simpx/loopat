/**
 * second-loop-warm — regresses the IMAGE-REUSE fix (commit 82d8cf5).
 *
 * THE FIX: the sandbox image tag dropped its per-workspace prefix
 *   `loopat-sandbox-<workspace>-<hash>`  →  content-hash  `loopat-sandbox-<hash>`
 * (and the base tag `loopat-sandbox-<workspace>:latest` → `loopat-sandbox:latest`).
 * Because the tag is now content-addressed, a SECOND loop reuses the FIRST
 * loop's already-built image instead of rebuilding its own per-workspace copy.
 *
 * THE REGRESSION WE GUARD: if the workspace prefix ever creeps back into the
 * tag, loop B would resolve a DIFFERENT image name than loop A, podman would
 * build/tag a fresh image for B, and B's container would NOT be running off the
 * image A already produced. This test catches exactly that.
 *
 * FLOW (no chat turn → zero AI tokens):
 *   1. Create loop A from roster1, open its terminal to trigger ensureContainer,
 *      poll podman until A's sandbox container is RUNNING (runningContainers).
 *   2. SNAPSHOT every loopat-sandbox* image ID that exists now — this is the set
 *      of images present BEFORE loop B starts.
 *   3. Create loop B from roster2, open its terminal, poll until B is RUNNING.
 *   4. INTEGRATION TRUTH (podman, not the DOM):
 *        (a) the image B's container actually runs was ALREADY in the pre-B
 *            snapshot → B triggered no image build of its own (REUSE), and
 *        (b) B runs the SAME image ID as A → they share one content-addressed
 *            image, exactly what the fix intends.
 *
 * Why image-ID identity instead of timing: timing (B faster than A) is flaky on
 * a warm/cold layer cache. "B's image already existed and equals A's" is a hard,
 * deterministic signal that cannot pass under the old per-workspace tagging.
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user ALREADY ONBOARDED with the idealab
 * provider and roster repos roster1 + roster2. We arrive logged in via
 * storageState.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Meta = { loopatHome: string; sshdPort: number };

function meta(): Meta {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", ".test-meta.json"), "utf8"),
  ) as Meta;
}

/** The registered `test` user's id — the single dir under personal/. */
function testUserId(loopatHome: string): string {
  const personalDir = join(loopatHome, "personal");
  const dirs = readdirSync(personalDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one personal/<user> dir, got: ${dirs.join(", ")}`);
  }
  return dirs[0];
}

/** The host default-route IP — same address setup.ts used for fixture git urls,
 *  so the url we type in the UI matches what the loop would clone. */
function hostIp(): string {
  const ip = execFileSync("ip", ["route", "get", "1.1.1.1"])
    .toString()
    .match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) throw new Error("could not determine host default-route IP");
  return ip;
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

/** The image ID the (single) running container for this loop is built from. */
function loopContainerImageId(loopId: string): string {
  const names = runningContainers(loopId);
  if (names.length !== 1) {
    throw new Error(`expected exactly one running container for loop ${loopId}, got: ${names.join(", ")}`);
  }
  return execFileSync("podman", [
    "inspect",
    "--format",
    "{{.Image}}",
    names[0],
  ])
    .toString()
    .trim();
}

/** All sandbox image IDs currently in podman's local store. The set of images
 *  that exist at a given moment — used to prove loop B built none of its own. */
function sandboxImageIds(): Set<string> {
  const out = execFileSync("podman", [
    "images",
    "--no-trunc",
    "--filter",
    "reference=loopat-sandbox*",
    "--format",
    "{{.ID}}",
  ])
    .toString()
    .split("\n")
    // `podman images --no-trunc` prefixes IDs with `sha256:`; container inspect
    // `{{.Image}}` returns the bare hex. Normalize to bare hex so the sets compare.
    .map((s) => s.trim().replace(/^sha256:/, ""))
    .filter(Boolean);
  return new Set(out);
}

/** Create a loop from a roster repo through the real UI; return its loop id once
 *  the page has navigated to it and the sidebar lists it. */
async function createLoop(page: Page, repo: string, title: string): Promise<string> {
  await expect(
    page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Capture the create RESPONSE so we learn THIS loop's id authoritatively —
  // the URL can still read as the previous loop's right after the click.
  const createResp = page.waitForResponse(
    (resp) => resp.url().includes("/api/v1/loops") && resp.request().method() === "POST",
    { timeout: 15_000 },
  );

  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("combobox").first().selectOption(repo);
  await page.getByPlaceholder("refactor-gateway").fill(title);
  await page.getByRole("button", { name: "create", exact: true }).click();

  const resp = await createResp;
  const reqBody = resp.request().postDataJSON();
  expect(reqBody.title).toBe(title);
  expect(reqBody.repo).toBe(repo);
  const respBody = await resp.json();
  // The v1 API ids carry a `loop_` prefix; the loop URL uses the raw uuid.
  const loopId = String(respBody.id ?? respBody.loop?.id ?? "").replace(/^loop_/, "");
  expect(loopId, `create response should carry the new loop id: ${JSON.stringify(respBody)}`).toMatch(/^[a-f0-9-]+$/);

  // Wait until the page has actually navigated to THIS loop.
  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 15_000 });

  // Once a loop is open the page has TWO <aside>s (nav sidebar + editor
  // complementary), so scope to the first — the loop list sidebar.
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByText(title)).toBeVisible({ timeout: 10_000 });

  // Brand-new loop — nothing has touched it, so no container yet.
  expect(runningContainers(loopId), `no container should exist before loop ${repo}'s terminal opens`).toEqual([]);
  return loopId;
}

/** Open the terminal panel (opens /ws/loop/:id/term → backend ensureContainer)
 *  and poll podman until this loop's sandbox container is RUNNING. */
async function startContainer(page: Page, loopId: string): Promise<void> {
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect
    .poll(() => runningContainers(loopId), {
      message: `expected a running podman container labelled loopat.loop-id=${loopId}`,
      timeout: 240_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // Bypass the "Setup Personal Repo" card for the (preconfigured) account.
  await page.addInitScript(() => {
    localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
  });
});

test("second loop reuses the first loop's content-addressed sandbox image (no rebuild)", async ({ page }) => {
  const { loopatHome, sshdPort } = meta();
  // roster2 is preconfigured as a bare repo in the fixture but not in the user's
  // roster yet; add it so the New Loop dialog offers it. (roster1 is already
  // there from setup.ts.) loadPersonalConfig reads fresh from disk (no cache),
  // so we append roster2 to the personal config.json on disk directly,
  // preserving the providers block and roster1.
  const roster2Url = `ssh://git@${hostIp()}:${sshdPort}/srv/git/roster2.git`;
  const personalCfgPath = join(loopatHome, "personal", testUserId(loopatHome), ".loopat", "config.json");
  const personalCfg = JSON.parse(readFileSync(personalCfgPath, "utf8"));
  if (!personalCfg.repos?.some((r: any) => r.name === "roster2")) {
    personalCfg.repos = [...(personalCfg.repos ?? []), { name: "roster2", git: roster2Url }];
    writeFileSync(personalCfgPath, JSON.stringify(personalCfg, null, 2) + "\n");
  }

  await page.goto("/loop");

  // ── Loop A: create from roster1, open terminal, wait until running. ──
  const titleA = `dogfood-warmA-${Date.now()}`;
  const loopA = await createLoop(page, "roster1", titleA);
  await startContainer(page, loopA);
  const imageA = loopContainerImageId(loopA);
  console.log(`[dogfood] loop A (${loopA.slice(0, 8)}) container image: ${imageA}`);

  // ── SNAPSHOT: every sandbox image that exists right now, BEFORE loop B. ──
  // If loop B is a true reuse, it must NOT add any new image — its container's
  // image must already be a member of this set.
  const imagesBeforeB = sandboxImageIds();
  expect(imagesBeforeB.has(imageA), "loop A's image must be in the local store").toBeTruthy();
  console.log(`[dogfood] sandbox images present before loop B: ${[...imagesBeforeB].join(", ")}`);

  // ── Loop B: create from roster2, open terminal, wait until running. ──
  const titleB = `dogfood-warmB-${Date.now()}`;
  const loopB = await createLoop(page, "roster2", titleB);
  await startContainer(page, loopB);
  const imageB = loopContainerImageId(loopB);
  console.log(`[dogfood] loop B (${loopB.slice(0, 8)}) container image: ${imageB}`);

  // ── INTEGRATION TRUTH (a): B's container runs an image that ALREADY existed
  //    before B started — B built no image of its own (REUSE, not rebuild). ──
  expect(
    imagesBeforeB.has(imageB),
    "loop B's container image must have existed BEFORE B started (no per-loop rebuild) — " +
      "if the workspace prefix crept back into the tag, B would build a fresh image and this fails",
  ).toBeTruthy();

  // ── INTEGRATION TRUTH (b): A and B run the SAME content-addressed image. ──
  expect(
    imageB,
    "loop B must share loop A's content-addressed sandbox image (the whole point of the fix)",
  ).toBe(imageA);

  console.log(`[dogfood] PROVEN reuse: loop B runs the same pre-existing image as loop A (${imageA})`);
});
