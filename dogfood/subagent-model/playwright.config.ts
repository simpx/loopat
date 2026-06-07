/**
 * subagent-model — dedicated suite that boots the shared-fixture stack against a
 * SINGLE-MODEL gateway, so the regression reproduces locally end-to-end. Default
 * dogfood uses official api.anthropic.com (all tiers exist), where the bug only
 * shows as the subagent using the wrong tier; here the gateway serves ONE model,
 * so a missing per-tier passthrough makes Explore 404 "model not available".
 *
 * Point it at idealab opus-4-6 with the idealab key:
 *   LOOPAT_TEST_BASEURL=https://idealab.alibaba-inc.com/api/anthropic \
 *   LOOPAT_TEST_MODEL=claude-opus-4-6 \
 *   ANTHROPIC_API_KEY=<idealab-key> \
 *   bun run dogfood:subagent
 * Without the env it falls back to official opus-4-7 and still asserts no haiku.
 *
 * Own META file + own setup/teardown so it never collides with the main suite.
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

const META = join(import.meta.dirname, "..", ".test-meta.json");

function requirePodman(): void {
  try { execFileSync("podman", ["--version"], { stdio: "ignore" }); }
  catch { throw new Error("[dogfood] podman not found — single-model regression must not skip"); }
}
function requireKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("[dogfood] ANTHROPIC_API_KEY not set");
}
function tryPort(port: number): boolean {
  try { const s = createServer(); s.listen(port, "127.0.0.1"); s.close(); return true; } catch { return false; }
}
function pickPorts() {
  for (let p = 23001; p < 24000; p += 3) if (tryPort(p) && tryPort(p + 1) && tryPort(p + 2)) return { testServerPort: p, vitePort: p + 1, sshdPort: p + 2 };
  throw new Error("no free port triple in 23001–24000");
}

requirePodman();
requireKey();

const isWorker = process.env.TEST_WORKER_INDEX !== undefined;
let testServerPort = 0, vitePort = 0, sshdPort = 0, loopatHome = "";
if (isWorker) {
  ({ testServerPort, vitePort, sshdPort, loopatHome } = JSON.parse(readFileSync(META, "utf8")));
} else {
  ({ testServerPort, vitePort, sshdPort } = pickPorts());
  const raw = mkdtempSync(join(tmpdir(), "loopat-dogfood-"));
  const lower = join(tmpdir(), basename(raw).toLowerCase());
  if (lower !== raw) renameSync(raw, lower);
  loopatHome = lower;
  writeFileSync(META, JSON.stringify({ loopatHome, testServerPort, vitePort, sshdPort }));
}

export default defineConfig({
  testDir: import.meta.dirname,
  timeout: 300_000,
  retries: 0,
  workers: 1,
  globalSetup: "../setup.ts",
  globalTeardown: "../teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    storageState: join(import.meta.dirname, "..", ".auth.json"),
  },
  webServer: {
    command: `env ENV=test HOST=127.0.0.1 PORT=${testServerPort} bun --cwd=${join(import.meta.dirname, "..", "..", "web")} run dev -- --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: false,
  },
});
