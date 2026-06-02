# repos-page — manage the personal repo roster

A highest-fidelity e2e journey (real browser → real backend → isolated
`LOOPAT_HOME` on disk). Unlike `first-5-minutes`, it spends **no AI tokens** —
there is no chat turn, no sandbox container. It exercises the repo-roster page
and verifies persistence end to end.

## What it regresses

The **repos-are-personal** redesign: the repo roster no longer lives in the
knowledge repo. It lives in `personal/<user>/.loopat/config.json` and is read /
written via `GET` / `PUT /api/context/repos` (server) — surfaced by the
`ReposPane` on the `/context/repos` page (`web/src/pages/ContextPage.tsx`).

The bugs this catches:
- the page shows **empty** (roster read from the wrong place);
- a Save that **doesn't persist** (writes nowhere, or to the wrong file);
- a Save that **clobbers the rest of personal config** (e.g. wipes the
  `providers` block) by overwriting the whole file instead of patching `repos`.

## Flow

1. Arrive logged in via `storageState` → `/context/repos`. The preconfigured
   `roster1` entry (seeded in `dogfood/setup.ts`) is already listed.
2. Add a second entry through the real UI: **+ add repo** → fill `name` =
   `roster2` and the git url of the second fixture bare repo
   (`ssh://git@<hostIp>:<sshdPort>/srv/git/roster2.git`) → **Save**.
3. **Reload** the page; assert `roster2` still shows (read back via `GET`, not
   from in-memory state).
4. **Integration truth**: read `personal/<user>/.loopat/config.json` off the
   test `LOOPAT_HOME` (path from `dogfood/.test-meta.json` → `loopatHome`; the
   user id is the single dir under `personal/`) and assert:
   - both `roster1` and `roster2` are present, with `roster2`'s git url;
   - the unrelated `providers.idealab` block survived the PUT (no clobber).

## Assertions

Behavioral + integration truth, never screenshots:
- the preconfigured roster1 is listed on load;
- the Save fires a real `PUT /api/context/repos` carrying both repos;
- after a full page reload the new entry is still rendered;
- the on-disk personal `config.json` contains both repos with the right url;
- the providers block was preserved by the partial save.

## Fixtures

Shares the `first-5-minutes/fixtures` image. `seed.sh` creates a second bare
repo `roster2.git` (alongside `knowledge` / `notes` / `roster1`) so the journey
can register a real, distinct repo. No real credentials — the ssh keypair is
generated fresh per run in `setup.ts`.

## Run

```sh
export IDEALAB_API_KEY=$(cat ~/.loopat/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY)
bunx playwright test --config dogfood/playwright.config.ts dogfood/repos-page/journey.spec.ts
```

(`IDEALAB_API_KEY` is required by the shared harness preconditions even though
this case never calls AI — `setup.ts` writes it into the vault for the onboarded
provider config.)
