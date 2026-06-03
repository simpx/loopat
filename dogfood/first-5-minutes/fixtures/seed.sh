#!/bin/sh
# Run inside the fixture container after start: install the loop's public key,
# create bare repos, seed knowledge with .loopat/config.json.
#   arg1 = loop pubkey (may be empty on a first-run seed).
#   arg2 = absolute ssh base for the notes pointer, e.g.
#          `ssh://git@<hostIp>:<sshdPort>`. The notes pointer lives in the
#          knowledge repo's .loopat/config.json and is consumed by BOTH
#          first-5-minutes and first-run; an env-specific Host alias resolves in
#          only one vault config, so we write the env-agnostic ABSOLUTE url here.
#          The host-side caller knows the published port; this script (running
#          inside the container) does not, so it must be passed in.
set -e
PUBKEY="$1"
NOTES_SSH_BASE="$2"
if [ -z "$NOTES_SSH_BASE" ]; then
  echo "seed.sh: missing arg2 (absolute ssh base for the notes pointer)" >&2
  exit 1
fi
echo "$PUBKEY" > /home/git/.ssh/authorized_keys
chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@local
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@local
for r in knowledge notes roster1 roster2; do
  git init --bare -q "/srv/git/$r.git"
  git -C "/srv/git/$r.git" config receive.denyCurrentBranch updateInstead
done
# seed knowledge with notes pointer; roster1 with a file
work=$(mktemp -d)
git clone -q /srv/git/knowledge.git "$work/k"
mkdir -p "$work/k/.loopat"
printf '{\n  "notes": { "git": "%s/srv/git/notes.git" }\n}\n' "$NOTES_SSH_BASE" > "$work/k/.loopat/config.json"
git -C "$work/k" add -A && git -C "$work/k" commit -qm init && git -C "$work/k" push -q origin master
# notes needs at least one commit so `git ls-remote --exit-code HEAD` succeeds
# (an empty bare repo has no HEAD — the onboarding ssh-access probe checks HEAD).
git clone -q /srv/git/notes.git "$work/n" && echo "# notes" > "$work/n/README.md"
git -C "$work/n" add -A && git -C "$work/n" commit -qm init && git -C "$work/n" push -q origin master
git clone -q /srv/git/roster1.git "$work/r" && echo hello > "$work/r/README.md"
git -C "$work/r" add -A && git -C "$work/r" commit -qm init && git -C "$work/r" push -q origin master
git clone -q /srv/git/roster2.git "$work/r2" && echo hello2 > "$work/r2/README.md"
git -C "$work/r2" add -A && git -C "$work/r2" commit -qm init && git -C "$work/r2" push -q origin master
chown -R git:git /srv/git
# Make the bare repos reachable via a home-relative ssh url too. The clients
# use `git@host:<name>.git`, which over ssh resolves relative to git's HOME
# (/home/git), not /srv/git — without these links the clone fails with
# "does not appear to be a git repository".
for r in knowledge notes roster1 roster2; do
  ln -sfn "/srv/git/$r.git" "/home/git/$r.git"
done
chown -h git:git /home/git/*.git
echo "seeded"
