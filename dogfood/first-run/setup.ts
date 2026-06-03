/**
 * dogfood/first-run global setup — boot the real stack as a TRULY FRESH install.
 *
 * Unlike the other dogfood setup (which presets an onboarded user + vault +
 * storageState), this one does as little as possible so the BROWSER drives the
 * whole first-run flow:
 *   0. Build + run the fixture sshd container (host port picked in the config).
 *   1. Seed the fixture's bare repos (knowledge/notes/roster1/roster2) with an
 *      EMPTY authorized_keys — no key can reach them yet. The personal-repo flow
 *      will append the host deploy key itself; the vault key is added in step 7.
 *   2. Write a MINIMAL workspace config.json (no knowledge/gitHost — the fixture
 *      provider + the user's seeded personal config own all of that) and install
 *      the fixture git-host provider into LOOPAT_HOME/extensions/providers/.
 *   3. Spawn the backend on the empty LOOPAT_HOME with the FIXTURE_* env the
 *      provider reads. NO user, NO vault, NO storageState.
 *
 * Everything else (register, login, onboarding, personal repo, ssh-pubkey seed,
 * loop, chat) happens in journey.spec.ts through the real browser.
 */
import { spawn, execSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync,
} from "node:fs";
import { join } from "node:path";

const META = join(import.meta.dirname, ".test-meta.json");
const FIXTURE_IMAGE = "loopat-firstrun-sshd:latest";
// Reuse the shared fixture image build context (same sshd + seed.sh).
const FIXTURE_DIR = join(import.meta.dirname, "..", "first-5-minutes", "fixtures");
const PROVIDER_SRC = join(import.meta.dirname, "fixtures", "fixture-provider.ts");

// The fixture token the onboarding UI will submit + the login it maps to.
const FIXTURE_TOKEN = "fixture-token-abc123";
const FIXTURE_LOGIN = "test";

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
};

async function globalSetup() {
  const meta = JSON.parse(readFileSync(META, "utf8")) as Meta;
  const { loopatHome, testServerPort, vitePort, sshdPort } = meta;

  console.log(`[first-run:setup] LOOPAT_HOME = ${loopatHome} (EMPTY — true first run)`);
  console.log(`[first-run:setup] backend :${testServerPort}  vite :${vitePort}  sshd :${sshdPort}`);

  // ── 0. build + run the fixture sshd container ──
  const hostIp = execSync("ip route get 1.1.1.1")
    .toString()
    .match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!hostIp) throw new Error("[first-run:setup] could not determine host default-route IP for the fixture sshd");
  const fixtureHostPort = `${hostIp}:${sshdPort}`;
  console.log(`[first-run:setup] building ${FIXTURE_IMAGE} from ${FIXTURE_DIR}`);
  execSync(`podman build -t ${FIXTURE_IMAGE} ${FIXTURE_DIR}`, { stdio: "inherit" });
  const fixtureContainer = execFileSync(
    "podman",
    ["run", "-d", "-p", `0.0.0.0:${sshdPort}:22`, FIXTURE_IMAGE],
  ).toString().trim();
  console.log(`[first-run:setup] fixture sshd up: ${fixtureContainer.slice(0, 12)} on ${fixtureHostPort}`);
  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer, hostIp }));

  // ── 1. seed the fixture repos with an EMPTY authorized_keys ──
  // No key reaches the fixture yet. registerDeployKey (personal repo) and the
  // step-7 vault-pubkey seed (team repos) populate it through the real flow.
  // arg1 (pubkey) is empty — no key reaches the fixture yet. arg2 is the
  // absolute ssh base for the notes pointer seed.sh writes into the knowledge
  // repo's config.json, so notes resolves env-agnostically (no Host alias,
  // which this vault's seedDefaults ssh config does not define).
  const notesSshBase = `ssh://git@${hostIp}:${sshdPort}`;
  const seedOut = execFileSync("podman", ["exec", fixtureContainer, "/seed.sh", "", notesSshBase]).toString().trim();
  console.log(`[first-run:setup] fixture seed (empty authorized_keys): ${seedOut}`);

  // ── 2. minimal workspace config + install the fixture provider ──
  // No knowledge / gitHost block: the fixture provider IS the active provider
  // (extensions win outright), and the user's seeded personal config carries the
  // knowledge pointer. We keep config.json minimal/empty.
  mkdirSync(loopatHome, { recursive: true });
  writeFileSync(join(loopatHome, "config.json"), JSON.stringify({}, null, 2) + "\n");

  const provDir = join(loopatHome, "extensions", "providers");
  mkdirSync(provDir, { recursive: true });
  copyFileSync(PROVIDER_SRC, join(provDir, "fixture.ts"));
  console.log(`[first-run:setup] installed fixture provider -> ${join(provDir, "fixture.ts")}`);

  // ── 3. start the backend on the empty LOOPAT_HOME ──
  try { execSync(`fuser -k ${testServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}

  const serverDir = realpathSync(join(import.meta.dirname, "..", "..", "server"));
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
      // ── fixture provider env (no internal endpoints in committed files) ──
      FIXTURE_CONTAINER: fixtureContainer,
      FIXTURE_GIT_HOST: fixtureHostPort,
      FIXTURE_TOKEN,
      FIXTURE_LOGIN,
      FIXTURE_AI_BASE_URL: process.env.FIRST_RUN_AI_BASE_URL!,
    },
    stdio: "pipe",
  });
  server.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer, hostIp, serverPid: server.pid, fixtureToken: FIXTURE_TOKEN }));

  await waitFor(`http://127.0.0.1:${testServerPort}/api/health`);
  const health = await (await fetch(`http://127.0.0.1:${testServerPort}/api/health`)).json();
  if (health.loopatHome !== loopatHome) {
    throw new Error(
      `stale server on :${testServerPort} has LOOPAT_HOME=${health.loopatHome}, expected ${loopatHome}. ` +
      `Kill it manually: fuser -k ${testServerPort}/tcp`,
    );
  }
  console.log("[first-run:setup] backend ready (fixture provider active)");

  await waitFor(`http://127.0.0.1:${vitePort}/api/health`);
  console.log("[first-run:setup] vite ready");
}

export default globalSetup;
