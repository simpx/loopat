/**
 * Global setup — starts the test backend on the port picked by the config,
 * registers a test user, creates test loops, and saves browser storageState.
 *
 * Ports are chosen at config-load time (playwright.config.ts) and stored in
 * .test-meta.json so dev and test never share the same ports.
 */
import { request } from "@playwright/test";
import { spawn, execSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const META = join(import.meta.dirname, ".test-meta.json");

const TEST_USER = "test";
const TEST_PASSWORD = "test123";

const LOOPS = [
  { title: "测试任务：修复登录页bug", archive: false, rfd: false },
  { title: "设计新的 Dashboard 页面", archive: false, rfd: false },
  { title: "优化数据库查询性能", archive: true, rfd: false },
  { title: "接入第三方支付", archive: false, rfd: true },
];

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function globalSetup() {
  const meta = JSON.parse(readFileSync(META, "utf8"));
  const { loopatHome, testServerPort, vitePort } = meta as {
    loopatHome: string; testServerPort: number; vitePort: number;
  };

  console.log(`[e2e:setup] LOOPAT_HOME = ${loopatHome}`);
  console.log(`[e2e:setup] backend :${testServerPort}  vite :${vitePort}`);

  // ── start test backend ──
  // Kill any stale backend process from a crashed previous run. Only the
  // backend port — Vite is managed by Playwright's webServer and is fresh.
  try { execSync(`fuser -k ${testServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}

  const serverDir = realpathSync(join(import.meta.dirname, "..", "server"));
  const server = spawn("bun", ["run", "src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      ENV: "test",
      NODE_ENV: "production",
      LOOPAT_HOME: loopatHome,
      LOOPAT_SERVE_PORT: "0",
      PORT: String(testServerPort),
      HOST: "127.0.0.1",
    },
    stdio: "pipe",
  });
  server.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  // Update meta with server PID for teardown
  writeFileSync(META, JSON.stringify({ ...meta, serverPid: server.pid }));

  // Wait for backend and verify it's ours (not a leftover from a crashed run).
  await waitFor(`http://127.0.0.1:${testServerPort}/api/health`);
  const health = await (await fetch(`http://127.0.0.1:${testServerPort}/api/health`)).json();
  if (health.loopatHome !== loopatHome) {
    throw new Error(
      `stale server on :${testServerPort} has LOOPAT_HOME=${health.loopatHome}, expected ${loopatHome}. ` +
      `Kill it manually: fuser -k ${testServerPort}/tcp`
    );
  }
  console.log("[e2e:setup] backend ready");

  await waitFor(`http://127.0.0.1:${vitePort}/api/health`);
  console.log("[e2e:setup] vite ready");

  // ── register test user ──
  const base = `http://127.0.0.1:${vitePort}`;
  const api = await request.newContext({ baseURL: base });

  const reg = await api.post("/api/auth/register", {
    data: { username: TEST_USER, password: TEST_PASSWORD },
  });
  const regBody = await reg.json();
  if (!regBody.user) throw new Error(`register failed: ${JSON.stringify(regBody)}`);
  console.log(`[e2e:setup] user: ${regBody.user.id} (${regBody.user.role}/${regBody.user.status})`);

  // ── create test loops ──
  for (const { title, archive, rfd } of LOOPS) {
    const r = await api.post("/api/loops", {
      data: { title },
      headers: { "Content-Type": "application/json" },
    });
    const body = await r.json();
    if (!body.id) {
      console.log(`[e2e:setup] FAIL "${title}": ${JSON.stringify(body)}`);
      continue;
    }
    if (archive) await api.patch(`/api/loops/${body.id}`, { data: { archived: true } });
    if (rfd) await api.post(`/api/loops/${body.id}/request-drive`);
    console.log(`[e2e:setup] ${archive ? "[archived] " : ""}${rfd ? "[RFD] " : ""}"${title}"`);
  }

  // ── save cookies for browser tests ──
  const state = await api.storageState();
  writeFileSync(join(import.meta.dirname, ".auth.json"), JSON.stringify(state, null, 2));
  console.log(`[e2e:setup] saved ${state.cookies.length} cookie(s)`);

  await api.dispose();
}

export default globalSetup;
