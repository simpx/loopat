import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

// ── pick free ports (far from dev defaults 5173/7787) ──
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

function pickPorts(): { testServerPort: number; vitePort: number } {
  // Start scanning from a range well away from common dev ports.
  for (let p = 20001; p < 21000; p += 2) {
    if (tryPort(p) && tryPort(p + 1)) {
      return { testServerPort: p, vitePort: p + 1 };
    }
  }
  throw new Error("no free port pair found in 20001–21000");
}

const { testServerPort, vitePort } = pickPorts();

// Temp dir for test LOOPAT_HOME — isolated from dev ~/.loopat.
const loopatHome = mkdtempSync(join(tmpdir(), "loopat-e2e-"));

writeFileSync(
  join(import.meta.dirname, "e2e/.test-meta.json"),
  JSON.stringify({ loopatHome, testServerPort, vitePort }),
);

export default defineConfig({
  testDir: import.meta.dirname + "/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  globalSetup: "./e2e/globalSetup.ts",
  globalTeardown: "./e2e/globalTeardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    storageState: "e2e/.auth.json",
  },
  // Vite dev server — proxies /api → test backend on the picked free port.
  // The `--` separator passes --port through to Vite, not Bun.
  webServer: {
    command:
      `env ENV=test HOST=127.0.0.1 PORT=${testServerPort} bun --cwd=${import.meta.dirname}/web run dev -- --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: false,
  },
});
