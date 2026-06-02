/**
 * dogfood global setup — boot the real stack as an ALREADY-ONBOARDED user.
 *
 * Order matters:
 *   0. Build the fixture image and run the sshd container (podman rejects
 *      `-p 127.0.0.1:0:22`, so the host port was picked in playwright.config.ts).
 *      Done here (not at config top-level) because Playwright loads the config
 *      twice and a second `podman run` on the same port would collide.
 *   1. Seed the isolated LOOPAT_HOME workspace config (gitHost + knowledge ->
 *      the fixture sshd) BEFORE the backend starts so it reads them on boot.
 *   2. Spawn the backend on the picked free port with the isolated LOOPAT_HOME.
 *   3. Register the test user (scaffolds personal/<user>/).
 *   4. Write the user's personal config (idealab provider, apiKey ${IDEALAB_API_KEY})
 *      and copy the dev vault (envs/IDEALAB_API_KEY + mounts/home/.ssh/id_ed25519)
 *      so the loop has a working AI key + ssh key. Add a `loopat-fixture` ssh
 *      Host alias -> 127.0.0.1:<sshdPort> so git@loopat-fixture:* resolves.
 *   5. Seed the fixture container's authorized_keys with that vault pubkey and
 *      create the bare repos (seed.sh).
 *   6. Save browser storageState for the spec.
 *
 * The fixture container + ports are already up (decided in playwright.config.ts,
 * recorded in .test-meta.json).
 */
import { request } from "@playwright/test";
import { spawn, execSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, chmodSync, realpathSync,
} from "node:fs";
import { join } from "node:path";

const META = join(import.meta.dirname, ".test-meta.json");
const FIXTURE_IMAGE = "loopat-dogfood-sshd:latest";
const FIXTURE_DIR = join(import.meta.dirname, "first-5-minutes", "fixtures");

const TEST_USER = "test";
const TEST_PASSWORD = "test123";

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

type Meta = {
  loopatHome: string;
  testServerPort: number;
  vitePort: number;
  sshdPort: number;
  devVault: string;
};

async function globalSetup() {
  const meta = JSON.parse(readFileSync(META, "utf8")) as Meta;
  const { loopatHome, testServerPort, vitePort, sshdPort, devVault } = meta;

  console.log(`[dogfood:setup] LOOPAT_HOME = ${loopatHome}`);
  console.log(`[dogfood:setup] backend :${testServerPort}  vite :${vitePort}  sshd :${sshdPort}`);

  // ── 0. build + run the fixture sshd container ──
  console.log(`[dogfood:setup] building ${FIXTURE_IMAGE} from ${FIXTURE_DIR}`);
  execSync(`podman build -t ${FIXTURE_IMAGE} ${FIXTURE_DIR}`, { stdio: "inherit" });
  const fixtureContainer = execFileSync(
    "podman",
    ["run", "-d", "-p", `127.0.0.1:${sshdPort}:22`, FIXTURE_IMAGE],
  ).toString().trim();
  console.log(`[dogfood:setup] fixture sshd up: ${fixtureContainer.slice(0, 12)} on 127.0.0.1:${sshdPort}`);
  // Record the container id immediately so teardown can reap it even if a
  // later setup step throws.
  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer }));

  // ── 1. workspace config: point knowledge + gitHost at the fixture sshd ──
  // The `loopat-fixture` ssh Host alias is defined in the vault ssh config
  // (written in step 4); git urls use it so the host:port stays out of the url.
  mkdirSync(loopatHome, { recursive: true });
  const workspaceConfig = {
    knowledge: { git: "git@loopat-fixture:knowledge.git" },
    gitHost: { baseUrl: `ssh://git@127.0.0.1:${sshdPort}` },
  };
  writeFileSync(join(loopatHome, "config.json"), JSON.stringify(workspaceConfig, null, 2) + "\n");

  // ── 2. start the backend ──
  // Kill any stale backend on the port from a crashed previous run.
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

  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer, serverPid: server.pid }));

  await waitFor(`http://127.0.0.1:${testServerPort}/api/health`);
  const health = await (await fetch(`http://127.0.0.1:${testServerPort}/api/health`)).json();
  if (health.loopatHome !== loopatHome) {
    throw new Error(
      `stale server on :${testServerPort} has LOOPAT_HOME=${health.loopatHome}, expected ${loopatHome}. ` +
      `Kill it manually: fuser -k ${testServerPort}/tcp`,
    );
  }
  console.log("[dogfood:setup] backend ready");

  await waitFor(`http://127.0.0.1:${vitePort}/api/health`);
  console.log("[dogfood:setup] vite ready");

  // ── 3. register the test user ──
  const base = `http://127.0.0.1:${vitePort}`;
  const api = await request.newContext({ baseURL: base });

  const reg = await api.post("/api/auth/register", {
    data: { username: TEST_USER, password: TEST_PASSWORD },
  });
  const regBody = await reg.json();
  if (!regBody.user) throw new Error(`register failed: ${JSON.stringify(regBody)}`);
  const userId = regBody.user.id as string;
  console.log(`[dogfood:setup] user: ${userId} (${regBody.user.role}/${regBody.user.status})`);

  // ── 4. preconfigure ALREADY-ONBOARDED: personal config + vault ──
  const personalLoopat = join(loopatHome, "personal", userId, ".loopat");
  const vaultDir = join(personalLoopat, "vaults", "default");

  // Copy the dev vault (idealab key + ssh key + mounts) wholesale, then
  // overwrite the ssh config with one that knows the fixture host:port.
  cpSync(devVault, vaultDir, { recursive: true });

  const sshDir = join(vaultDir, "mounts", "home", ".ssh");
  mkdirSync(sshDir, { recursive: true });
  // git can't persist 0600; the server force-chmods at point of use, but set it
  // here too so the first host-side op is clean.
  try { chmodSync(join(sshDir, "id_ed25519"), 0o600); } catch {}
  writeFileSync(
    join(sshDir, "config"),
    [
      "Host loopat-fixture",
      "    HostName 127.0.0.1",
      `    Port ${sshdPort}`,
      "    User git",
      "    IdentityFile ~/.ssh/id_ed25519",
      "    IdentitiesOnly yes",
      "    StrictHostKeyChecking accept-new",
      "    UserKnownHostsFile /dev/null",
      "",
      "Host *",
      "    StrictHostKeyChecking accept-new",
      "",
    ].join("\n"),
  );

  // Personal config: idealab provider (apiKey resolved from vault), the roster
  // repo + knowledge pointer at the fixture.
  const personalConfig = {
    providers: {
      default: "idealab/claude-opus-4-7",
      idealab: {
        models: [{ id: "claude-opus-4-7", enabled: true }],
        baseUrl: "https://idealab.alibaba-inc.com/api/anthropic",
        apiKey: "${IDEALAB_API_KEY}",
        maxContextTokens: 1000000,
        enabled: true,
      },
    },
    knowledge: { git: "git@loopat-fixture:knowledge.git" },
    repos: [
      { name: "roster1", git: "git@loopat-fixture:roster1.git" },
    ],
  };
  mkdirSync(personalLoopat, { recursive: true });
  writeFileSync(
    join(personalLoopat, "config.json"),
    JSON.stringify(personalConfig, null, 2) + "\n",
  );
  console.log(`[dogfood:setup] preconfigured onboarded vault at ${vaultDir}`);

  // ── 5. seed the fixture with the vault pubkey + bare repos ──
  const pubkey = readFileSync(join(sshDir, "id_ed25519.pub"), "utf8").trim();
  const seedOut = execFileSync(
    "podman",
    ["exec", fixtureContainer, "/seed.sh", pubkey],
  ).toString().trim();
  console.log(`[dogfood:setup] fixture seed: ${seedOut}`);

  // ── 6. save cookies for the browser spec ──
  const state = await api.storageState();
  writeFileSync(join(import.meta.dirname, ".auth.json"), JSON.stringify(state, null, 2));
  console.log(`[dogfood:setup] saved ${state.cookies.length} cookie(s)`);

  await api.dispose();
}

export default globalSetup;
