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
export async function createLoop(page: Page, title: string): Promise<string> {
  await page.goto("/loop");
  await expect(page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first()).toBeVisible({ timeout: 15_000 });
  const createResp = page.waitForResponse((r) => r.url().includes("/api/v1/loops") && r.request().method() === "POST", { timeout: 15_000 });
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(title);
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
export async function sendAndAwaitReply(page: Page, text: string): Promise<string> {
  const a = page.locator('[data-role="assistant"]');
  const before = await a.count(); // wait for a NEW assistant msg, not a stale one
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(async () => {
    const n = await a.count();
    if (n <= before) return "";
    return (await a.nth(n - 1).innerText()).trim() ? "ok" : "";
  }, { timeout: 180_000, intervals: [2_000, 3_000, 5_000] }).toBe("ok");
  const last = (await a.last().innerText()).trim();
  expect(last, "no error event").not.toContain("⚠️");
  return last;
}
