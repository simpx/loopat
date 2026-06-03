/**
 * dogfood/first-run — the REAL first-time-user cold-start journey.
 *
 * Unlike the other dogfood cases (which preset an ALREADY-ONBOARDED user +
 * storageState to skip login), this one boots a TRULY EMPTY LOOPAT_HOME and
 * drives the whole first-run flow through the browser: register -> login ->
 * onboarding gate -> personal-repo setup (git-crypt) -> seed the ssh pubkey onto
 * the "platform" -> context populates -> loop -> AI -> terminal.
 *
 * The active git-host provider is the FIXTURE provider
 * (first-run/fixtures/fixture-provider.ts), installed into
 * LOOPAT_HOME/extensions/providers/ by setup.ts. It mirrors the real internal
 * provider but operates the fixture sshd, with every endpoint/key from env.
 *
 * Preconditions are FAIL-not-skip: podman, git-crypt, ANTHROPIC_API_KEY, and the
 * AI base url env var (FIRST_RUN_AI_BASE_URL) must all be present.
 *
 * Ports + temp LOOPAT_HOME are decided here (config-load time) and recorded in
 * first-run/.test-meta.json; the fixture container + backend come up in setup.ts.
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

function requireCmd(cmd: string, hint: string): void {
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {
    throw new Error(`[dogfood:first-run] ${hint}`);
  }
}

function requireEnv(name: string, hint: string): void {
  if (!process.env[name] || !process.env[name]!.trim()) {
    throw new Error(`[dogfood:first-run] ${name} not set — ${hint}`);
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

function pickPorts(): { testServerPort: number; vitePort: number; sshdPort: number } {
  // 23001+ range — away from the other dogfood config (22001) and e2e (20001).
  for (let p = 23001; p < 24000; p += 3) {
    if (tryPort(p) && tryPort(p + 1) && tryPort(p + 2)) {
      return { testServerPort: p, vitePort: p + 1, sshdPort: p + 2 };
    }
  }
  throw new Error("no free port triple found in 23001-24000");
}

requireCmd("podman --version", "podman not found — this test runs a real sshd container and must not be skipped");
requireCmd("git-crypt --version", "git-crypt not found — first-run uses REAL git-crypt; install it");
requireEnv("ANTHROPIC_API_KEY", "export it before running (real AI needs a real key; we never read it from disk)");
requireEnv(
  "FIRST_RUN_AI_BASE_URL",
  "set the AI provider base url (the fixture provider seeds it as config.json baseUrl; never bake an internal endpoint into committed files)",
);

// Workers reload this config; only the main process picks ports + writes META.
const isWorker = process.env.TEST_WORKER_INDEX !== undefined;

let testServerPort = 0;
let vitePort = 0;
let sshdPort = 0;
let loopatHome = "";

if (isWorker) {
  const m = JSON.parse(readFileSync(META, "utf8"));
  ({ testServerPort, vitePort, sshdPort, loopatHome } = m);
} else {
  ({ testServerPort, vitePort, sshdPort } = pickPorts());
  // basename -> server WORKSPACE -> podman image tag; lowercase only.
  const raw = mkdtempSync(join(tmpdir(), "loopat-firstrun-"));
  const lower = join(tmpdir(), basename(raw).toLowerCase());
  if (lower !== raw) renameSync(raw, lower);
  loopatHome = lower;
  writeFileSync(META, JSON.stringify({ loopatHome, testServerPort, vitePort, sshdPort }));
}

export default defineConfig({
  testDir: import.meta.dirname,
  timeout: 420_000,
  retries: 0,
  workers: 1,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // NO storageState — this case does its OWN register + login through the UI.
  },
  webServer: {
    command:
      `env ENV=test HOST=127.0.0.1 PORT=${testServerPort} bun --cwd=${join(import.meta.dirname, "..", "..", "web")} run dev -- --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: false,
  },
});
