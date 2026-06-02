/**
 * dogfood/first-5-minutes — highest-fidelity e2e config.
 *
 * Unlike e2e/ (logic, mocked), this boots a REAL stack: a podman sshd+git
 * fixture container, an isolated backend with its own LOOPAT_HOME preconfigured
 * as ALREADY ONBOARDED (idealab provider + the dev vault's ssh key), and Vite.
 * The spec (Task 3) drives a real browser -> real container -> real AI -> real
 * git push into the fixture origin. podman / IDEALAB_API_KEY missing -> FAIL,
 * never skip (a dogfood test that goes green without running proves nothing).
 *
 * Ports are decided here at config-load time and recorded in
 * dogfood/.test-meta.json; the fixture container + backend are brought up in
 * setup.ts (Playwright loads this config twice — discovery + runner — so the
 * fixture must NOT be started here or the second load collides on the port).
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

// ── fail-not-skip preconditions ──
function requirePodman(): void {
  try {
    execSync("podman --version", { stdio: "ignore" });
  } catch {
    throw new Error("[dogfood] podman not found — this test runs a real sshd container and must not be skipped");
  }
}

// The dev vault we copy the real ssh key + idealab key from. The whole point of
// dogfood is "already onboarded": we lift the operator's working credentials.
const DEV_VAULT = join(
  process.env.HOME ?? "",
  ".loopat/personal/simpx/.loopat/vaults/default",
);
function requireDevVault(): void {
  const key = join(DEV_VAULT, "mounts/home/.ssh/id_ed25519");
  const idealab = join(DEV_VAULT, "envs/IDEALAB_API_KEY");
  if (!existsSync(key)) throw new Error(`[dogfood] dev vault ssh key missing: ${key}`);
  if (!existsSync(idealab)) throw new Error(`[dogfood] dev vault IDEALAB_API_KEY missing: ${idealab}`);
}

// ── pick free ports (sshd publish + backend + vite) ──
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
  // 22001+ range, away from e2e (20001) and common dev ports.
  for (let p = 22001; p < 23000; p += 3) {
    if (tryPort(p) && tryPort(p + 1) && tryPort(p + 2)) {
      return { testServerPort: p, vitePort: p + 1, sshdPort: p + 2 };
    }
  }
  throw new Error("no free port triple found in 22001–23000");
}

requirePodman();
requireDevVault();

// Playwright loads this config in BOTH the main process AND each worker process.
// Only the main process runs globalSetup/globalTeardown, so only it may pick
// ports + write META — otherwise a worker's reload would overwrite META with a
// fresh mkdtemp/port pick AFTER setup ran, and teardown would reap the wrong
// (never-started) resources, leaking the real fixture + LOOPAT_HOME. Workers
// carry TEST_WORKER_INDEX; the main process does not.
const isWorker = process.env.TEST_WORKER_INDEX !== undefined;

let testServerPort = 0;
let vitePort = 0;
let sshdPort = 0;
let loopatHome = "";

if (isWorker) {
  // Read the values the main process already committed.
  const m = JSON.parse(readFileSync(META, "utf8"));
  ({ testServerPort, vitePort, sshdPort, loopatHome } = m);
} else {
  ({ testServerPort, vitePort, sshdPort } = pickPorts());
  loopatHome = mkdtempSync(join(tmpdir(), "loopat-dogfood-"));
  // Fixture (image build + container run) is started in setup.ts, which records
  // the container id back into this meta file. Teardown reads it from there.
  writeFileSync(
    META,
    JSON.stringify({
      loopatHome,
      testServerPort,
      vitePort,
      sshdPort,
      devVault: DEV_VAULT,
    }),
  );
}

export default defineConfig({
  testDir: join(import.meta.dirname, "first-5-minutes"),
  // Real AI + real container — generous timeout, no retries (each run costs
  // money and is non-deterministic).
  timeout: 300_000,
  retries: 0,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    storageState: join(import.meta.dirname, ".auth.json"),
  },
  webServer: {
    command:
      `env ENV=test HOST=127.0.0.1 PORT=${testServerPort} bun --cwd=${join(import.meta.dirname, "..", "web")} run dev -- --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: false,
  },
});
