/**
 * dogfood/sync global setup — boot TWO independent ALREADY-ONBOARDED loopat
 * servers that share ONE fixture sshd origin.
 *
 * Mirrors dogfood/setup.ts, but does it twice and behind one shared fixture:
 *   0. build + run ONE fixture sshd = the shared origin; seed kn/notes/roster1.
 *   1. For EACH server (A, B): isolated LOOPAT_HOME, workspace config -> the
 *      shared fixture, a backend on its own port, a registered user, a SELF-
 *      CONTAINED vault (fresh ed25519 + ANTHROPIC_API_KEY from env) pointing at
 *      the SAME team kn/notes/roster repos. BOTH pubkeys are appended to the
 *      fixture authorized_keys so either server can push.
 *   2. Save two storageStates (.authA.json / .authB.json) for the spec.
 *
 * Both servers point at the same knowledge/notes/roster repos: that's the
 * "shared personal repo" of S1 — same kn/notes pointers. The cases that need
 * isolation (S2 personal) write their own per-server bits at runtime.
 *
 * Preconditions are FAIL-not-skip (enforced in the config): podman,
 * ANTHROPIC_API_KEY, FIRST_RUN_AI_BASE_URL.
 */
import { request } from "@playwright/test";
import { spawn, execSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync,
} from "node:fs";
import { join } from "node:path";

const META = join(import.meta.dirname, ".test-meta.json");
const FIXTURE_IMAGE = "loopat-sync-sshd:latest";
const FIXTURE_DIR = join(import.meta.dirname, "..", "first-5-minutes", "fixtures");

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
  homeA: string; homeB: string;
  aBack: number; aVite: number; bBack: number; bVite: number; sshdPort: number;
};

/** Bring up one loopat server (workspace config + backend + user + vault) on an
 *  isolated LOOPAT_HOME against the shared fixture. Returns the user id + vault
 *  pubkey + backend pid + storage state, so the caller can seed authorized_keys
 *  with both keys and save per-server cookies. */
async function bringUpServer(opts: {
  tag: string; home: string; back: number; vite: number;
  user: string; hostIp: string; sshdPort: number;
}): Promise<{ pid: number; pubkey: string; state: any }> {
  const { tag, home, back, vite, user, hostIp, sshdPort } = opts;
  const sshBase = `ssh://git@${hostIp}:${sshdPort}`;

  // workspace config: knowledge + gitHost at the shared fixture
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    knowledge: { git: `${sshBase}/srv/git/knowledge.git` },
    gitHost: { baseUrl: sshBase },
  }, null, 2) + "\n");

  // backend
  try { execSync(`fuser -k ${back}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
  const serverDir = realpathSync(join(import.meta.dirname, "..", "..", "server"));
  const server = spawn("bun", ["run", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ENV: "test", NODE_ENV: "production", LOOPAT_HOME: home, LOOPAT_SERVE_PORT: "0", PORT: String(back), HOST: "127.0.0.1" },
    stdio: "pipe",
  });
  server.stdout?.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  await waitFor(`http://127.0.0.1:${back}/api/health`);
  await waitFor(`http://127.0.0.1:${vite}/api/health`);
  console.log(`[dogfood:sync] ${tag} backend+vite ready (:${back}/:${vite})`);

  // register the user
  const base = `http://127.0.0.1:${vite}`;
  const api = await request.newContext({ baseURL: base });
  const reg = await api.post("/api/auth/register", { data: { username: user, password: TEST_PASSWORD } });
  const regBody = await reg.json();
  if (!regBody.user) throw new Error(`${tag} register failed: ${JSON.stringify(regBody)}`);
  const userId = regBody.user.id as string;
  console.log(`[dogfood:sync] ${tag} user ${userId} (${regBody.user.role}/${regBody.user.status})`);

  // self-contained onboarded vault: fresh ssh keypair + ANTHROPIC_API_KEY
  const personalLoopat = join(home, "personal", userId, ".loopat");
  const vaultDir = join(personalLoopat, "vaults", "default");
  const sshDir = join(vaultDir, "mounts", "home", ".ssh");
  mkdirSync(sshDir, { recursive: true });
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", `dogfood-sync-${tag}`, "-f", join(sshDir, "id_ed25519")]);
  chmodSync(join(sshDir, "id_ed25519"), 0o600);
  const envsDir = join(vaultDir, "envs");
  mkdirSync(envsDir, { recursive: true });
  writeFileSync(join(envsDir, "ANTHROPIC_API_KEY"), (process.env.ANTHROPIC_API_KEY ?? "") + "\n");
  writeFileSync(join(sshDir, "config"), [
    "Host loopat-fixture", `    HostName ${hostIp}`, `    Port ${sshdPort}`, "    User git",
    "    IdentityFile ~/.ssh/id_ed25519", "    IdentitiesOnly yes",
    "    StrictHostKeyChecking accept-new", "    UserKnownHostsFile /dev/null", "",
    "Host *", "    StrictHostKeyChecking accept-new", "",
  ].join("\n"));
  chmodSync(join(sshDir, "config"), 0o600);
  chmodSync(sshDir, 0o700);
  try {
    writeFileSync(join(sshDir, "known_hosts"), execFileSync("ssh-keyscan", ["-p", String(sshdPort), hostIp]).toString());
    chmodSync(join(sshDir, "known_hosts"), 0o644);
  } catch (e) { console.warn(`[dogfood:sync] ${tag} ssh-keyscan failed: ${e}`); }

  // personal config: anthropic provider + shared kn/notes/roster pointers
  writeFileSync(join(personalLoopat, "config.json"), JSON.stringify({
    providers: {
      default: "anthropic/claude-opus-4-7",
      anthropic: {
        models: [{ id: "claude-opus-4-7", enabled: true }],
        baseUrl: process.env.FIRST_RUN_AI_BASE_URL,
        apiKey: "${ANTHROPIC_API_KEY}",
        maxContextTokens: 1000000, enabled: true,
      },
    },
    knowledge: { git: `${sshBase}/srv/git/knowledge.git` },
    repos: [{ name: "roster1", git: `${sshBase}/srv/git/roster1.git` }],
  }, null, 2) + "\n");

  const pubkey = readFileSync(join(sshDir, "id_ed25519.pub"), "utf8").trim();
  const state = await api.storageState();
  await api.dispose();
  return { pid: server.pid!, pubkey, state };
}

async function globalSetup() {
  const meta = JSON.parse(readFileSync(META, "utf8")) as Meta;
  const { homeA, homeB, aBack, aVite, bBack, bVite, sshdPort } = meta;
  console.log(`[dogfood:sync] A HOME=${homeA}  B HOME=${homeB}`);
  console.log(`[dogfood:sync] A :${aBack}/:${aVite}  B :${bBack}/:${bVite}  sshd :${sshdPort}`);

  // 0. one fixture sshd = shared origin
  const hostIp = execSync("ip route get 1.1.1.1").toString().match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!hostIp) throw new Error("[dogfood:sync] could not determine host default-route IP");
  console.log(`[dogfood:sync] building ${FIXTURE_IMAGE}`);
  execFileSync("podman", ["build", "-t", FIXTURE_IMAGE, FIXTURE_DIR], { stdio: "inherit" });
  const fixtureContainer = execFileSync("podman", ["run", "-d", "-p", `0.0.0.0:${sshdPort}:22`, FIXTURE_IMAGE]).toString().trim();
  console.log(`[dogfood:sync] fixture up: ${fixtureContainer.slice(0, 12)} on ${hostIp}:${sshdPort}`);
  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer, hostIp }));

  // 1. seed bare repos with EMPTY authorized_keys; both vault keys added later
  const seedOut = execFileSync("podman", ["exec", fixtureContainer, "/seed.sh", "", `ssh://git@${hostIp}:${sshdPort}`]).toString().trim();
  console.log(`[dogfood:sync] fixture seed: ${seedOut}`);

  // 2. bring up both servers
  const A = await bringUpServer({ tag: "A", home: homeA, back: aBack, vite: aVite, user: "alice", hostIp, sshdPort });
  const B = await bringUpServer({ tag: "B", home: homeB, back: bBack, vite: bVite, user: "bob", hostIp, sshdPort });
  writeFileSync(META, JSON.stringify({ ...meta, fixtureContainer, hostIp, pidA: A.pid, pidB: B.pid }));

  // 3. seed BOTH pubkeys into authorized_keys
  execFileSync("podman", ["exec", "-i", fixtureContainer, "sh", "-c",
    "cat >> /home/git/.ssh/authorized_keys && chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys",
  ], { input: A.pubkey + "\n" + B.pubkey + "\n" });
  console.log("[dogfood:sync] both vault pubkeys seeded into fixture authorized_keys");

  // 4. save storage states
  writeFileSync(join(import.meta.dirname, ".authA.json"), JSON.stringify(A.state, null, 2));
  writeFileSync(join(import.meta.dirname, ".authB.json"), JSON.stringify(B.state, null, 2));
  console.log("[dogfood:sync] saved .authA.json / .authB.json");
}

export default globalSetup;
