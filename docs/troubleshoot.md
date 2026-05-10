# Troubleshooting

If chat doesn't work or the UI shows red errors, walk this list top-to-bottom. Most issues land in §1 or §2.

## 0. The bootstrap banner is the first signal

Whatever's wrong, look at the banner `bun run dev` prints first:

```
────────────────────────────────────────────────────────────
  loopat bootstrap — loopat (user=alice)
────────────────────────────────────────────────────────────
  ✓  workspace: /home/alice/.loopat
  ✓  doctrine: knowledge/loopat/CLAUDE.md
  ✓  knowledge: git@…/loopat-knowledge.git
  ✓  notes:     git@…/loopat-notes.git
  ✓  repos:     loopat
  ✓  config: /home/alice/.loopat/config.json
  ✓  bwrap (sandbox)
  ✓  claude binary (@anthropic-ai/claude-agent-sdk-linux-x64/claude)
  ✓  apiKey (openai)
```

Any `✗` line tells you exactly what to fix. Hint after the bar gives the command/path.

---

## 1. "Claude code process exited with code 1"

This is the most common runtime error. Pops up in the UI as a red `⚠️ Claude code process exited with code 1` and the chat doesn't progress.

### What it means

loopat doesn't talk to the Anthropic API directly — the SDK spawns the `claude` CLI binary as a subprocess (wrapped in `bwrap`). The error means that subprocess died.

```
loopat server
  └─ @anthropic-ai/claude-agent-sdk
       └─ spawn: bwrap … -- /path/to/claude …      ← this exited non-zero
```

### Diagnose

The server pipes the child's stderr to its own stdout. Look at the terminal running `bun run dev` for lines tagged `[sdk:<id>:stderr]`:

```
[sdk:abcd1234:stderr] bwrap: Can't bind mount …
[sdk:abcd1234] child exited code=1
```

That's the actual error. If you want to see the full spawn command too:

```sh
LOOPAT_DEBUG_SPAWN=1 bun run dev
```

prints the full `bwrap …` argv on every spawn. Copy it, run by hand to reproduce outside the SDK loop.

### Common causes (by probability)

1. **`bwrap` not installed.** Linux only — `sudo apt install bubblewrap`. The bootstrap banner catches this with `✗ bwrap (sandbox)` so you should have noticed earlier.

2. **API key / baseUrl wrong.** `~/.loopat/config.json` → `providers.<active>.apiKey` or `baseUrl` is empty / typo'd. Stderr usually shows `401 Unauthorized` or `connection refused` / `getaddrinfo`.

3. **Claude binary architecture mismatch.** `bun install` ships a platform-specific package (`@anthropic-ai/claude-agent-sdk-linux-{x64,arm64}`, optionally `-musl`). If yours doesn't match the host you'll get `cannot execute binary file` or `No such file or directory` (loader confusion). Run the binary directly to confirm:

   ```sh
   path-from-banner --version
   ```

4. **Broken `personal-deps` symlinks.** `personal/<user>/secrets/*` symlinks get re-bound into the sandbox at their `$HOME` target. If a target doesn't exist, bwrap aborts.

   ```sh
   find ~/.loopat/personal/*/secrets -xtype l
   # any output = broken symlink → delete it
   ```

5. **`/tmp` permission weirdness on shared hosts.** bwrap needs `/tmp` writable. If your `/tmp` is mounted noexec or has restrictive permissions, spawn can fail.

---

## 2. Bootstrap-time problems

### `✗ bwrap (sandbox)`

```sh
sudo apt install bubblewrap
```

Linux-only. macOS / Windows isn't supported (no equivalent userns sandbox).

### `✗ claude binary`

Run `bun install` again from the loopat repo root. The platform packages aren't optional deps — they should always install. If they didn't:

```sh
bun pm ls | grep claude-agent-sdk
```

Check the platform-specific one is present. If not, you may need `bun install --force`.

### `✗ apiKey (<provider>)`

Edit `~/.loopat/config.json`:

```json
{
  "default": "openai",
  "providers": {
    "openai": { "model": "...", "baseUrl": "...", "apiKey": "PASTE_HERE" }
  }
}
```

Restart `bun run dev`. The banner re-checks on every restart.

### `clone failed (…) → falling back to empty dir`

Knowledge or notes had a `git` URL but the clone failed (no SSH key, repo private, network). Fix one of:
- Switch SSH `git@…` URL to HTTPS `https://…` if the repo is public
- Add your SSH key to GitHub and `ssh -T git@github.com` to verify
- Leave the URL empty (`""`) to skip clone and use a local-only dir

After fixing, delete the empty dir and restart so bootstrap re-tries the clone:

```sh
rmdir ~/.loopat/context/knowledge   # or notes
```

---

## 3. Web UI issues

### "ECONNREFUSED 127.0.0.1:7787" in vite log

Startup race — vite (5173) is up, server (7787) is still booting. Errors stop within 1–2 seconds. Refresh the page. See "Why" in the README.

### Loops list is empty after upgrading

You probably had `~/.loopat/<workspace-name>/` from an older nested layout. Check `/api/health` — if `workspace` doesn't match what's actually on disk, restart the server (running process holds stale paths from before the rename).

### Two of every user message

Already fixed (commit `5b878c0`). If you still see it, your dev server is running an old build — `Ctrl+C`, re-run `bun run dev`.

### Big blank space right after submitting

Already filtered (commit `41f0153`) — empty assistant placeholders no longer render. Same fix as above: restart the dev server.

---

## 4. Where to look for logs

| Where | What |
|---|---|
| Terminal running `bun run dev` | Bootstrap banner, `[sdk:<id>:stderr]` lines, child exit codes, server-side errors |
| Browser devtools console | Web errors, ws connect/close events, vite proxy errors |
| `~/.loopat/loops/<id>/messages.jsonl` | Persistent transcript per loop. Replays on attach. |
| `/api/health` | Sanity check — current workspace + LOOPAT_HOME |

**Verbose logging**

```sh
LOOPAT_DEBUG=1 bun run dev
```

prints, per loop session:
- resolved provider / model / baseUrl / apiKey-length
- full bwrap argv (one line per spawn)
- spawned PID
- every line of child stderr (`[sdk:<id>:stderr] ...`)
- every line of child stdout (capped, `[sdk:<id>:stdout] ...`)
- every SDK message type passing through (`[sdk:<id>] msg <type>`)
- exit code + signal

Plus, **always** (even without `LOOPAT_DEBUG`), child stderr is teed to `~/.loopat/loops/<id>/stderr.log`. So even if the terminal eats output (bun's filter multiplexer truncates, paste tools elide, etc.), this file has the full unfiltered text. After a code-1 exit the server log points at this file:

```
[sdk:abcd1234] child exited code=1; full stderr at /home/alice/.loopat/loops/<id>/stderr.log
```
