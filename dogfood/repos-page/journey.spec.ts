/**
 * repos-page — managing the personal repo roster through the real UI.
 *
 * This regresses the "repos-are-personal" redesign: the roster no longer lives
 * in the knowledge repo, it lives in personal/<user>/.loopat/config.json and is
 * read/written via GET/PUT /api/context/repos. The classic bug here is the page
 * showing empty (roster read from the wrong place) or a Save that doesn't
 * persist (PUT clobbering the rest of personal config, or writing nowhere).
 *
 * Flow (no AI tokens spent — this case never sends a chat turn):
 *   1. Arrive logged in via storageState → /context/repos. The preconfigured
 *      `roster1` entry (seeded in setup.ts) must already be listed.
 *   2. Add a new entry (`roster2`, pointing at the second fixture bare repo)
 *      through the real UI (+ add repo → fill name + git url → Save).
 *   3. Reload the page and assert the new entry PERSISTS in the UI.
 *   4. INTEGRATION TRUTH: read personal/<user>/.loopat/config.json off the test
 *      LOOPAT_HOME on disk and assert both roster1 AND roster2 are present, and
 *      that the unrelated `providers` block survived the PUT (no clobber).
 *
 * The harness (dogfood/playwright.config.ts + setup.ts) already booted the real
 * stack and preconfigured the `test` user as ALREADY ONBOARDED with one roster
 * repo `roster1` and a `roster2` bare repo waiting in the fixture.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Meta = {
  loopatHome: string;
  sshdPort: number;
};

function meta(): Meta {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", ".test-meta.json"), "utf8"),
  ) as Meta;
}

/** The host default-route IP — same address setup.ts used for the fixture git
 *  urls, so the url we type in the UI matches what the loop would clone. */
function hostIp(): string {
  const ip = execFileSync("ip", ["route", "get", "1.1.1.1"])
    .toString()
    .match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) throw new Error("could not determine host default-route IP");
  return ip;
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

/** The user's personal config.json on disk — the integration source of truth. */
function readPersonalConfig(loopatHome: string): any {
  const p = join(
    loopatHome,
    "personal",
    testUserId(loopatHome),
    ".loopat",
    "config.json",
  );
  return JSON.parse(readFileSync(p, "utf8"));
}

test("repos-page: add a roster entry via the UI → persists across reload + on disk", async ({ page }) => {
  const { loopatHome, sshdPort } = meta();
  const roster2Url = `ssh://git@${hostIp()}:${sshdPort}/srv/git/roster2.git`;

  // ── Step 1: land on /context/repos, logged in. roster1 is preconfigured. ──
  await page.goto("/context/repos");

  // The "Repo roster" heading proves we're on the right pane (not e.g. the
  // knowledge file tree).
  await expect(page.getByRole("heading", { name: "Repo roster" })).toBeVisible({
    timeout: 15_000,
  });

  // The preconfigured roster1 entry must already be listed — its name input
  // carries the value "roster1".
  const nameInputs = page.locator('input[placeholder="name"]');
  await expect
    .poll(async () => nameInputs.evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value)), {
      message: "the preconfigured roster1 entry should be listed on load",
      timeout: 15_000,
    })
    .toContain("roster1");

  // ── Step 2: add roster2 through the UI. ──
  const beforeCount = await nameInputs.count();
  await page.getByRole("button", { name: "+ add repo" }).click();
  await expect(nameInputs).toHaveCount(beforeCount + 1);

  // Fill the newly added (last) row.
  await nameInputs.last().fill("roster2");
  await page.locator('input[placeholder="git@…/repo.git"]').last().fill(roster2Url);

  // Capture the real PUT so we know the save hit the personal-config API.
  const putReq = page.waitForRequest(
    (req) => req.url().includes("/api/context/repos") && req.method() === "PUT",
    { timeout: 15_000 },
  );
  const saveBtn = page.getByRole("button", { name: /^Save$/ });
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  const sent = (await putReq).postDataJSON();
  expect(sent.repos.map((r: any) => r.name)).toEqual(
    expect.arrayContaining(["roster1", "roster2"]),
  );

  // The UI confirms the save.
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });

  // ── Step 3: reload — the new entry must still be there (read back from the
  //            personal config via GET, not from any in-memory state). ──
  await page.reload();
  await expect(page.getByRole("heading", { name: "Repo roster" })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(async () => nameInputs.evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value)), {
      message: "roster2 must persist across a reload (read from personal config)",
      timeout: 15_000,
    })
    .toEqual(expect.arrayContaining(["roster1", "roster2"]));

  // The roster2 row carries the git url we typed.
  const gitInputs = page.locator('input[placeholder="git@…/repo.git"]');
  const urls = await gitInputs.evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
  expect(urls).toContain(roster2Url);

  // ── Step 4: INTEGRATION TRUTH — the personal config.json on disk. ──
  const cfg = readPersonalConfig(loopatHome);
  const names = (cfg.repos ?? []).map((r: any) => r.name);
  expect(names, "roster1 + roster2 must both be in personal config.json on disk").toEqual(
    expect.arrayContaining(["roster1", "roster2"]),
  );
  const r2 = (cfg.repos ?? []).find((r: any) => r.name === "roster2");
  expect(r2?.git, "roster2's git url must be persisted on disk").toBe(roster2Url);

  // The PUT must NOT have clobbered the rest of personal config — the idealab
  // provider preconfigured in setup.ts must still be there (regresses a
  // whole-file-overwrite bug in the personal-config save path).
  expect(
    cfg.providers?.idealab,
    "the PUT must preserve the unrelated providers block (no whole-file clobber)",
  ).toBeTruthy();

  console.log(`[dogfood] personal config.json repos on disk: ${JSON.stringify(cfg.repos)}`);
});
