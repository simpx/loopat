#!/bin/sh
# Run inside the fixture container after start: install the loop's public key,
# create bare repos, seed knowledge with .loopat/config.json. arg1 = pubkey.
set -e
PUBKEY="$1"
echo "$PUBKEY" > /home/git/.ssh/authorized_keys
chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@local
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@local
for r in knowledge notes roster1; do
  git init --bare -q "/srv/git/$r.git"
  git -C "/srv/git/$r.git" config receive.denyCurrentBranch updateInstead
done
# seed knowledge with notes pointer; roster1 with a file
work=$(mktemp -d)
git clone -q /srv/git/knowledge.git "$work/k"
mkdir -p "$work/k/.loopat"
printf '{\n  "notes": { "git": "git@fixture:notes.git" }\n}\n' > "$work/k/.loopat/config.json"
git -C "$work/k" add -A && git -C "$work/k" commit -qm init && git -C "$work/k" push -q origin master
git clone -q /srv/git/roster1.git "$work/r" && echo hello > "$work/r/README.md"
git -C "$work/r" add -A && git -C "$work/r" commit -qm init && git -C "$work/r" push -q origin master
chown -R git:git /srv/git
echo "seeded"
