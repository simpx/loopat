/**
 * journeys — extra browser+AI end-to-end scenarios on the shared-fixture stack.
 * Real backend + podman sandbox + Vite + real AI, driven through a real browser.
 * Defaults to official opus-4-7; point at idealab opus-4-6 to run on that key:
 *   LOOPAT_TEST_BASEURL=https://idealab.alibaba-inc.com/api/anthropic \
 *   LOOPAT_TEST_MODEL=claude-opus-4-6 ANTHROPIC_API_KEY=<key> bun run dogfood:journeys
 * Own META/ports so it never collides with the main suite. Serial, no retries.
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

const META = join(import.meta.dirname, "..", ".test-meta.json");
function requirePodman(): void { try { execFileSync("podman", ["--version"], { stdio: "ignore" }); } catch { throw new Error("[dogfood] podman not found"); } }
function requireKey(): void { if (!process.env.ANTHROPIC_API_KEY) throw new Error("[dogfood] ANTHROPIC_API_KEY not set"); }
function tryPort(p: number): boolean { try { const s = createServer(); s.listen(p, "127.0.0.1"); s.close(); return true; } catch { return false; } }
function pickPorts() { for (let p = 24001; p < 25000; p += 3) if (tryPort(p) && tryPort(p + 1) && tryPort(p + 2)) return { testServerPort: p, vitePort: p + 1, sshdPort: p + 2 }; throw new Error("no free ports 24001-25000"); }

requirePodman(); requireKey();
const isWorker = process.env.TEST_WORKER_INDEX !== undefined;
let testServerPort = 0, vitePort = 0, sshdPort = 0, loopatHome = "";
if (isWorker) ({ testServerPort, vitePort, sshdPort, loopatHome } = JSON.parse(readFileSync(META, "utf8")));
else {
  ({ testServerPort, vitePort, sshdPort } = pickPorts());
  const raw = mkdtempSync(join(tmpdir(), "loopat-dogfood-"));
  const lower = join(tmpdir(), basename(raw).toLowerCase());
  if (lower !== raw) renameSync(raw, lower);
  loopatHome = lower;
  writeFileSync(META, JSON.stringify({ loopatHome, testServerPort, vitePort, sshdPort }));
}

export default defineConfig({
  testDir: import.meta.dirname,
  timeout: 300_000, retries: 0, workers: 1,
  globalSetup: "../setup.ts", globalTeardown: "../teardown.ts",
  use: { baseURL: `http://127.0.0.1:${vitePort}`, trace: "on-first-retry", screenshot: "only-on-failure", storageState: join(import.meta.dirname, "..", ".auth.json") },
  webServer: { command: `env ENV=test HOST=127.0.0.1 PORT=${testServerPort} bun --cwd=${join(import.meta.dirname, "..", "..", "web")} run dev -- --port ${vitePort}`, port: vitePort, reuseExistingServer: false },
});
