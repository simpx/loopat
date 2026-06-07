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
 *   4. Write the user's personal config (anthropic provider) and build a
 *      SELF-CONTAINED vault: a FRESH ssh keypair (generated here, not copied
 *      from any real vault) + ANTHROPIC_API_KEY taken from the env. Add a
 *      `loopat-fixture` ssh Host alias -> 127.0.0.1:<sshdPort>.
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
  readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync,
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
};

async function globalSetup() {
  const meta = JSON.parse(readFileSync(META, "utf8")) as Meta;
  const { loopatHome, testServerPort, vitePort, sshdPort } = meta;

  console.log(`[dogfood:setup] LOOPAT_HOME = ${loopatHome}`);
  console.log(`[dogfood:setup] backend :${testServerPort}  vite :${vitePort}  sshd :${sshdPort}`);

  // ── 0. build + run the fixture sshd container ──
  // The fixture sshd must be reachable from TWO places using the SAME ssh
  // config (it lives in one vault): the backend, which runs on the HOST, and
  // the loop's sandbox CONTAINER, which runs on a podman BRIDGE network (its
  // 127.0.0.1 is its own loopback, not the host's). The one address that works
  // from both is the host's default-route IP: from the host it's a local
  // address, and from a bridge container it's exactly what `host.containers
  // .internal` resolves to. So publish the sshd on 0.0.0.0 (not just loopback)
  // and point the ssh config's HostName at that IP. (Publishing on 127.0.0.1
  // only — the old way — works host-side but the sandbox push then fails to
  // even connect, and with HostName 127.0.0.1 the sandbox would dial its own
  // loopback.)
  const hostIp = execSync("ip route get 1.1.1.1")
    .toString()
    .match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!hostIp) throw new Error("[dogfood:setup] could not determine host default-route IP for the fixture sshd");
  console.log(`[dogfood:setup] building ${FIXTURE_IMAGE} from ${FIXTURE_DIR}`);
  execSync(`podman build -t ${FIXTURE_IMAGE} ${FIXTURE_DIR}`, { stdio: "inherit" });
  const fixtureContainer = execFileSync(
    "podman",
    ["run", "-d", "-p", `0.0.0.0:${sshdPort}:22`, FIXTURE_IMAGE],
  ).toString().trim();
  console.log(`[dogfood:setup] fixture sshd up: ${fixtureContainer.slice(0, 12)} on ${hostIp}:${sshdPort} (0.0.0.0 published)`);
  // Record the container id immediately so teardown can reap it even if a
  // later setup step throws.
  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer }));

  // ── 1. workspace config: point knowledge + gitHost at the fixture sshd ──
  // The `loopat-fixture` ssh Host alias is defined in the vault ssh config
  // (written in step 4); git urls use it so the host:port stays out of the url.
  mkdirSync(loopatHome, { recursive: true });
  const workspaceConfig = {
    knowledge: { git: `ssh://git@${hostIp}:${sshdPort}/srv/git/knowledge.git` },
    gitHost: { baseUrl: `ssh://git@${hostIp}:${sshdPort}` },
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

  // Self-contained vault — NOTHING copied from any real vault.
  // (a) fresh ssh keypair for this run; its pubkey goes into the fixture's
  //     authorized_keys (step 5). Standard name id_ed25519 so ssh auto-resolves.
  const sshDir = join(vaultDir, "mounts", "home", ".ssh");
  mkdirSync(sshDir, { recursive: true });
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", "dogfood-fixture", "-f", join(sshDir, "id_ed25519")]);
  chmodSync(join(sshDir, "id_ed25519"), 0o600);
  // (b) the ONE real secret a fixture can't fake — the provider key — comes from
  //     the env, written into this temp (git-ignored, teardown-deleted) vault so
  //     the loop's ${ANTHROPIC_API_KEY} resolves. Never read from disk, never committed.
  const envsDir = join(vaultDir, "envs");
  mkdirSync(envsDir, { recursive: true });
  writeFileSync(join(envsDir, "ANTHROPIC_API_KEY"), (process.env.ANTHROPIC_API_KEY ?? "") + "\n");
  writeFileSync(
    join(sshDir, "config"),
    [
      "Host loopat-fixture",
      `    HostName ${hostIp}`,
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
  // OpenSSH SILENTLY IGNORES ~/.ssh/config if it is group- or world-writable
  // (and the dir if it's group/world-writable). writeFileSync/mkdirSync leave
  // 0664/0775 here, so the loopat-fixture Host alias would never apply inside
  // the sandbox — ssh would try to resolve the literal hostname "loopat-fixture"
  // and fail. Lock both down so the alias (HostName/Port/IdentityFile) is read.
  chmodSync(join(sshDir, "config"), 0o600);
  chmodSync(sshDir, 0o700);

  // Pre-trust the fixture's host key. Remotes use absolute `ssh://git@<ip>:<port>`
  // URLs (no Host alias — the mounted ssh config may not take effect inside the
  // sandbox), so a host-key prompt would hang the non-interactive `git push`.
  // Seed known_hosts directly from the running fixture so ssh trusts it.
  try {
    const scan = execFileSync("ssh-keyscan", ["-p", String(sshdPort), hostIp]).toString();
    writeFileSync(join(sshDir, "known_hosts"), scan);
    chmodSync(join(sshDir, "known_hosts"), 0o644);
  } catch (e) {
    console.warn(`[dogfood:setup] ssh-keyscan failed (host-key prompt may hang the push): ${e}`);
  }

  // Personal config: anthropic provider (apiKey resolved from vault), the roster
  // repo + knowledge pointer at the fixture.
  // The model is provider-specific: official api.anthropic.com serves all tiers,
  // but a single-model gateway (idealab opus-4-6) serves only one — and built-in
  // subagents default to the haiku tier it doesn't have. The subagent-model
  // suite points these at idealab via env to reproduce that 404 when the per-tier
  // passthrough is missing; everything else uses the official default.
  const baseUrl = process.env.LOOPAT_TEST_BASEURL || "https://api.anthropic.com";
  const mainModel = process.env.LOOPAT_TEST_MODEL || "claude-opus-4-7";
  const personalConfig = {
    providers: {
      default: `anthropic/${mainModel}`,
      anthropic: {
        models: [{ id: mainModel, enabled: true }],
        baseUrl,
        apiKey: "${ANTHROPIC_API_KEY}",
        maxContextTokens: 1000000,
        enabled: true,
        // Pin every built-in subagent to the one model this provider serves.
        // Env passthrough → ANTHROPIC_DEFAULT_*_MODEL + CLAUDE_CODE_SUBAGENT_MODEL.
        sonnet_model: mainModel,
        haiku_model: mainModel,
        agent_model: mainModel,
      },
    },
    knowledge: { git: `ssh://git@${hostIp}:${sshdPort}/srv/git/knowledge.git` },
    repos: [
      { name: "roster1", git: `ssh://git@${hostIp}:${sshdPort}/srv/git/roster1.git` },
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
  // Pass the absolute ssh base so seed.sh writes the notes pointer as an
  // env-agnostic `ssh://git@<ip>:<port>/srv/git/notes.git` (no Host alias —
  // resolves identically in first-5-minutes and first-run).
  const notesSshBase = `ssh://git@${hostIp}:${sshdPort}`;
  const seedOut = execFileSync(
    "podman",
    ["exec", fixtureContainer, "/seed.sh", pubkey, notesSshBase],
  ).toString().trim();
  console.log(`[dogfood:setup] fixture seed: ${seedOut}`);

  // ── 6. save cookies for the browser spec ──
  const state = await api.storageState();
  writeFileSync(join(import.meta.dirname, ".auth.json"), JSON.stringify(state, null, 2));
  console.log(`[dogfood:setup] saved ${state.cookies.length} cookie(s)`);

  await api.dispose();
}

export default globalSetup;
