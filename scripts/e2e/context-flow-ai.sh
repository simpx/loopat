#!/usr/bin/env bash
#
# e2e scenario #3 — context flow driven by a REAL AI (idealab), over a real ssh
# remote, authenticated with the user's vault key. Black-box: drives the loop
# entirely through `npx loopat@latest` + the v1 REST API, like a real client.
#
# Proves both edges of docs/context-flow.md on a live loop:
#   ② promote — the loop's AI edits notes in the sandbox and git-pushes it;
#               it lands on the ssh remote.
#   ① pull    — an external edit to the remote is visible to the NEXT loop.
#
# NOTE on the two urls: under ROOTLESS podman a sandbox can only reach the ssh
# server by its container name (same bridge), while the host can only reach it
# by its published port (host ip) — there is no single address both can use.
# So each edge uses the address reachable from its own side, both pointing at
# the SAME bare repo. In production the ssh host has one address everyone
# reaches; this split is purely a fixture artifact.
#
# Requires: node/npx + podman (+ a running podman machine on macOS) + an idealab
# API key (IDEALAB_KEY, default: the host's dashscope vault). Safe + self-
# contained: throwaway LOOPAT_HOME + container + network, removed on exit (trap).
# Run: bash scripts/e2e/context-flow-ai.sh
set -e

IDEALAB_KEY="${IDEALAB_KEY:-$HOME/.dashscope/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY}"
[ -s "$IDEALAB_KEY" ] || { echo "FAIL: idealab key not found at $IDEALAB_KEY (set IDEALAB_KEY=...)"; exit 1; }

H=/tmp/loopat-e2e-ai-$$; P=10094; PORT=2227
WS=$(basename "$H"); NET=loopat-$WS; CTR=loopat-e2e-ai-ssh-$$
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cleanup() {
  [ -n "$SRV" ] && { pkill -P "$SRV" 2>/dev/null; kill "$SRV" 2>/dev/null; } || true
  podman ps -aq --filter "label=loopat.workspace=$WS" 2>/dev/null | xargs -r podman rm -f >/dev/null 2>&1 || true
  podman rm -f "$CTR" >/dev/null 2>&1 || true
  podman network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$H"
}
trap cleanup EXIT
SRV=""

mkdir -p "$H"
ssh-keygen -t ed25519 -N "" -f "$H/host" -q -C host
ssh-keygen -t ed25519 -N "" -f "$H/vault" -q -C vault
HKEYENV="ssh -i $H/host -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"

podman build -q -t loopat-gitssh-test "$REPO_ROOT/scripts/e2e/git-ssh-server" >/dev/null
podman network create --label "loopat.workspace=$WS" "$NET" >/dev/null
podman run -d --name "$CTR" --network "$NET" -p "$PORT:22" -e AUTHORIZED_KEY="$(cat "$H/host.pub")" loopat-gitssh-test >/dev/null
sleep 3
podman exec "$CTR" sh -c "echo '$(cat "$H/vault.pub")' >> /home/git/.ssh/authorized_keys"
podman exec "$CTR" su git -c "git init --bare -q -b main /srv/git/notes.git"

HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' | head -1)
[ -z "$HOST_IP" ] && HOST_IP=$(ipconfig getifaddr en0 2>/dev/null)   # macOS
[ -z "$HOST_IP" ] && { echo "FAIL: could not determine host ip"; exit 1; }
HOST_URL="ssh://git@$HOST_IP:$PORT/srv/git/notes.git"      # host-reachable (published port)
CTR_URL="ssh://git@$CTR/srv/git/notes.git"                 # sandbox-reachable (container name)

# seed (host key, host url)
export GIT_SSH_COMMAND="$HKEYENV"
git clone -q "$HOST_URL" "$H/seed"
( cd "$H/seed" && echo seed > SEED.md && git -c user.email=h@x -c user.name=h add -A && git -c user.email=h@x -c user.name=h commit -qm seed && git push -q origin HEAD:main )
unset GIT_SSH_COMMAND

# workspace: idealab provider + vault key + host config (display-clone, host url)
mkdir -p "$H/personal/simpx/.loopat/vaults/default/envs" "$H/personal/simpx/.loopat/vaults/default/mounts/home/.ssh"
cp "$IDEALAB_KEY" "$H/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY"
cp "$H/vault" "$H/personal/simpx/.loopat/vaults/default/mounts/home/.ssh/id"; chmod 600 "$H/personal/simpx/.loopat/vaults/default/mounts/home/.ssh/id"
printf '{"knowledge":{"git":""},"notes":{"git":"%s"},"providers":{},"repos":[]}\n' "$HOST_URL" > "$H/config.json"

GIT_SSH_COMMAND="$HKEYENV" LOOPAT_HOME="$H" PORT="$P" npx -y loopat@latest > "$H/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 90); do curl -fsS "localhost:$P/api/auth/me" >/dev/null 2>&1 && break; sleep 1; done
echo "server up"
curl -fsS -c "$H/cj" -X POST "localhost:$P/api/auth/register" -H 'content-type: application/json' -d '{"username":"simpx","password":"test1234"}' >/dev/null

# write personal config with a given notes url (idealab provider stays fixed)
set_notes_url() {
  python3 - "$1" "$H/personal/simpx/.loopat/config.json" <<'PY'
import json,sys
url, path = sys.argv[1], sys.argv[2]
json.dump({"providers":{"default":"idealab/claude-opus-4-7","idealab":{"baseUrl":"https://idealab.alibaba-inc.com/api/anthropic","models":[{"id":"claude-opus-4-7","enabled":True}],"apiKey":"${IDEALAB_API_KEY}","enabled":True}},"notes":{"git":url}}, open(path,"w"))
PY
}
api() { curl -fsS -H "authorization: Bearer $TOK" "$@"; }
TOK=$(curl -fsS -b "$H/cj" -X POST "localhost:$P/api/v1/me/tokens" -H 'content-type: application/json' -d '{"label":"e2e"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# ── ② promote: loop A's AI edits notes + pushes (sandbox → container-name url) ──
set_notes_url "$CTR_URL"
LA=$(api -X POST "localhost:$P/api/v1/loops" -H 'content-type: application/json' -d '{"title":"writer"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
body=$(python3 -c "import json;print(json.dumps({'content':'In the directory /loopat/context/notes, create a file named ai-note.md whose only content is the line: AI WAS HERE. Then publish it by running exactly: cd /loopat/context/notes && git add -A && git -c user.email=ai@loopat -c user.name=ai commit -m \\'ai note\\' && git push origin HEAD:main . Then report whether the push succeeded.','permission_mode':'bypassPermissions'}))")
api -N -X POST "localhost:$P/api/v1/loops/$LA/messages" -H 'content-type: application/json' -d "$body" --max-time 540 >/dev/null 2>&1 || true
export GIT_SSH_COMMAND="$HKEYENV"
rm -rf "$H/v"; git clone -q "$HOST_URL" "$H/v" 2>/dev/null || true
unset GIT_SSH_COMMAND
PROMOTE=$([ -f "$H/v/ai-note.md" ] && grep -q "AI WAS HERE" "$H/v/ai-note.md" && echo ok || echo fail)

# ── ① pull: external edit (host url) → next loop B's worktree sees it ──
set_notes_url "$HOST_URL"
export GIT_SSH_COMMAND="$HKEYENV"
( cd "$H/v" && echo "EXTERNAL EDIT" > external.md && git -c user.email=x@x -c user.name=x add -A && git -c user.email=x@x -c user.name=x commit -qm ext && git push -q origin HEAD:main )
unset GIT_SSH_COMMAND
LB=$(api -X POST "localhost:$P/api/v1/loops" -H 'content-type: application/json' -d '{"title":"reader"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
UB=${LB#loop_}
PULL=$([ -f "$H/loops/$UB/context/notes/external.md" ] && echo ok || echo fail)

echo "  $([ "$PROMOTE" = ok ] && echo '✓' || echo '✗') ② promote: AI's notes edit reached the ssh remote ($PROMOTE)"
echo "  $([ "$PULL" = ok ] && echo '✓' || echo '✗') ① pull: external edit visible in the next loop ($PULL)"
[ "$PROMOTE" = ok ] && [ "$PULL" = ok ] && echo "PASS — real-AI context flow works both ways over ssh with the vault key." || { echo FAIL; exit 1; }
