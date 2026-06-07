/**
 * subagent-model — regression for: a single-model provider (idealab serves only
 * opus-4-6) makes built-in subagents fail "model not available", because CC's
 * Explore/Task agents default to the haiku tier the gateway doesn't serve.
 *
 * The setup preconfigures the anthropic provider with agent_model +
 * sonnet/haiku_model = claude-opus-4-7. Those must pass through as
 * CLAUDE_CODE_SUBAGENT_MODEL + ANTHROPIC_DEFAULT_*_MODEL so EVERY model the loop
 * touches is opus-4-7. We then force an Explore subagent and assert the
 * INTEGRATION TRUTH (the loop's messages.jsonl): Explore actually ran, no turn
 * errored, and NOTHING used the haiku tier. Drop the env passthrough and the
 * subagent reverts to claude-haiku-4-5 → the haiku assertion fails (and against
 * a single-model gateway it would 400 outright). Fixed → all opus-4-7.
 *
 * Shared-fixture stack, ALREADY ONBOARDED, arrive logged in via storageState.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const META = join(import.meta.dirname, "..", ".test-meta.json");
const { loopatHome } = JSON.parse(readFileSync(META, "utf8")) as { loopatHome: string };
// Same source of truth as setup.ts: the one model this provider serves.
const MODEL = process.env.LOOPAT_TEST_MODEL || "claude-opus-4-7";

function runningContainers(loopId: string): string[] {
  return execFileSync("podman", [
    "ps", "--filter", `label=loopat.loop-id=${loopId}`,
    "--filter", "status=running", "--format", "{{.Names}}",
  ]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
}

function cleanupLoopContainer(loopId: string): void {
  if (!loopId) return;
  try {
    const ids = execFileSync("podman", [
      "ps", "-a", "--filter", `label=loopat.loop-id=${loopId}`, "--format", "{{.ID}}",
    ]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) execFileSync("podman", ["rm", "-f", ...ids]);
  } catch { /* best-effort */ }
}

/** Every model id mentioned in the loop's full transcript (main + subagents). */
function modelsUsed(loopId: string): string[] {
  const raw = readFileSync(join(loopatHome, "loops", loopId, "messages.jsonl"), "utf8");
  return [...raw.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]);
}

let createdLoopId = "";
test.beforeEach(async ({ page }) => {
  createdLoopId = "";
  await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1"));
});
test.afterEach(() => cleanupLoopContainer(createdLoopId));

test("Explore subagent runs on the configured agent_model, never the default haiku tier", async ({ page }) => {
  await page.goto("/loop");
  await expect(page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first()).toBeVisible({ timeout: 15_000 });

  const loopTitle = `dogfood-sub-${Date.now()}`;
  const createResp = page.waitForResponse(
    (r) => r.url().includes("/api/v1/loops") && r.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(loopTitle);
  await page.getByRole("button", { name: "create", exact: true }).click();

  const resp = await createResp;
  const loopId = String((await resp.json()).id ?? "").replace(/^loop_/, "");
  expect(loopId).toMatch(/^[a-f0-9-]+$/);
  createdLoopId = loopId;
  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 15_000 });

  // Boot the sandbox.
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect.poll(() => runningContainers(loopId), { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).not.toEqual([]);
  await expect(page.getByText("Preparing this loop’s sandbox…")).toBeHidden({ timeout: 240_000 });

  // Force an Explore subagent.
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await composer.fill("Use the Explore subagent (Task tool, subagent_type Explore) to list the top-level files in the workdir. Report what it returned.");
  await page.getByRole("button", { name: "Send message" }).click();

  const assistant = page.locator('[data-role="assistant"]');
  await expect.poll(async () => {
    const n = await assistant.count();
    for (let i = 0; i < n; i++) if ((await assistant.nth(i).innerText()).trim()) return "ok";
    return "";
  }, { timeout: 180_000, intervals: [2_000, 3_000, 5_000] }).toBe("ok");
  expect((await assistant.allInnerTexts()).join("\n"), "no error event in transcript").not.toContain("⚠️");

  // ── INTEGRATION TRUTH: the loop's transcript. Explore must have run, and every
  //    model touched must be opus-4-7 — no built-in haiku tier leaked through. ──
  await expect.poll(() => readFileSync(join(loopatHome, "loops", loopId, "messages.jsonl"), "utf8"),
    { timeout: 60_000, intervals: [1_000, 2_000, 3_000] }).toContain('"Explore"');

  const transcript = readFileSync(join(loopatHome, "loops", loopId, "messages.jsonl"), "utf8");
  // The subagent must have SUCCEEDED. Without the per-tier passthrough Explore
  // requests the default haiku tier the gateway lacks → "model not available" /
  // 模型不存在 / 400 in the transcript. That is the bug; assert it's absent.
  expect(transcript, "subagent must not hit a model-not-available error").not.toMatch(/model not available|模型不存在|API Error: 400/i);
  // Ignore non-model markers like "<synthetic>"; pin only the real model tiers.
  const models = [...new Set(modelsUsed(loopId))].filter((m) => m.startsWith("claude-"));
  console.log(`[dogfood] models used: ${models.join(", ")}`);
  expect(models, `${MODEL} must appear (main + subagent)`).toContain(MODEL);
  expect(models.some((m) => /haiku/i.test(m)), "no haiku tier — agent_model must override").toBe(false);
  console.log(`[dogfood] PROVEN: Explore subagent ran on agent_model ${MODEL}, no haiku fallback`);
});
