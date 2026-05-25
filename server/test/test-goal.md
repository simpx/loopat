# Loopat Test Goals

This file is the **contract**, not a case list. Each goal describes what the
system must do from a user/integrator's perspective. AI (or humans) translate
each goal to executable cases at one or more levels.

## Levels

| Level | What runs | Cost | When |
|-------|-----------|------|------|
| **L1** | Pure functions, in-process | ~ms, 0 token | Every push |
| **L2** | HTTP via Hono `app.request()` (no listener) | ~100ms, 0 token | Every push |
| **L3** | Compose / bwrap argv assertions (no real spawn) | ~10ms, 0 token | Every push |
| **L3+** | Spawn-time chain end-to-end (vault → loadCfg → bwrap argv), still no real claude | ~ms, 0 token | Every push |
| **L4** | Real claude binary + provider API (gated by `LOOPAT_E2E_AI=1`) | ~15s, ~¥0.5 | Before release |

## Layout

```
server/test/
  ── core refactor (vault delivery) ─────────────────────────────────────
  vault.test.ts              L1 — loadVaultEnvs, listVaultHomeMounts
  config-vault.test.ts       L1 — expandVars, providerEnvVarName, describeApiKeyRef,
                                  writeVaultEnv, deleteVaultEnv, loadPersonalConfig
  mcp-oauth.test.ts          L1 — mcpServerEnvVarName
  bwrap-vault.test.ts        L3 — vault/mounts/home/* → bwrap --bind-try args
  spawn-composition.test.ts  L3+ — vault envs → bwrap argv chain
  api-mcp.test.ts            L2 — /api/mcp-servers, /api/mcp-auth
  api-settings.test.ts       L2 — /api/settings/personal/{disk,value}

  ── pre-existing (composition / sandbox) ────────────────────────────────
  bwrap.test.ts              L3 — composed .claude/ visibility
  compose.test.ts            L3 — tier merge
  plugin-installer.test.ts   L3 — plugin install

  ── usage scenarios & team collab ──────────────────────────────────────
  multi-user.test.ts         L1+L3 — alice vs bob isolation across vault/personal/binds
  driver-handoff.test.ts     L1+L3 — effectiveDriver, vault follows driver not creator, RFD shape
  multi-vault.test.ts        L1+L3 — multi-vault per user, selection, escape-symlink rejection
  provider-resolution.test.ts L1 — pickProvider priority order, workspace fallback, requireKey
  lifecycle-frozen.test.ts   L3 — principle 1: admin pushes don't change existing loop snapshot
  mcp-shadowing.test.ts      L2+L3 — personal mcpServer shadows team in compose + UI flagging

  ── E2E gated ──────────────────────────────────────────────────────────
  e2e-ai.test.ts             L4 — real AI reads vault env (LOOPAT_E2E_AI=1)
```

## Conventions

- **Set `LOOPAT_HOME` before importing source.** `paths.ts` captures it at module
  load. Use `??=` so test files can compose into the same bun run.
- **Pre-seed `config.json` before importing `index.ts`** in L2 tests — otherwise
  the bootstrap tries to clone the workspace's `repos[]`.
- **`PORT=0` + `LOOPAT_SERVE_PORT=0`** in L2 tests to avoid listener collisions.
- **Call `clearPersonalCache(user)` between writes** that target the same
  `(user, vault)` — the personal config cache key is mtime-based, and bun-fast
  back-to-back writes can hit the same millisecond.
- **Goals can map to multiple cases** at different levels. Cross-reference both
  ways: goal → which test file/level cover it, file → which goals each test
  asserts.

## Goal Format

```markdown
### G-CATEGORY-NN: short title

**Given**
- preconditions about world state

**When**
- the action under test

**Then**
- L?: the assertion at that level
- L?: ...

**Variations** (optional)
- "what if X also happens"

**Notes** (optional)
- known limitations / out-of-scope
```

---

## Goal Catalog

### Composition: `.claude/` tier merge

**G-COMPOSE-01: team CLAUDE.md reaches sandbox**
- **Given** `knowledge/.loopat/.claude/CLAUDE.md` contains "TEAM_MARKER"
- **When** user creates a loop (no profile, no personal CLAUDE.md)
- **Then**
  - L3 (`compose.test.ts`): composed `loops/<id>/.claude/CLAUDE.md` contains "TEAM_MARKER"

**G-COMPOSE-02: profile layers stack onto team in declared order**
- **Given** team + profile A + profile B each have a CLAUDE.md
- **When** loop spawned with profiles=[A, B]
- **Then**
  - L3: composed CLAUDE.md = team → profile A → profile B (in that order)

**G-COMPOSE-03: personal CLAUDE.md is the outermost user-tier layer**
- **Given** team + profile + personal CLAUDE.md all present
- **When** loop spawned
- **Then**
  - L3: order is team → profile(s) → personal in the composed CLAUDE.md

**G-COMPOSE-04: skills merge by name with later-wins shadowing**
- **Given** team and personal both define a skill named "foo"
- **When** loop spawned
- **Then**
  - L3: composed `skills/foo/SKILL.md` is the personal version (last-wins)
  - L3: composed `skills/` is a directory of symlinks union'd across tiers

**G-COMPOSE-05: settings.json enabledPlugins union + disable-wins**
- **Given** team enables plugin X, personal disables it
- **When** compose runs
- **Then**
  - L3: merged settings.json has X explicitly disabled (false beats true)

### Vault Delivery

**G-VAULT-01: vault/envs/<NAME> → $NAME in sandbox**
- **Given** `vaults/default/envs/GITHUB_TOKEN` contains "ghp_xxx"
- **When** loop spawns
- **Then**
  - L1 (`vault.test.ts`): `loadVaultEnvs()` returns `{GITHUB_TOKEN: "ghp_xxx"}`
  - L3+ (`spawn-composition.test.ts`): bwrap argv includes `--setenv GITHUB_TOKEN ghp_xxx`
  - L4 (`e2e-ai.test.ts`): AI's `Bash` tool can read `$GITHUB_TOKEN`

**G-VAULT-02: vault/mounts/home/<rel> → $HOME/<rel>**
- **Given** `vaults/default/mounts/home/.ssh/id_ed25519` exists
- **When** loop spawns
- **Then**
  - L1 (`vault.test.ts`): `listVaultHomeMounts()` includes `.ssh`
  - L3 (`bwrap-vault.test.ts`): bwrap argv includes `--bind-try <src> $HOME/.ssh`

**G-VAULT-03: top-level only — subdirs not separately bound**
- **Given** `mounts/home/.config/gh/` + `mounts/home/.config/a1/` both exist
- **When** loop spawns
- **Then**
  - L3: exactly ONE bind for `.config` (the whole dir), NOT separate binds for `gh` and `a1`

**G-VAULT-04: missing vault → no envs, no mounts, graceful**
- **Given** vault dir doesn't exist
- **When** loop spawns
- **Then**
  - L1: `loadVaultEnvs()` returns `{}`
  - L1: `listVaultHomeMounts()` returns `[]`
  - L3: bwrap argv has no vault-derived setenv or bind

**G-VAULT-05: multi-vault — only active vault delivered**
- **Given** vaults default + dev each have different envs
- **When** loop spawns with `meta.config.vault="dev"`
- **Then**
  - L1: `loadVaultEnvs(user, "dev")` returns only dev envs
  - L3: bwrap argv setenv reflects dev envs, not default

**G-VAULT-06: invalid env filenames are skipped**
- **Given** `envs/bad-name`, `envs/1starts_digit`, `envs/.dotfile` exist
- **When** vault envs loaded
- **Then**
  - L1: those filenames are silently ignored (no env, no error)

### Provider apiKey resolution

**G-PROV-01: ${VAR} in provider.apiKey resolves from vault envs**
- **Given** `vaults/default/envs/IDEALAB_API_KEY=sk-xxx`, config.json apiKey=`${IDEALAB_API_KEY}`
- **When** loadPersonalConfig runs
- **Then**
  - L1: `cfg.providers.idealab.apiKey === "sk-xxx"`
  - L3+: bwrap argv has `--setenv ANTHROPIC_API_KEY sk-xxx`

**G-PROV-02: missing ${VAR} → empty apiKey**
- **Given** apiKey=`${NOT_IN_VAULT}`, no matching env file
- **Then**
  - L1: `cfg.providers.X.apiKey === ""`
  - L2 (`api-mcp.test.ts`): `/api/settings/personal/disk` refExists shows kind=var, exists=false

**G-PROV-03: literal apiKey (no ${...}) passes through unchanged**
- **Given** apiKey="sk-literal-here"
- **Then**
  - L1: `cfg.providers.X.apiKey === "sk-literal-here"`
  - L2: `describeApiKeyRef` reports kind=literal

**G-PROV-04: providerEnvVarName derivation is stable across UI + server**
- **Given** provider name "DeepSeek"
- **Then**
  - L1 (server + web mirror): both yield "DEEPSEEK_API_KEY"

### MCP

**G-MCP-01: workspace mcpServer + envs/MCP_*_TOKEN → spawned binary substitutes header**
- **Given** workspace settings.json has http server with `headers.Authorization="Bearer ${MCP_COOP_TOKEN}"`,
  vault envs has `MCP_COOP_TOKEN=mcpa_xxx`
- **When** loop spawns
- **Then**
  - L3+: merged settings.json on disk preserves literal `${MCP_COOP_TOKEN}` (spawned binary expands)
  - L3+: bwrap argv has `--setenv MCP_COOP_TOKEN mcpa_xxx`
  - L4 (future): AI's `mcp__coop__*` tool call succeeds against a stub server that requires the header

**G-MCP-02: OAuth callback persists token to vault env file**
- **Given** mcp-oauth completes the auth exchange
- **When** completeMcpAuth() returns
- **Then**
  - L1: `vaults/<v>/envs/MCP_<NAME>_TOKEN` exists with the access token as content (only — no metadata sidecar)
  - L2: subsequent `GET /api/mcp-auth` reports `MCP_<NAME>_TOKEN: { connected: true }`

**G-MCP-03: DELETE /api/mcp-auth/:server removes vault env**
- **Given** vault has `MCP_GITHUB_TOKEN`
- **When** DELETE /api/mcp-auth/github
- **Then**
  - L2 (`api-mcp.test.ts`): file removed; subsequent GET shows connected=false

**G-MCP-04: GET /api/mcp-servers returns team + plugin + personal tiers**
- **Given** team settings.json defines 2 servers, no profiles, no personal MCP
- **When** GET /api/mcp-servers
- **Then**
  - L2: response has 3 tiers in order [team, plugin, personal]
  - L2: team tier surfaces the 2 servers by name + type + url

**G-MCP-05: personal entry with same name as team flags shadowsWorkspace**
- **Given** team + personal both define a server "github"
- **When** GET /api/mcp-servers
- **Then**
  - L2: personal tier's github entry has `shadowsWorkspace: true`

**G-MCP-06: mcpServerEnvVarName collisions are tolerated (not surprising)**
- **Given** server names "foo-bar" and "foo_bar"
- **Then**
  - L1: both map to same env var name; documented as expected behavior

**G-MCP-07: `/api/mcp-auth` response is keyed by env-var name (not server name)**
- **Given** vault has MCP_GITHUB_TOKEN + MCP_LINEAR_TOKEN
- **When** GET /api/mcp-auth
- **Then**
  - L2: response keys are "MCP_GITHUB_TOKEN" / "MCP_LINEAR_TOKEN", each with `{connected, varName}`
- **Notes**: UI must call `mcpServerEnvVarName(serverName)` to look up status by server name

### Settings UI contract

**G-SET-01: GET /api/settings/personal/disk never leaks resolved apiKey values**
- **Given** config.json has apiKey=`${IDEALAB_API_KEY}` and vault has actual value "sk-secret"
- **When** GET /api/settings/personal/disk
- **Then**
  - L2: response body does NOT contain "sk-secret" anywhere
  - L2: disk.providers.idealab.apiKey is the template string `"${IDEALAB_API_KEY}"`

**G-SET-02: POST /api/settings/personal/value writes vault env**
- **When** POST with `{name, value, vault}`
- **Then**
  - L2: `vaults/<vault>/envs/<name>` contains the value (with trailing newline)
  - L2: invalid name / invalid vault → 400

**G-SET-03: PUT /api/settings/personal/disk validates provider shape**
- **Given** patch with provider missing baseUrl, OR default not string
- **Then**
  - L2: 400 with error message; config.json unchanged

### CLI usability (relies on G-VAULT-02)

**G-CLI-01: gh CLI reads its config from sandbox $HOME/.config/gh/**
- **Given** vault has `mounts/home/.config/gh/{config.yml, hosts.yml}`
- **When** loop spawns, AI runs `gh auth status`
- **Then**
  - L3: bwrap argv binds `.config` correctly
  - L4 (manual): `gh auth status` exits 0 inside sandbox

**G-CLI-02: ssh-based git uses ~/.ssh/id_ed25519 from vault**
- **Given** vault has `mounts/home/.ssh/{id_ed25519, config}`
- **When** AI runs `ssh -T git@github.com`
- **Then**
  - L4 (manual): ssh succeeds (exit 1 with "Hi <user>!" message)

**G-CLI-03: git commit picks up identity from vault .gitconfig**
- **Given** vault has `mounts/home/.gitconfig` with [user] section
- **When** AI commits in workdir
- **Then**
  - L4 (manual): commit author matches .gitconfig

### Loop lifecycle

**G-LIFE-01: restart-session re-reads vault**
- **Given** loop running, user rotates MCP token (writes new envs/MCP_*_TOKEN)
- **When** POST /api/loops/:id/restart-session, then next user message
- **Then**
  - L2: endpoint returns ok
  - L3+ (future): subsequent spawn carries the NEW token in --setenv

**G-LIFE-02: principle 1 — old loop's settings/skills never change**
- **Given** loop created at time T
- **When** admin pushes new team settings.json at time T+1
- **Then**
  - L3: re-spawning the old loop still uses the snapshot from T
- **Notes**: composeLoopClaudeConfig writes once at creation; settings.json snapshot is frozen

### Isolation

**G-ISO-01: vault is NOT exposed as /loopat/context/vault directory**
- **When** any loop spawns
- **Then**
  - L3 (`bwrap-vault.test.ts`): no `--symlink` targets `/loopat/context/vault`
  - L3: bwrap module does not export `V_CONTEXT_VAULT`

**G-ISO-02: sandbox sees no host paths beyond explicitly bound ones**
- **Given** operator config has no `mounts`, vault has no `mounts/home/`
- **When** loop spawns
- **Then**
  - L3: bwrap argv only binds /usr /etc /lib /lib64 /bin /sbin /opt /var /run (RO)
    plus per-loop dirs, plus LOOPAT_INSTALL_DIR, plus ~/.claude/plugins/

**G-ISO-03: vaults are per-user (other users invisible)**
- **Given** user alice + user bob each have their own vault
- **When** alice's loop spawns
- **Then**
  - L3: only alice's personal/ is bound at /loopat/context/personal/, bob's never appears

### Doctrine

**G-DOC-01: bundled CLAUDE.md does not mention vault / mounts**
- **When** scan `server/templates/CLAUDE.md`
- **Then**
  - L1 (text grep): no occurrence of `/loopat/context/vault`, "vault", or "mount" as a concept
  - **Why**: AI should see a configured machine, not a framework. Per-user habit lives in
    `personal/<u>/.loopat/.claude/CLAUDE.md`.

### Multi-user isolation

**G-USR-01: vault contents per-user — no cross-user leak**
- **Given** alice + bob each have their own `vaults/default/envs/PRIVATE_VAR`
- **Then**
  - L1 (`multi-user.test.ts`): `loadVaultEnvs("alice")` never returns bob's keys; same-named var resolves to each owner's value

**G-USR-02: each user's provider apiKey resolves from their own vault**
- **Given** alice + bob both have provider "anthropic" with `apiKey: "${ANTHROPIC_API_KEY}"` but different vault contents
- **Then**
  - L1: `loadPersonalConfig("alice")` and `("bob")` produce different `provider.apiKey`

**G-USR-03: personal CLAUDE.md only reaches its owner's loops**
- **Given** alice has `# ALICE_DOCTRINE`, bob has `# BOB_DOCTRINE`
- **Then**
  - L3 (compose): alice's loop CLAUDE.md contains ALICE_DOCTRINE only, bob's contains BOB_DOCTRINE only

**G-USR-04: bwrap binds only the driving user's `/personal/` dir**
- **Given** alice spawns a loop, bob spawns another loop
- **Then**
  - L3: alice's bwrap argv contains `/personal/alice` binds, no `/personal/bob`; symmetric for bob

**G-USR-05: vault envs do not leak across user spawns**
- **Given** alice has `ALICE_KEY` in her vault
- **When** bob's loop spawns with `bobCfg.vaultEnvs`
- **Then**
  - L3: bob's bwrap argv does not contain "ALICE_KEY" or its value

### Driver handoff (RFD)

**G-DRIVE-01: `effectiveDriver` falls back to createdBy when driver field absent**
- **Then** L1 (`driver-handoff.test.ts`): `effectiveDriver({createdBy: "alice"}) === "alice"`

**G-DRIVE-02: driver field, when set, beats createdBy for `effectiveDriver` and `isDriver`**
- **Then** L1: `effectiveDriver({createdBy: "alice", driver: "bob"}) === "bob"`; `isDriver(meta, "alice") === false`

**G-DRIVE-03: after handoff, sandbox uses the driver's vault — not the creator's**
- **Given** alice created loop, bob now drives, both have configured apiKey
- **Then**
  - L1: `loadPersonalConfig(driver)` returns bob's resolved apiKey
  - L3: `buildBwrapArgs(loopId, "bob", ...)` binds `/personal/bob/`; no `/personal/alice/`

**G-DRIVE-04: driver's vault envs reach setenv post-handoff**
- **Then** L3: bwrap argv has bob's ANTHROPIC_API_KEY value, never alice's

**G-DRIVE-05: RFD state machine — rfdRequestedAt set + driver unchanged**
- **Then** L1: structural assertion on meta shape; UI gates writes by this field

**G-DRIVE-06: after takeover — rfd cleared, driver replaced, driverHistory appended**
- **Then** L1: last `driverHistory` entry matches `driver`

**G-DRIVE-07: pendingDriverNote — one-shot, consumed by next user message**
- **Then** L1: structural shape contract (sendUserText reads then clears)

### Multi-vault (per-loop identity selection)

**G-MVAULT-01: `listVaults` returns all user's vaults in sorted order**
- **Then** L1 (`multi-vault.test.ts`): default, dev, prod sorted alpha

**G-MVAULT-02: `isValidVaultName` rejects path-escape names**
- **Then** L1: `../escape`, `.hidden`, empty, > length cap all rejected

**G-MVAULT-03: per-loop vault selection — exclusive envs don't bleed**
- **Given** dev has `DEV_ONLY`, prod has `PROD_ONLY`
- **Then**
  - L1: `loadVaultEnvs(user, "dev")` returns DEV_ONLY but not PROD_ONLY
  - L3: bwrap argv reflects only the selected vault's envs

**G-MVAULT-04: same loop spawned with different vault → different env surface**
- **Then** L3: argvDev contains DEV_ONLY, argvProd does NOT

**G-MVAULT-05: in-vault and cross-vault symlinks within user tree are allowed**
- **Then** L1: walkVaultFiles yields targets under same user tree

**G-MVAULT-06: symlinks escaping the user tree are REJECTED**
- **Given** `vault/prod/envs/EVIL` → `/etc/passwd` (or another user's vault)
- **Then**
  - L1: walkVaultFiles silently drops; warning to stderr

### Provider resolution chain

**G-PROVCH-01: priority order — explicit > personal default > workspace default > enumeration**
- **Then** L1 (`provider-resolution.test.ts`): each tier asserted individually

**G-PROVCH-02: personal default beats workspace default**
- **Then** L1: `pickProvider({default: P}, {default: W}, [], true).name === P`

**G-PROVCH-03: workspace default is the fallback for new users (admin-seeded)**
- **Then** L1: bare personal + workspace-default → workspace wins

**G-PROVCH-04: personal providers shadow workspace under same name**
- **Then** L1: `pickProvider({providers: {foo: P}}, {providers: {foo: W}}, ["foo"], true).provider === P`

**G-PROVCH-05: `requireKey=true` skips empty-apiKey providers and walks to next**
- **Then** L1: default with no apiKey + other with apiKey → other wins under requireKey

**G-PROVCH-06: returns null when nothing matches (no provider, or all keyless under requireKey)**
- **Then** L1

**G-PROVCH-07: candidate names are deduped (no infinite loop, no redundant lookup)**
- **Then** L1: `pickProvider(cfg, {}, ["a", "a", "a"], true)` walks each unique name once

### Loop lifecycle — frozen snapshot

**G-FROZEN-01: compose materializes team CLAUDE.md + settings.json on first run**
- **Then** L3 (`lifecycle-frozen.test.ts`): contents reflect team source state

**G-FROZEN-02: admin pushes new team — existing loop snapshot unchanged**
- **Given** loop has snapshot at TEAM_V1; admin overwrites team source to TEAM_V2
- **Then** L3: reading loop's CLAUDE.md/settings.json still returns V1
- **Why**: principle 1 — "loops are frozen at creation"; session.ts only re-composes when snapshot missing

**G-FROZEN-03: a NEW loop after the push picks up the new team state**
- **Then** L3: new loop's snapshot reflects TEAM_V2

**G-FROZEN-04: re-running compose explicitly DOES regenerate (caller's choice)**
- **Then** L3: compose is "materialize current source state", not "stay frozen". Snapshot freeze is upstream gate (session.ts: only compose if absent)

**G-FROZEN-05: settings.json existence acts as the snapshot sentinel**
- **Then** L3: after compose, settings.json exists at the gate path session.ts checks

### MCP tier shadowing

**G-MCPSH-01: team tier surfaces all team-defined servers via API**
- **Then** L2 (`mcp-shadowing.test.ts`): `/api/mcp-servers` returns team servers under `tiers[id=team]`

**G-MCPSH-02: personal entry shadowing team flagged with shadowsWorkspace=true**
- **Given** team has "github", personal also has "github"
- **Then** L2: personal tier's github has `shadowsWorkspace: true`; non-shadowing entry has `false`

**G-MCPSH-03: personal entry wins over team in composed settings.json (last-wins)**
- **Then** L3: merged `loops/<id>/.claude/settings.json` `mcpServers.github` is the personal URL, NOT team

**G-MCPSH-04: shadowing is full-object replacement, not shallow merge**
- **Given** team's github has `headers: { Authorization: ... }`; personal's github has no headers
- **Then** L3: composed entry has no `headers` field (personal won wholesale, including absence)

**G-MCPSH-05: team-only server survives compose intact**
- **Given** only team defines "linear"
- **Then** L3: composed has team's full linear object

---

## Adding goals — workflow

1. Write the goal in this file. Be specific about Given/When/Then per level.
2. Find or create the test file matching the level.
3. Implement the case; mark which goal(s) it covers in a `// G-XXX-NN` comment.
4. Run `bun test` from `server/`. Iterate until green.
5. For L4, gate with `describe.skipIf(SKIP)` checking `LOOPAT_E2E_AI`.

## Open follow-ups (goals not yet covered)

- **G-COMPOSE-04 / -05** — partially covered by existing `compose.test.ts`; verify
  shadowing matches the spec.
- **G-MCP-01** L4 — need a stub MCP server fixture for full chain assertion. Currently
  only L3+ verifies the header template survives.
- **G-LIFE-01** L3+ — requires spawning twice with token rotation between. Useful for
  catching cache bugs in `loadPersonalConfig`.
- **G-CLI-01..03** L4 — manual sanity for now; could automate with a fake git server.
- **G-ISO-03** — currently implicit; explicit assertion welcomed.
