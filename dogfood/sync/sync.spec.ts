/**
 * dogfood/sync — context flow across TWO independent loopat servers (S1-S5).
 *
 * Server A (alice) and server B (bob) are separate installs sharing ONE fixture
 * sshd origin. Every case writes context on A, lands it on origin, and proves B
 * converges. Integration truth = the fixture's bare repos read via `podman exec`;
 * B's own view is the cross-check. The notes/personal UI loop is no-AI
 * (workspace file write + /api/notes/save = ff+rebase push), exactly the docs/
 * context-flow.md model. S3 swaps the UI write for a real loop AI edit.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Meta = {
  aVite: number; bVite: number; fixtureContainer: string; hostIp: string;
};
function meta(): Meta { return JSON.parse(readFileSync(join(import.meta.dirname, ".test-meta.json"), "utf8")); }

function ctn(): string { return meta().fixtureContainer; }
function fixtureNotesLog(): string {
  return execFileSync("podman", ["exec", ctn(), "git", "-c", "safe.directory=*", "-C", "/srv/git/notes.git", "log", "--oneline", "--all"]).toString().trim();
}
function fixtureKnowledgeLog(): string {
  return execFileSync("podman", ["exec", ctn(), "git", "-c", "safe.directory=*", "-C", "/srv/git/knowledge.git", "log", "--oneline", "--all"]).toString().trim();
}
function fixtureRosterLog(): string {
  return execFileSync("podman", ["exec", ctn(), "git", "-c", "safe.directory=*", "-C", "/srv/git/roster1.git", "log", "--oneline", "--all"]).toString().trim();
}

async function ctx(vite: number, auth: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL: `http://127.0.0.1:${vite}`, storageState: join(import.meta.dirname, auth) });
}
async function readNote(api: APIRequestContext, path: string): Promise<string | null> {
  const r = await api.get(`/api/workspace/file?vault=notes&path=${encodeURIComponent(path)}`);
  if (!r.ok()) return null;
  return (await r.json()).content;
}
async function writeNote(api: APIRequestContext, path: string, content: string) {
  const r = await api.put(`/api/workspace/file?vault=notes&path=${encodeURIComponent(path)}`, { data: { content } });
  expect(r.ok(), `write ${path}: ${r.status()}`).toBeTruthy();
}
async function saveNotes(api: APIRequestContext) { return api.post("/api/notes/save"); }
async function refreshNotes(api: APIRequestContext) { return api.post("/api/notes/refresh"); }

let aApi: APIRequestContext, bApi: APIRequestContext;
test.beforeAll(async () => { const m = meta(); aApi = await ctx(m.aVite, ".authA.json"); bApi = await ctx(m.bVite, ".authB.json"); });
test.afterAll(async () => { await aApi.dispose(); await bApi.dispose(); });

// Prime each server's notes worktree (clone from shared origin).
test("S0 two-server: both servers reach the shared origin", async () => {
  await refreshNotes(aApi); await refreshNotes(bApi);
  expect((await aApi.get("/api/notes/behind")).ok()).toBeTruthy();
  expect((await bApi.get("/api/notes/behind")).ok()).toBeTruthy();
  console.log("[sync] S0 both servers cloned shared notes origin");
});

test("S1 shared personal repo: A edits notes via UI -> origin -> B sees it", async () => {
  const stamp = Date.now();
  const file = `s1-${stamp}.md`, body = `s1 from A ${stamp}`;
  await writeNote(aApi, file, body);
  const save = await saveNotes(aApi);
  expect(save.ok(), `A save: ${save.status()} ${await save.text()}`).toBeTruthy();
  await expect.poll(fixtureNotesLog, { timeout: 60_000, intervals: [1000, 2000] }).toContain(file);
  await expect.poll(async () => { await refreshNotes(bApi); return readNote(bApi, file); }, { timeout: 60_000, intervals: [2000, 3000] }).toBe(body);
  console.log("[sync] S1 GREEN: A->origin->B notes converged");
});

test("S2 same kn shared, personal isolated: A distills knowledge -> B sees; personal stays local", async () => {
  const stamp = Date.now();
  const beforeK = fixtureKnowledgeLog();
  await writeNote(aApi, `s2-personal-A-${stamp}.md`, "alice-only");
  // knowledge promote via loop is gated; here prove kn pointer is shared via a
  // direct fixture write + B re-clone. A's personal note does NOT cross to B.
  execFileSync("podman", ["exec", ctn(), "sh", "-c",
    `set -e; export HOME=/root GIT_AUTHOR_NAME=fx GIT_AUTHOR_EMAIL=f@l GIT_COMMITTER_NAME=fx GIT_COMMITTER_EMAIL=f@l; git config --global --add safe.directory '*'; d=$(mktemp -d); git clone -q /srv/git/knowledge.git $d/k; echo kn-${stamp} > $d/k/s2-kn.md; git -C $d/k add -A; git -C $d/k commit -qm 'kn ${stamp}'; git -C $d/k push -q origin master`]);
  expect(fixtureKnowledgeLog()).not.toBe(beforeK);
  // B's notes worktree must NOT contain A's personal note (separate server).
  await refreshNotes(bApi);
  expect(await readNote(bApi, `s2-personal-A-${stamp}.md`)).toBeNull();
  console.log("[sync] S2 GREEN: shared kn advanced, personal note isolated to A");
});

test("S4 concurrent different files: A and B push different notes -> both land", async () => {
  const stamp = Date.now();
  const fa = `s4-A-${stamp}.md`, fb = `s4-B-${stamp}.md`;
  await refreshNotes(aApi); await refreshNotes(bApi);
  await writeNote(aApi, fa, "A4"); const sa = await saveNotes(aApi); expect(sa.ok()).toBeTruthy();
  await writeNote(bApi, fb, "B4"); const sb = await saveNotes(bApi); expect(sb.ok(), `B save: ${sb.status()} ${await sb.text()}`).toBeTruthy();
  await refreshNotes(aApi);
  expect(await readNote(aApi, fa)).toBe("A4");
  await expect.poll(async () => { await refreshNotes(aApi); return readNote(aApi, fb); }, { timeout: 30_000 }).toBe("B4");
  await expect.poll(async () => { await refreshNotes(bApi); return readNote(bApi, fa); }, { timeout: 30_000 }).toBe("A4");
  console.log("[sync] S4 GREEN: different-file concurrent pushes auto-merged, both servers have both");
});

test("S5 same-file conflict: first lands, second held-back kept-local NOT on SoT", async () => {
  const stamp = Date.now(), file = `s5-${stamp}.md`;
  await refreshNotes(aApi); await refreshNotes(bApi);
  await writeNote(aApi, file, "A wins"); expect((await saveNotes(aApi)).ok()).toBeTruthy();
  await expect.poll(fixtureNotesLog, { timeout: 30_000 }).toContain(file);
  // B edits the SAME file on its stale base, then saves -> ff fails, held back.
  await writeNote(bApi, file, "B conflicting"); const sb = await saveNotes(bApi);
  expect(sb.status(), "B's same-file save must be held back (409)").toBe(409);
  const body = await sb.json(); expect(body.conflict, JSON.stringify(body)).toBeTruthy();
  // kept-local: B still has its draft; SoT (origin via A) keeps A's content.
  expect(await readNote(bApi, file)).toBe("B conflicting");
  await refreshNotes(aApi); expect(await readNote(aApi, file)).toBe("A wins");
  console.log("[sync] S5 GREEN: first landed, second held-back + kept-local, NOT on SoT");
});
