/** Shared browser-driven helpers for the journeys suite — create a loop through
 *  the UI, boot its sandbox, send a chat turn, and read sandbox truth. */
import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

export function runningContainers(loopId: string): string[] {
  return execFileSync("podman", ["ps", "--filter", `label=loopat.loop-id=${loopId}`, "--filter", "status=running", "--format", "{{.Names}}"])
    .toString().split("\n").map((s) => s.trim()).filter(Boolean);
}
export function sandboxContainer(loopId: string): string {
  const n = runningContainers(loopId);
  if (n.length !== 1) throw new Error(`expected one container for ${loopId}, got ${n.join(",")}`);
  return n[0];
}
export function sandboxExec(loopId: string, cmd: string): string {
  return execFileSync("podman", ["exec", sandboxContainer(loopId), "sh", "-lc", cmd]).toString();
}
export function cleanupLoop(loopId: string): void {
  if (!loopId) return;
  try {
    const ids = execFileSync("podman", ["ps", "-a", "--filter", `label=loopat.loop-id=${loopId}`, "--format", "{{.ID}}"]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) execFileSync("podman", ["rm", "-f", ...ids]);
  } catch { /* best-effort */ }
}

/** Create a loop on roster1 via the UI, return its raw uuid. */
export async function createLoop(page: Page, title: string, opts?: { freshness?: "Latest" | "Cached" }): Promise<string> {
  await page.goto("/loop");
  await expect(page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first()).toBeVisible({ timeout: 15_000 });
  const createResp = page.waitForResponse((r) => r.url().includes("/api/v1/loops") && r.request().method() === "POST", { timeout: 15_000 });
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(title);
  if (opts?.freshness) await page.getByText(opts.freshness, { exact: true }).click();
  await page.getByRole("button", { name: "create", exact: true }).click();
  const id = String((await (await createResp).json()).id ?? "").replace(/^loop_/, "");
  expect(id).toMatch(/^[a-f0-9-]+$/);
  await expect(page).toHaveURL(new RegExp(`/loop/${id}`), { timeout: 15_000 });
  return id;
}

/** Open the terminal so the backend boots the sandbox; wait until ready. */
export async function bootSandbox(page: Page, loopId: string): Promise<void> {
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect.poll(() => runningContainers(loopId), { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).not.toEqual([]);
  await expect(page.getByText("Preparing this loop’s sandbox…")).toBeHidden({ timeout: 240_000 });
}

/** Send a chat message and wait for a non-empty, non-error assistant reply. */
export async function sendAndAwaitReply(page: Page, text: string, waitFor?: RegExp): Promise<string> {
  const a = page.locator('[data-role="assistant"]');
  const before = await a.count(); // only look at messages from THIS turn
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  // A tool-using turn renders tool cards as assistant messages BEFORE the final
  // text — "last non-empty" would return a Bash card. Aggregate every message
  // of this turn and poll until the expected pattern (or any text) shows up.
  const joined = async () => {
    const n = await a.count();
    const parts: string[] = [];
    for (let i = before; i < n; i++) parts.push((await a.nth(i).innerText()).trim());
    return parts.filter(Boolean).join("\n");
  };
  await expect.poll(joined, { timeout: 180_000, intervals: [2_000, 3_000, 5_000] })
    .toMatch(waitFor ?? /\S/);
  const all = await joined();
  expect(all, "no error event").not.toContain("⚠️");
  return all;
}

// ── fixture origin (the sshd container's bare repos) ──────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The fixture sshd container id, recorded by setup.ts in .test-meta.json. */
export function fixtureContainer(): string {
  const meta = JSON.parse(readFileSync(join(import.meta.dirname, ".test-meta.json"), "utf8"));
  if (!meta.fixtureContainer) throw new Error("fixtureContainer missing from .test-meta.json");
  return meta.fixtureContainer as string;
}

/** Run a git command against a fixture bare repo (origin TRUTH). Root exec on
 *  a git-owned repo → waive "dubious ownership" with safe.directory=*. */
export function originGit(repo: string, ...args: string[]): string {
  return execFileSync("podman", ["exec", fixtureContainer(), "git", "-c", "safe.directory=*", "-C", `/srv/git/${repo}.git`, ...args]).toString().trim();
}

/** Push one file to the fixture notes origin from INSIDE the fixture container
 *  (a second writer that isn't any loop) — used to advance origin externally. */
export function originAdvanceNotes(file: string, content: string, msg: string): void {
  const sh = `set -e; rm -rf /tmp/adv && git clone -q /srv/git/notes.git /tmp/adv && cd /tmp/adv && echo '${content}' > ${file} && git add . && git -c user.email=t@t -c user.name=t commit -qm '${msg}' && git push -q origin HEAD`;
  execFileSync("podman", ["exec", fixtureContainer(), "su", "git", "-c", sh]);
}
