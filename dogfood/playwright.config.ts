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
import { mkdtempSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
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

// The fixture is fully self-contained: the ssh keypair is generated fresh in
// setup.ts, never lifted from any real vault (a real key sitting in the repo /
// on github reads as "leaked credential"). The ONE thing a fixture can't fake
// is a real provider key for real AI — it comes from the environment, never
// from disk, never committed. Missing -> fail (a green dogfood run that didn't
// actually call AI proves nothing).
function requireIdealabKey(): void {
  if (!process.env.IDEALAB_API_KEY) {
    throw new Error("[dogfood] IDEALAB_API_KEY not set — export it before running (real AI needs a real key; we never read it from disk)");
  }
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
requireIdealabKey();

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
  // The basename becomes the server's WORKSPACE, which is baked into podman
  // image tags (loopat-sandbox-<workspace>-…). podman rejects uppercase in
  // image names, and mkdtemp's XXXXXX suffix is mixed-case — so mkdtemp into a
  // lowercase-prefixed dir and lowercase the whole basename.
  const raw = mkdtempSync(join(tmpdir(), "loopat-dogfood-"));
  const lower = join(tmpdir(), basename(raw).toLowerCase());
  if (lower !== raw) renameSync(raw, lower);
  loopatHome = lower;
  // Fixture (image build + container run) is started in setup.ts, which records
  // the container id back into this meta file. Teardown reads it from there.
  writeFileSync(
    META,
    JSON.stringify({
      loopatHome,
      testServerPort,
      vitePort,
      sshdPort,
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
