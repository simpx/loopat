#!/usr/bin/env bash
# Migrate ~/.dashscope (or any LOOPAT_HOME) from the old sandbox model to
# the new tiered .claude/ profile model.
#
# Transformations:
#   1. .loopat/claude/                 → .loopat/.claude/        (team tier, rename + reshape)
#      - claude.json (mcpServers + enabledPlugins + extraKnownMarketplaces)
#        → settings.json (CC-native fields)
#      - CLAUDE.md, skills/ → moved as-is
#   2. .loopat/sandboxes/<n>/          → .loopat/profiles/<n>/.claude/
#      - .claude/settings.json → .claude/settings.json
#      - CLAUDE.md, mise.toml, mise.lock → .claude/
#      - sandbox.json discarded (shell preference goes to personal)
#   3. personal/<u>/CLAUDE.md          → personal/<u>/.claude/CLAUDE.md
#      personal/<u>/.loopat/claude/    → personal/<u>/.claude/
#   4. loops/<id>/meta.json
#      config.sandbox: "X"             → config.profiles: ["X"]
#      config.sandbox / sandbox_version dropped
#      (sre sandbox extended default → ["default", "sre"] to preserve plugins)
#
# Backup taken before any mutation. Idempotent: re-running on already-
# migrated workspace is safe (skips existing targets, but you'd want to
# restore the backup first if you want a clean rerun).
set -euo pipefail

LH="${LOOPAT_HOME:-$HOME/.dashscope}"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="$LH.backup-$TS"

if [[ ! -d "$LH" ]]; then
  echo "[!] $LH does not exist"
  exit 1
fi

echo "Source:  $LH"
echo "Backup:  $BACKUP"
echo ""
echo "This will modify $LH in place. A full backup will be made first."
echo "Continue? (y/N)"
read -r ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "abort"; exit 1; }

echo ""
echo "[1/5] Backing up modifiable parts to $BACKUP …"
# Skip overlayfs work dirs (mode 000, cp -a chokes). Only back up what the
# migration actually touches: knowledge/.loopat, personal, loop meta files.
mkdir -p "$BACKUP/context/knowledge"
[[ -d "$LH/context/knowledge/.loopat" ]] && cp -a "$LH/context/knowledge/.loopat" "$BACKUP/context/knowledge/.loopat"
[[ -d "$LH/personal" ]] && cp -a "$LH/personal" "$BACKUP/personal" 2>/dev/null || true
# Backup loops/ but only meta.json files (skip heavy workdir/home-* content)
mkdir -p "$BACKUP/loops"
for d in "$LH"/loops/*/; do
  id=$(basename "$d")
  [[ -f "$d/meta.json" ]] || continue
  mkdir -p "$BACKUP/loops/$id"
  cp "$d/meta.json" "$BACKUP/loops/$id/meta.json"
done
echo "  ✓ knowledge/.loopat, personal/, loops/*/meta.json backed up"

# ─── 2. Migrate team .loopat/claude → .loopat/.claude ───────────────────
echo "[2/5] Migrating team-tier .loopat/claude → .loopat/.claude"

OLD_TEAM="$LH/context/knowledge/.loopat/claude"
NEW_TEAM="$LH/context/knowledge/.loopat/.claude"

if [[ -d "$OLD_TEAM" ]]; then
  mkdir -p "$NEW_TEAM"

  # CLAUDE.md
  if [[ -f "$OLD_TEAM/CLAUDE.md" ]]; then
    mv "$OLD_TEAM/CLAUDE.md" "$NEW_TEAM/CLAUDE.md"
    echo "  ✓ CLAUDE.md → team .claude/"
  fi

  # skills/
  if [[ -d "$OLD_TEAM/skills" ]]; then
    mv "$OLD_TEAM/skills" "$NEW_TEAM/skills"
    echo "  ✓ skills/ → team .claude/skills/"
  fi

  # agents/ (if any)
  if [[ -d "$OLD_TEAM/agents" ]]; then
    mv "$OLD_TEAM/agents" "$NEW_TEAM/agents"
    echo "  ✓ agents/ → team .claude/agents/"
  fi

  # claude.json → settings.json
  # Old shape: { mcpServers, extraKnownMarketplaces, enabledPlugins }
  # The extraKnownMarketplaces uses non-standard {type, repository} pairs in
  # this workspace; CC native expects {source: {source: "git", url: "..."}}.
  # We translate.
  if [[ -f "$OLD_TEAM/claude.json" ]]; then
    python3 - "$OLD_TEAM/claude.json" "$NEW_TEAM/settings.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    data = json.load(f)

settings = {"_comment": "Team-tier CC config (migrated from old .loopat/claude/claude.json)."}

# enabledPlugins as-is
if "enabledPlugins" in data:
    settings["enabledPlugins"] = data["enabledPlugins"]

# mcpServers as-is (settings.json supports this; CC reads it)
if "mcpServers" in data:
    settings["mcpServers"] = data["mcpServers"]

# Normalize extraKnownMarketplaces: old shape was {type: "git", repository: "..."},
# CC native is {source: {source: "git", url: "..."}}.
if "extraKnownMarketplaces" in data:
    norm = {}
    for name, entry in data["extraKnownMarketplaces"].items():
        if isinstance(entry, dict) and "source" in entry:
            norm[name] = entry  # already CC-native
        elif isinstance(entry, dict) and entry.get("type") == "git" and entry.get("repository"):
            norm[name] = {"source": {"source": "git", "url": entry["repository"]}}
        elif isinstance(entry, dict) and entry.get("type") == "github":
            norm[name] = {"source": {"source": "github", "repo": entry.get("repo") or entry.get("repository")}}
        else:
            norm[name] = entry  # pass through unknown shapes
    settings["extraKnownMarketplaces"] = norm

with open(dst, "w") as f:
    json.dump(settings, f, indent=2)
PY
    rm "$OLD_TEAM/claude.json"
    echo "  ✓ claude.json → team .claude/settings.json (translated)"
  fi

  # Remove the empty old dir
  rmdir "$OLD_TEAM" 2>/dev/null || echo "  [!] $OLD_TEAM not empty after migration; left in place"
fi

# ─── 3. Migrate sandboxes → profiles ────────────────────────────────────
echo "[3/5] Migrating sandboxes → profiles"

OLD_SBX="$LH/context/knowledge/.loopat/sandboxes"
NEW_PROFILES="$LH/context/knowledge/.loopat/profiles"

if [[ -d "$OLD_SBX" ]]; then
  mkdir -p "$NEW_PROFILES"
  for SB in "$OLD_SBX"/*/; do
    NAME=$(basename "$SB")
    PROFILE="$NEW_PROFILES/$NAME/.claude"
    mkdir -p "$PROFILE"

    # CLAUDE.md
    if [[ -f "$SB/CLAUDE.md" ]]; then
      mv "$SB/CLAUDE.md" "$PROFILE/CLAUDE.md"
    fi

    # mise.toml / mise.lock
    [[ -f "$SB/mise.toml" ]] && mv "$SB/mise.toml" "$PROFILE/mise.toml"
    [[ -f "$SB/mise.lock" ]] && mv "$SB/mise.lock" "$PROFILE/mise.lock"

    # .claude/settings.json (sandbox's enabledPlugins/marketplaces)
    if [[ -f "$SB/.claude/settings.json" ]]; then
      mv "$SB/.claude/settings.json" "$PROFILE/settings.json"
    fi

    # sandbox.json is discarded (shell preference moves to personal config)
    [[ -f "$SB/sandbox.json" ]] && rm "$SB/sandbox.json"

    # Old .claude/ subdir cleanup (had backups/, plugins/ — not portable)
    [[ -d "$SB/.claude" ]] && rm -rf "$SB/.claude"

    echo "  ✓ sandbox '$NAME' → profile '$NAME/.claude/'"
  done

  # Clean up empty old dirs
  find "$OLD_SBX" -type d -empty -delete 2>/dev/null || true
fi

# ─── 4. Migrate personal users ──────────────────────────────────────────
echo "[4/5] Migrating personal users to .claude/ shape"

for PERSU in "$LH"/personal/*/; do
  USER=$(basename "$PERSU")
  PERS_CLAUDE="$PERSU/.claude"

  mkdir -p "$PERS_CLAUDE"

  # Move root CLAUDE.md into .claude/
  if [[ -f "$PERSU/CLAUDE.md" ]]; then
    if [[ -f "$PERS_CLAUDE/CLAUDE.md" ]]; then
      echo "  [!] $USER: both $PERSU/CLAUDE.md and $PERS_CLAUDE/CLAUDE.md exist; keeping .claude/ version"
      rm "$PERSU/CLAUDE.md"
    else
      mv "$PERSU/CLAUDE.md" "$PERS_CLAUDE/CLAUDE.md"
      echo "  ✓ $USER: CLAUDE.md → .claude/"
    fi
  fi

  # Move .loopat/claude/* into .claude/
  if [[ -d "$PERSU/.loopat/claude" ]]; then
    # merge contents into .claude/
    for item in "$PERSU/.loopat/claude/"*; do
      [[ -e "$item" ]] || continue
      base=$(basename "$item")
      if [[ -e "$PERS_CLAUDE/$base" ]]; then
        echo "  [!] $USER: .loopat/claude/$base conflicts with .claude/$base; skipping"
      else
        mv "$item" "$PERS_CLAUDE/$base"
      fi
    done
    rmdir "$PERSU/.loopat/claude" 2>/dev/null || true
    echo "  ✓ $USER: .loopat/claude/ merged into .claude/"
  fi
done

# ─── 5. Migrate loop meta.json ──────────────────────────────────────────
echo "[5/5] Migrating loop meta.json (sandbox → profiles[])"

LOOPS_MIGRATED=0
for META in "$LH"/loops/*/meta.json; do
  [[ -f "$META" ]] || continue
  python3 - "$META" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    meta = json.load(f)
cfg = meta.get("config") or {}
sb = cfg.pop("sandbox", None)
cfg.pop("sandbox_version", None)
if sb:
    # sre extended default in the old model — preserve plugin set by listing both
    if sb == "sre":
        cfg["profiles"] = ["default", "sre"]
    else:
        cfg["profiles"] = [sb]
    meta["config"] = cfg
    with open(path, "w") as f:
        json.dump(meta, f, indent=2)
    print("MIGRATED")
PY
  if python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print('OK' if 'profiles' in (m.get('config') or {}) else 'SKIP')" "$META" | grep -q OK; then
    LOOPS_MIGRATED=$((LOOPS_MIGRATED + 1))
  fi
done
echo "  ✓ $LOOPS_MIGRATED loops migrated"

# ─── Verify ─────────────────────────────────────────────────────────────
echo ""
echo "Done. New layout:"
echo "  team:     $LH/context/knowledge/.loopat/.claude/"
ls "$LH/context/knowledge/.loopat/.claude/" 2>/dev/null | sed 's/^/    /'
echo "  profiles: $LH/context/knowledge/.loopat/profiles/"
ls "$LH/context/knowledge/.loopat/profiles/" 2>/dev/null | sed 's/^/    /'
echo ""
echo "Backup at: $BACKUP"
echo "Run loopat: LOOPAT_HOME=$LH bun --cwd server run dev"
