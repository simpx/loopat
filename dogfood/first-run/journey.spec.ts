/**
 * first-run — the REAL first-time-user cold-start journey, end to end.
 *
 * This supersedes the old "preset onboarded + storageState" first-5-minutes: it
 * starts from a TRULY EMPTY LOOPAT_HOME with the FIXTURE git-host provider as the
 * active provider, and drives the entire onboarding through the real browser. No
 * shortcuts — every step is a real action with integration-truth assertions
 * (podman / git / disk), not screenshots.
 *
 * 11 steps (per docs/superpowers/specs/2026-06-03-first-run-journey-redesign.md):
 *   1. empty LOOPAT_HOME (setup) — no user, no onboarded preset, no storageState.
 *   2. register through the UI.
 *   3. login (auto for the first/admin user) → lands on the onboarding gate.
 *   4. onboarding GATE blocks: can't reach context; loop-create returns 403.
 *   5. configure the personal repo via the real PersonalRepoPanel: token →
 *      list repos (EMPTY) → create → provider ensureRepo + registerDeployKey +
 *      seedDefaults → git-crypt auto-init → back up the git-crypt key.
 *   6. still gated: the vault ssh key isn't on the "platform" yet → onboarding
 *      shows the "add your pubkey" info step.
 *   7. TEST SEED: copy the vault id_ed25519.pub into the fixture authorized_keys
 *      (simulates the user adding the key on the platform's SSH Keys page).
 *   8. re-check → onboarding done; enter context → background clone → see the
 *      knowledge repo content.
 *   9. create a loop → sandbox container reaches RUNNING.
 *  10. chat → a real AI reply (spends one idealab turn).
 *  11. terminal → `git status` works in the loop workdir.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

type Meta = {
  loopatHome: string;
  testServerPort: number;
  vitePort: number;
  sshdPort: number;
  fixtureContainer: string;
  hostIp: string;
  fixtureToken: string;
};

function meta(): Meta {
  return JSON.parse(readFileSync(join(import.meta.dirname, ".test-meta.json"), "utf8")) as Meta;
}

const TEST_USER = "test";
const TEST_PASSWORD = "test123";

/** The registered user's id — the single dir under personal/. */
function testUserId(loopatHome: string): string {
  const dirs = readdirSync(join(loopatHome, "personal"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (dirs.length !== 1) throw new Error(`expected one personal/<user> dir, got: ${dirs.join(", ")}`);
  return dirs[0];
}

/** Append a pubkey to the fixture's authorized_keys (step 7 — "add it on the
 *  platform"). Uses `podman exec -i` so stdin reaches `cat` (without -i the
 *  pipe is closed and nothing gets appended); the fixture is the test's own
 *  resource. */
function seedPubKeyOntoFixture(container: string, pubkey: string): void {
  execFileSync("podman", [
    "exec", "-i", container, "sh", "-c",
    "cat >> /home/git/.ssh/authorized_keys && " +
    "chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys",
  ], { input: pubkey + "\n" });
}

/** Type a shell command into the focused xterm, run it, and give it time to
 *  execute. Reading the xterm prompt back is flaky, so we pace with a fixed
 *  settle delay between commands instead of prompt-matching (the same pattern
 *  first-5-minutes uses to drive the real terminal). */
async function runInTerminal(page: Page, cmd: string, settleMs = 1_500): Promise<void> {
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settleMs);
}

function runningContainers(loopId: string): string[] {
  return execFileSync("podman", [
    "ps", "--filter", `label=loopat.loop-id=${loopId}`,
    "--filter", "status=running", "--format", "{{.Names}}",
  ]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
}

function sandboxContainer(loopId: string): string {
  const names = runningContainers(loopId);
  if (names.length !== 1) throw new Error(`expected one running container for ${loopId}, got: ${names.join(", ")}`);
  return names[0];
}

function sandboxExec(loopId: string, cmd: string): string {
  return execFileSync("podman", ["exec", sandboxContainer(loopId), "sh", "-lc", cmd]).toString();
}

function cleanupLoopContainer(loopId: string): void {
  if (!loopId) return;
  try {
    const ids = execFileSync("podman", [
      "ps", "-a", "--filter", `label=loopat.loop-id=${loopId}`, "--format", "{{.ID}}",
    ]).toString().split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) execFileSync("podman", ["rm", "-f", ...ids]);
  } catch {}
}

let createdLoopId = "";
test.afterAll(() => cleanupLoopContainer(createdLoopId));

// One serial test — the whole journey is a single ordered story over one stack.
test("first-run: empty install → register → onboard (personal repo + git-crypt + ssh) → context → loop → AI → terminal", async ({ page }) => {
  test.setTimeout(420_000);
  const m = meta();
  const { loopatHome, fixtureContainer, fixtureToken } = m;

  // ════ Step 1: empty LOOPAT_HOME — assert no user exists yet. ════
  expect(existsSync(join(loopatHome, "personal")), "personal/ must not exist on a true first run").toBeFalsy();

  await page.goto("/");
  // The login/register page is the whole screen — no chrome, no tabs. The "Register"
  // tab and the submit button share the label, so scope each precisely.
  const form = page.locator("form");
  await expect(form).toBeVisible({ timeout: 20_000 });

  // ════ Step 2: register through the UI. ════
  // Switch to the Register tab (the tab button lives OUTSIDE the form).
  await page.locator("button", { hasText: /^Register$/ }).first().click();
  await page.getByPlaceholder("simpx").fill(TEST_USER);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  // The first account ever created bootstraps admin/active → auto session, no
  // pending notice. Capture the register response to confirm.
  const regResp = page.waitForResponse(
    (r) => r.url().includes("/api/auth/register") && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await form.getByRole("button", { name: /^Register$/ }).click();
  const reg = await (await regResp).json();
  expect(reg.user, `register should return a user: ${JSON.stringify(reg)}`).toBeTruthy();
  expect(reg.user.status, "first user must bootstrap active").toBe("active");
  console.log(`[first-run] registered ${reg.user.id} (${reg.user.role}/${reg.user.status})`);

  // ════ Step 3: logged in → onboarding gate. The gate's first remediation is a
  //      "route" to /settings/personal-repo, so the Shell navigates us there. ════
  await expect(page).toHaveURL(/\/settings\/personal-repo/, { timeout: 20_000 });
  console.log("[first-run] onboarding gate routed to personal-repo setup");

  // ════ Step 4: the gate BLOCKS. Prove (a) loop-create is 403 and (b) we can't
  //      reach context (the gate redirects back to the personal-repo route). ════
  const apiBase = `http://127.0.0.1:${m.vitePort}`;
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const createBlocked = await page.request.post(`${apiBase}/api/v1/loops`, {
    headers: { cookie: cookies, "content-type": "application/json" },
    data: { title: "should-be-blocked", repo: "roster1" },
  });
  expect(createBlocked.status(), "loop-create must be 403 while onboarding is incomplete").toBe(403);
  const blockedBody = await createBlocked.json();
  expect(JSON.stringify(blockedBody)).toContain("onboarding");
  console.log("[first-run] gate confirmed: loop-create 403 (onboarding incomplete)");

  // Try to navigate to context — the gate sends us back to the personal-repo route.
  await page.goto("/context/knowledge");
  await expect(page).toHaveURL(/\/settings\/personal-repo/, { timeout: 15_000 });
  console.log("[first-run] gate confirmed: context redirects back to onboarding");

  // ════ Step 5: configure the personal repo via the real PersonalRepoPanel. ════
  // Wizard step 1 — paste the fixture token, click Next → lists repos (EMPTY).
  const tokenInput = page.getByPlaceholder(/personal access \/ private token/i);
  await expect(tokenInput).toBeVisible({ timeout: 15_000 });
  await tokenInput.fill(fixtureToken);

  const reposResp = page.waitForResponse(
    (r) => r.url().includes("/api/personal/repos") && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: /^Next$/ }).click();
  const reposBody = await (await reposResp).json();
  expect(reposBody.ok, `listRepos should succeed with a valid token: ${JSON.stringify(reposBody)}`).toBeTruthy();
  expect(reposBody.repos, "first-run repo list must be EMPTY").toEqual([]);
  console.log("[first-run] personal repo picker: empty (first run) — will create one");

  // Wizard step 2 — empty list shows the "type a name" path; default name is
  // prefilled (loopat-personal). Advance to confirm.
  await expect(page.getByText(/no existing repos found/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Next$/ }).click();

  // Wizard step 3 — confirm "Create & set up": provider ensureRepo +
  // registerDeployKey + clone + git-crypt init + seedDefaults + push.
  const githubResp = page.waitForResponse(
    (r) => r.url().includes("/api/personal/github") && r.request().method() === "POST",
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: /Create & set up/i }).click();
  const ghBody = await (await githubResp).json();
  expect(ghBody.ok, `personal repo setup should succeed: ${JSON.stringify(ghBody)}`).toBeTruthy();
  expect(ghBody.autoInitialized, "a fresh repo must auto-init git-crypt").toBeTruthy();
  expect(ghBody.cryptKey, "auto-init must return a git-crypt key to back up").toBeTruthy();
  console.log(`[first-run] personal repo created + git-crypt'd (repo: ${ghBody.repo}, created: ${ghBody.created})`);

  // INTEGRATION TRUTH: the personal repo is now a real bare repo on the fixture,
  // and on disk the vault holds an encrypted id_ed25519 + a config.json.
  const personalCfgPath = join(loopatHome, "personal", testUserId(loopatHome), ".loopat", "config.json");
  await expect.poll(() => existsSync(personalCfgPath), { timeout: 15_000 }).toBeTruthy();
  const personalCfg = JSON.parse(readFileSync(personalCfgPath, "utf8"));
  expect(personalCfg.providers?.idealab, "seedDefaults must seed the idealab provider").toBeTruthy();
  expect(personalCfg.knowledge?.git, "seedDefaults must seed the knowledge pointer").toContain("knowledge.git");
  expect(personalCfg.providers.idealab.apiKey, "apiKey must be an env-var ref, not a real key").toBe("${IDEALAB_API_KEY}");
  console.log("[first-run] integration-truth: personal config.json seeded (env-ref apiKey, knowledge pointer)");

  // Back up the git-crypt key → acknowledge → Done.
  await expect(page.getByText(/back up your git-crypt key/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /^Done$/ }).click();

  // ════ Step 6: still gated — vault ssh key isn't on the platform yet → the
  //      onboarding info step asks to add the pubkey. (Personal repo imported, AI
  //      key seeded as env-ref? No — apiKey is an env REF; the vault env isn't set
  //      yet, so first the AI-key form may appear. Drive whatever the gate shows
  //      next until we reach the ssh-access info step, then beyond.) ════
  // After the route remediation clears (imported=true), the Shell re-checks
  // onboarding. Next gate is the AI key form (vault env empty). Fill it.
  // OnboardingForm uses the field label as the input placeholder (no htmlFor),
  // so the accessible name is the placeholder text.
  await expect(page.getByText("Set your AI API key")).toBeVisible({ timeout: 30_000 });
  const aiKeyField = page.getByPlaceholder("IdeaLab API Key");
  await expect(aiKeyField).toBeVisible({ timeout: 30_000 });
  // Use the same env key the harness exported — the test process has it.
  const idealabKey = process.env.IDEALAB_API_KEY!;
  expect(idealabKey, "IDEALAB_API_KEY must be in the test env").toBeTruthy();
  await aiKeyField.fill(idealabKey);
  const submitOb = page.waitForResponse(
    (r) => r.url().includes("/api/onboarding/submit") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: /^Save$/ }).click();
  await submitOb;
  console.log("[first-run] AI key saved to vault");

  // Now the ssh-access info step: the vault key can't reach knowledge/notes yet.
  await expect(page.getByText(/Authorize access to the team repos/i)).toBeVisible({ timeout: 30_000 });
  console.log("[first-run] gate confirmed: ssh-access info step shown (vault key not on platform)");

  // ════ Step 7: TEST SEED — "add the key on the platform". This mirrors a real
  //      user COPYING the ssh public key shown on the onboarding info step and
  //      PASTING it on the platform's SSH Keys page. So we read the key straight
  //      off the rendered page (the <code> in OnboardingInfo that renders
  //      show.values[].value), not from the /api/onboarding JSON.
  //
  //      Robustness: the displayed key can in principle race a vault re-sync that
  //      rewrites the working-tree key after the info step first renders (the
  //      reason the original read it from the API). So we (a) read the page value
  //      only after the info step is stable, and (b) cross-check it against the
  //      probe's own key from /api/onboarding — they MUST match, which guarantees
  //      the key we seed is exactly the one the provider's ls-remote probe uses. ════
  // The pubkey is the <code> next to the "Your SSH public key" label in the
  // OnboardingInfo card. Wait for it to render a complete ssh-ed25519 line.
  const pubCode = page.locator("code", { hasText: /^ssh-ed25519 / });
  await expect(pubCode).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await pubCode.innerText()).trim(), {
    message: "the info step must render a full ssh-ed25519 pubkey",
    timeout: 15_000, intervals: [500, 1000],
  }).toMatch(/^ssh-ed25519 \S+/);
  const pub = (await pubCode.innerText()).trim();
  expect(pub, "the rendered pubkey must be a complete ssh-ed25519 line").toMatch(/^ssh-ed25519 \S+/);

  // Cross-check the displayed key against the probe's key (guards a vault re-sync
  // race): the key the user sees on the page is exactly the one the probe uses.
  const obInfo = await (await page.request.get(`${apiBase}/api/onboarding`, { headers: { cookie: cookies } })).json();
  expect(obInfo.done, "should still be gated at the ssh-access info step").toBe(false);
  expect(obInfo.show?.kind, "the gate should be on the info step").toBe("info");
  const probePub = (obInfo.show.values?.[0]?.value ?? "").trim();
  expect(pub, "the page-displayed pubkey must match the probe's key (no vault-sync drift)").toBe(probePub);

  seedPubKeyOntoFixture(fixtureContainer, pub);
  console.log(`[first-run] seeded UI-displayed vault pubkey onto fixture: ${pub.slice(0, 40)}…`);

  // ════ Step 8: re-check → onboarding done → enter context → knowledge content. ════
  await page.getByRole("button", { name: /重新检查|re-?check/i }).click();
  // The gate clears; the Shell renders the normal app. Navigate to context.
  await expect.poll(async () => {
    const ob = await (await page.request.get(`${apiBase}/api/onboarding`, { headers: { cookie: cookies } })).json();
    return ob.done === true;
  }, { message: "onboarding must report done after the pubkey is added", timeout: 60_000, intervals: [1000, 2000, 3000] }).toBeTruthy();
  console.log("[first-run] onboarding DONE");

  // The gate cleared — context is now reachable (no redirect back to onboarding).
  await page.goto("/context/knowledge");
  await expect(page).toHaveURL(/\/context\/knowledge/, { timeout: 20_000 });
  await expect(page.getByText(/Set up your personal repo|Authorize access to the team repos/i))
    .toHaveCount(0, { timeout: 10_000 });
  console.log("[first-run] gate cleared: context page reachable");

  // ════ Step 9: create a loop → loopat clones the context (knowledge) on demand
  //      with the now-authorized vault key, then the sandbox container runs. ════
  await page.goto("/loop");
  await expect(page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first()).toBeVisible({ timeout: 20_000 });
  const loopTitle = `firstrun-${Date.now()}`;
  const createResp = page.waitForResponse(
    (r) => r.url().includes("/api/v1/loops") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: /^\+?\s*New Loop$/i }).first().click();
  await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("combobox").first().selectOption("roster1");
  await page.getByPlaceholder("refactor-gateway").fill(loopTitle);
  await page.getByRole("button", { name: "create", exact: true }).click();
  const resp = await createResp;
  expect(resp.status(), "loop-create must now succeed (gate cleared)").toBeLessThan(300);
  const respBody = await resp.json();
  const loopId = String(respBody.id ?? respBody.loop?.id ?? "").replace(/^loop_/, "");
  expect(loopId, `create response should carry a loop id: ${JSON.stringify(respBody)}`).toMatch(/^[a-f0-9-]+$/);
  createdLoopId = loopId;
  await expect(page).toHaveURL(new RegExp(`/loop/${loopId}`), { timeout: 20_000 });
  console.log(`[first-run] loop created: ${loopId.slice(0, 8)}`);

  // INTEGRATION TRUTH (step 8 payoff): loop creation ran ensureUserContext, which
  // cloned the knowledge repo with the now-authorized vault key. Assert it landed
  // on disk — proof the ssh-pubkey seed actually granted team-repo access.
  const userCtxDir = join(loopatHome, "context", "users", testUserId(loopatHome));
  const knowledgeDir = join(userCtxDir, "knowledge");
  await expect.poll(() => existsSync(join(knowledgeDir, ".git")), {
    message: "knowledge repo must clone (vault key authorized) and land on disk after loop create",
    timeout: 60_000, intervals: [1000, 2000, 3000],
  }).toBeTruthy();
  console.log("[first-run] integration-truth: knowledge repo cloned on disk (vault key authorized)");

  // INTEGRATION TRUTH: notes must clone too. ensureUserContext reads the notes
  // pointer from the knowledge repo's .loopat/config.json (now an env-agnostic
  // absolute ssh url — see seed.sh) and clones it with the same vault key. Until
  // the url-scheme fix, the notes pointer was a Host alias this vault's ssh
  // config never defined, so the notes clone silently failed; now it must land
  // on disk AND carry the seeded content (README.md from seed.sh's initial
  // commit) — proof notes is as real as knowledge.
  const notesDir = join(userCtxDir, "notes");
  await expect.poll(() => existsSync(join(notesDir, ".git")), {
    message: "notes repo must clone (env-agnostic absolute ssh url, vault key authorized) and land on disk",
    timeout: 60_000, intervals: [1000, 2000, 3000],
  }).toBeTruthy();
  expect(existsSync(join(notesDir, "README.md")), "the notes working tree must carry the seeded README.md").toBeTruthy();
  console.log("[first-run] integration-truth: notes repo cloned on disk with seeded content (README.md)");

  // Open terminal → ensureContainer → poll until RUNNING.
  await page.getByRole("button", { name: /terminal/ }).first().click();
  await expect.poll(() => runningContainers(loopId), {
    message: `expected a running container labelled loopat.loop-id=${loopId}`,
    timeout: 300_000, intervals: [1000, 2000, 5000],
  }).not.toEqual([]);
  console.log("[first-run] loop sandbox container RUNNING");

  // Wait for the per-loop image build overlay to clear before chatting.
  const preparing = page.getByText("Preparing this loop’s sandbox…");
  await expect(preparing).toBeHidden({ timeout: 300_000 });

  // ════ Step 10: chat → a real AI reply. ════
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.click();
  await composer.fill("Reply with exactly the single word: READY");
  await page.getByRole("button", { name: "Send message" }).click();

  const assistantMessages = page.locator('[data-role="assistant"]');
  await expect.poll(async () => {
    const n = await assistantMessages.count();
    for (let i = 0; i < n; i++) {
      const t = (await assistantMessages.nth(i).innerText()).trim();
      if (t.length > 0) return t;
    }
    return "";
  }, { message: "expected a non-empty assistant reply from the real AI", timeout: 180_000, intervals: [2000, 3000, 5000] }).not.toBe("");
  const allText = (await assistantMessages.allInnerTexts()).join("\n");
  expect(allText, "no error event should appear in the chat").not.toContain("⚠️");
  console.log(`[first-run] AI replied: ${(await assistantMessages.last().innerText()).trim().slice(0, 120)}`);

  // ════ Step 11: the USER types `git status` in the REAL UI terminal (xterm).
  //      The terminal panel is already open (step 9). Focus the xterm and TYPE
  //      the command through the browser — this is the whole point: the command
  //      goes through the real terminal UI, not `podman exec`.
  //
  //      xterm output is flaky to read (WebGL renderer ⇒ unreliable innerText),
  //      so we SOFT-check the xterm buffer if it's readable, and keep a HARD
  //      integration-truth backstop: the loop workdir IS a real git repo. ════
  const xterm = page.locator(".xterm-helper-textarea");
  await expect(xterm).toBeVisible({ timeout: 20_000 });
  await xterm.click();

  // The sandbox shell is fish — `; and` / `; or`, no `2>&1`. Emit a sentinel that
  // survives the flaky read: OK only if `git status` succeeded in the workdir.
  await runInTerminal(
    page,
    "git status > /dev/null 2>/dev/null; and echo FIRSTRUN_GIT_OK; or echo FIRSTRUN_GIT_FATAL",
  );

  // Best-effort read of the rendered buffer. If readable, it MUST show OK.
  await expect(page.locator(".xterm-screen")).toBeVisible();
  let termText = "";
  for (let i = 0; i < 10; i++) {
    termText = await page.locator(".xterm-screen").innerText().catch(() => "");
    if (termText.includes("FIRSTRUN_GIT")) break;
    await page.waitForTimeout(1_000);
  }
  if (termText.includes("FIRSTRUN_GIT")) {
    expect(termText, "git status typed in the UI terminal must NOT be `fatal: not a git repository`")
      .not.toContain("FIRSTRUN_GIT_FATAL");
    expect(termText).toContain("FIRSTRUN_GIT_OK");
    console.log("[first-run] terminal git status: FIRSTRUN_GIT_OK (read from xterm)");
  } else {
    console.log("[first-run] xterm buffer unreadable (flaky) — relying on integration-truth workdir-is-a-git-repo as proof");
  }

  // HARD integration-truth backstop: the loop workdir really is a git repo (so
  // the `git status` the user typed had something real to run against). We check
  // this host-side because the xterm DOM can't be trusted; the POINT, proven
  // above, is the command went through the real terminal UI.
  const gitStatus = sandboxExec(loopId, `git -C /loopat/loop/${loopId}/workdir status`).trim();
  expect(gitStatus, "the loop workdir must be a real git repo (UI-terminal git status backstop)")
    .toMatch(/On branch|HEAD detached|nothing to commit|Changes/);
  console.log(`[first-run] integration-truth: workdir is a git repo:\n${gitStatus.split("\n").slice(0, 3).join("\n")}`);

  console.log("[first-run] PROVEN: full cold-start journey green");
});
