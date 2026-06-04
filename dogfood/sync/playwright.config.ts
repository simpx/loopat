/**
 * dogfood/sync — context flow across TWO independent loopat servers.
 *
 * Unlike every other dogfood tier (one server, one LOOPAT_HOME), this boots a
 * pair of fully independent loopat installs — server A and server B, each with
 * its own LOOPAT_HOME, backend, and vite — that share ONE fixture sshd as the
 * common git origin. Each side registers its own user, builds its own
 * self-contained vault (fresh ed25519 + ANTHROPIC_API_KEY from env), and both
 * pubkeys go into the fixture's authorized_keys. The cases drive A, push to
 * origin, and prove the change converges on B — context flow in the flesh.
 *
 * Five host ports: A_back A_vite B_back B_vite sshd (24001+, away from the
 * other tiers: e2e 20001, smoke 22001, first-run 23001). TWO temp LOOPAT_HOMEs.
 * podman / ANTHROPIC_API_KEY / FIRST_RUN_AI_BASE_URL missing -> FAIL, never skip.
 *
 * Ports + dirs are decided here at config-load time and recorded in
 * sync/.test-meta.json; the fixture container + both backends come up in
 * setup.ts (Playwright loads this config twice — discovery + runner — so the
 * fixture must NOT start here or the second load collides on the port). workers:1
 * — the two servers share one fixture origin; cases run serially.
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

function requireCmd(cmd: string, args: string[], hint: string): void {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    throw new Error(`[dogfood:sync] ${hint}`);
  }
}

function requireEnv(name: string, hint: string): void {
  if (!process.env[name] || !process.env[name]!.trim()) {
    throw new Error(`[dogfood:sync] ${name} not set — ${hint}`);
  }
}

function tryPort(port: number): boolean {
  try {
    const s = createServer();
    s.listen(port, "127.0.0.1");
    s.close();
    return true;
  } catch {
    return false;
  }
}

function pickPorts(): { aBack: number; aVite: number; bBack: number; bVite: number; sshdPort: number } {
  // 24001+ range — away from e2e (20001), smoke (22001), first-run (23001).
  for (let p = 24001; p < 25000; p += 5) {
    if (tryPort(p) && tryPort(p + 1) && tryPort(p + 2) && tryPort(p + 3) && tryPort(p + 4)) {
      return { aBack: p, aVite: p + 1, bBack: p + 2, bVite: p + 3, sshdPort: p + 4 };
    }
  }
  throw new Error("no free port quintuple found in 24001-25000");
}

requireCmd("podman", ["--version"], "podman not found — this test runs a real sshd container and must not be skipped");
requireEnv("ANTHROPIC_API_KEY", "export it before running (real AI needs a real key; we never read it from disk)");
requireEnv(
  "FIRST_RUN_AI_BASE_URL",
  "set the AI provider base url (seeded into each server's personal config; never bake an internal endpoint into committed files)",
);

const isWorker = process.env.TEST_WORKER_INDEX !== undefined;

let aBack = 0, aVite = 0, bBack = 0, bVite = 0, sshdPort = 0;
let homeA = "", homeB = "";

function mkLower(prefix: string): string {
  // podman rejects uppercase in image tags (loopat-sandbox-<basename>); mkdtemp
  // suffix is mixed-case → lowercase the basename.
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const lower = join(tmpdir(), basename(raw).toLowerCase());
  if (lower !== raw) renameSync(raw, lower);
  return lower;
}

if (isWorker) {
  const m = JSON.parse(readFileSync(META, "utf8"));
  ({ aBack, aVite, bBack, bVite, sshdPort, homeA, homeB } = m);
} else {
  ({ aBack, aVite, bBack, bVite, sshdPort } = pickPorts());
  homeA = mkLower("loopat-sync-a-");
  homeB = mkLower("loopat-sync-b-");
  writeFileSync(META, JSON.stringify({ homeA, homeB, aBack, aVite, bBack, bVite, sshdPort }));
}

export default defineConfig({
  testDir: import.meta.dirname,
  timeout: 420_000,
  retries: 0,
  workers: 1,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${aVite}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    storageState: join(import.meta.dirname, ".authA.json"),
  },
  // BOTH vites are started by playwright; A is the default baseURL, B is hit by
  // absolute url. reuseExistingServer:false so a stale vite never masks a port.
  webServer: [
    {
      command: `env ENV=test HOST=127.0.0.1 PORT=${aBack} bun --cwd=${join(import.meta.dirname, "..", "..", "web")} run dev -- --port ${aVite}`,
      port: aVite,
      reuseExistingServer: false,
    },
    {
      command: `env ENV=test HOST=127.0.0.1 PORT=${bBack} bun --cwd=${join(import.meta.dirname, "..", "..", "web")} run dev -- --port ${bVite}`,
      port: bVite,
      reuseExistingServer: false,
    },
  ],
});
