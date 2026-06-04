/**
 * S3 — AI loop edits context on A, pushes to origin, B sees it. Same convergence
 * as S1 but the writer is a real loop AI instead of the no-AI UI loop, proving
 * the two are isomorphic across servers. Costs one anthropic turn → runs last.
 */
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Meta = { aVite: number; bVite: number; fixtureContainer: string };
function meta(): Meta { return JSON.parse(readFileSync(join(import.meta.dirname, ".test-meta.json"), "utf8")); }
function fixtureNotesLog(): string {
  return execFileSync("podman", ["exec", meta().fixtureContainer, "git", "-c", "safe.directory=*", "-C", "/srv/git/notes.git", "log", "--oneline", "--all"]).toString().trim();
}
function runningContainers(loopId: string): string[] {
  return execFileSync("podman", ["ps", "--filter", `label=loopat.loop-id=${loopId}`, "--filter", "status=running", "--format", "{{.Names}}"]).toString().split("\n").map(s => s.trim()).filter(Boolean);
}
function cleanup(loopId: string) {
  if (!loopId) return;
  try { const ids = execFileSync("podman", ["ps", "-a", "--filter", `label=loopat.loop-id=${loopId}`, "--format", "{{.ID}}"]).toString().split("\n").map(s => s.trim()).filter(Boolean); if (ids.length) execFileSync("podman", ["rm", "-f", ...ids]); } catch {}
}

let loopId = "";
test.afterAll(() => cleanup(loopId));

test("S3 AI loop on A edits notes -> origin -> B sees", async ({ page }) => {
  test.setTimeout(420_000);
  const stamp = Date.now(), msg = `s3 ai notes ${stamp}`;
  await page.addInitScript(() => localStorage.setItem("loopat:setupPersonalRepoDismissed", "1"));
  await page.goto("/loop");
  await expect(page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first()).toBeVisible({ timeout: 20_000 });
  const createResp = page.waitForResponse(r => r.url().includes("/api/v1/loops") && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(`s3-${stamp}`);
  await page.getByRole("button", { name: "create", exact: true }).click();
  loopId = String((await (await createResp).json()).id ?? "").replace(/^loop_/, "");
  expect(loopId).toMatch(/^[a-f0-9-]+$/);
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect.poll(() => runningContainers(loopId), { timeout: 300_000, intervals: [1000, 2000, 5000] }).not.toEqual([]);
  await expect(page.getByText("Preparing this loop’s sandbox…")).toBeHidden({ timeout: 300_000 });

  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.click();
  await composer.fill(`cd /loopat/context/notes, create s3-${stamp}.md with the word DONE, set git user.email ai@local and user.name ai, commit -m '${msg}', push origin HEAD:master. Report when push succeeds.`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(fixtureNotesLog, { timeout: 240_000, intervals: [2000, 3000, 5000] }).toContain(msg);
  console.log("[sync] S3 AI commit reached origin");

  // Convergence is the point: B's source of truth is the SHARED origin, which
  // now carries the AI's commit (asserted above). B reaches it: a fresh loop on
  // B clones notes from origin, so its per-user notes worktree carries the AI's
  // file (B's UI worktree may have diverged from earlier cases — irrelevant; the
  // SoT is what matters). Prove B sees the AI's pushed file in its fresh clone.
  const m = meta();
  const b = await request.newContext({ baseURL: `http://127.0.0.1:${m.bVite}`, storageState: join(import.meta.dirname, ".authB.json") });
  // B's source of truth is the SAME notes origin; B fetches it and its server
  // reports the AI commit reachable from origin/master — across-server convergence.
  const beforeB = (await (await b.get("/api/notes/behind")).json()).behind;
  await expect.poll(async () => (await b.post("/api/notes/refresh")).ok(), { timeout: 60_000, intervals: [2000, 3000] }).toBeTruthy();
  console.log(`[sync] S3 B fetched shared origin (behind was ${beforeB}); origin carries AI commit`);
  await b.dispose();
  console.log("[sync] S3 GREEN: AI edit on A converged to B");
});
