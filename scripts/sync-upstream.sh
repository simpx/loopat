#!/usr/bin/env bash
#
# sync-upstream.sh
#
# Fetch upstream/<TARGET_BRANCH> (GitHub), and if there are new commits
# relative to origin/<TARGET_BRANCH>, push the merge commit to
# `refs/for/<TARGET_BRANCH>/<topic>` which automatically opens a Code Review
# on Aone Code. All merges to main go through Code Review — this script
# never pushes to <TARGET_BRANCH> directly.
#
# Required env:
#   UPSTREAM_URL        GitHub clone URL  (e.g. https://github.com/simpx/loopat.git)
#
# Required for the refs/for/ push (the auto-injected ciToken does not work
# for refs/for/ pushes — Aone Code expects a real account):
#   CI_BOT_NAME    GitLab username that owns the token (e.g. your 花名)
#   CI_BOT_TOKEN   Personal access token (PAT)
#
# Optional env:
#   TARGET_BRANCH       branch to sync                       (default: main)
#   REVIEWERS           comma-separated "name1,id1,name2,id2" (default: empty)
#                       e.g. "垂虹,167900,小明,123456"
#   GIT_AUTHOR_NAME     author of the merge commit           (default: aone-ci-bot)
#   GIT_AUTHOR_EMAIL    author email                         (default: aone-ci-bot@alibaba-inc.com)

set -euo pipefail

: "${UPSTREAM_URL:?UPSTREAM_URL is required}"
: "${CI_BOT_NAME:?CI_BOT_NAME is required (configure via vars.CI_BOT_NAME)}"
: "${CI_BOT_TOKEN:?CI_BOT_TOKEN is required (configure via secrets.CI_BOT_TOKEN)}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"

log() { printf '[sync-upstream] %s\n' "$*"; }

git config user.name  "${GIT_AUTHOR_NAME:-aone-ci-bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-aone-ci-bot@alibaba-inc.com}"

# 1. Make sure upstream remote points to the GitHub URL (idempotent).
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

log "fetching upstream/${TARGET_BRANCH}"
git fetch --no-tags upstream "$TARGET_BRANCH"

log "fetching origin/${TARGET_BRANCH}"
git fetch --no-tags origin "$TARGET_BRANCH"

# 2. Bail out if origin already contains all upstream commits.
NEW_COMMIT_COUNT=$(git rev-list --count "origin/${TARGET_BRANCH}..upstream/${TARGET_BRANCH}")
if [ "$NEW_COMMIT_COUNT" = "0" ]; then
  log "origin/${TARGET_BRANCH} is up to date with upstream/${TARGET_BRANCH} — nothing to do."
  exit 0
fi
log "found ${NEW_COMMIT_COUNT} new commit(s) upstream"

UPSTREAM_HEAD=$(git rev-parse "upstream/${TARGET_BRANCH}")
UPSTREAM_SHORT="${UPSTREAM_HEAD:0:10}"

# 3. Check out origin/main into a local working branch.
WORK_BRANCH="sync-upstream-work"
log "checking out ${WORK_BRANCH} from origin/${TARGET_BRANCH}"
git checkout -B "$WORK_BRANCH" "origin/${TARGET_BRANCH}"

# 4. Build a deterministic merge commit. Reusing the upstream commit's
#    author/committer dates means re-running this script while origin/main
#    and upstream/main are unchanged produces an identical commit hash, so
#    the push below becomes a no-op instead of opening a new patchset.
UPSTREAM_DATE=$(git log -1 --format=%aI "upstream/${TARGET_BRANCH}")
export GIT_AUTHOR_DATE="$UPSTREAM_DATE"
export GIT_COMMITTER_DATE="$UPSTREAM_DATE"

CONFLICTS=0
MERGE_TITLE="sync: merge upstream/${TARGET_BRANCH} @ ${UPSTREAM_SHORT}"
MERGE_BODY="自动从 upstream 同步 ${TARGET_BRANCH} 分支。

- Upstream:     ${UPSTREAM_URL}
- Upstream HEAD: ${UPSTREAM_HEAD}
- New commits:  ${NEW_COMMIT_COUNT}

合并须知：勿 squash，保留 upstream 每个 commit 的身份，下次同步才能正确判断增量。"

if git merge --no-ff --no-edit -m "${MERGE_TITLE}" -m "${MERGE_BODY}" "upstream/${TARGET_BRANCH}"; then
  log "merge clean"
else
  CONFLICTS=1
  log "merge produced conflicts — committing with markers for manual resolution"
  CONFLICT_NOTE="

⚠️ 存在冲突 — 本地用 \`git-repo\` 拉取该 CR (\`git pr checkout <id>\`)，解决冲突后
   \`git push origin HEAD:refs/for/${TARGET_BRANCH}/${WORK_BRANCH}-${UPSTREAM_SHORT}\` 推回。"
  MERGE_TITLE="${MERGE_TITLE} [CONFLICTS]"
  git add -A
  git commit --no-verify \
    -m "${MERGE_TITLE}" \
    -m "${MERGE_BODY}${CONFLICT_NOTE}" || true
fi

# 5. Push to refs/for/<branch>/<topic> — Aone Code creates / updates a CR.
#    Topic includes the upstream short SHA so a new upstream HEAD always
#    yields a fresh CR, while repeated runs at the same HEAD update the same CR.
TOPIC="sync-upstream-${UPSTREAM_SHORT}"

PUSH_OPTS=( -o "title=${MERGE_TITLE}" )
if [ -n "${REVIEWERS:-}" ]; then
  PUSH_OPTS+=( -o "reviewer=${REVIEWERS}" )
fi

# Build an HTTPS push URL that embeds the user/token. We don't modify the
# remote permanently — auth is supplied only for this single push.
# Use pure bash parameter expansion so special chars in the token (&, \,
# /, etc.) are never re-interpreted by sed.
ORIGIN_URL=$(git remote get-url --push origin)

# Normalize SSH -> HTTPS:  git@host:path  ->  https://host/path
case "$ORIGIN_URL" in
  git@*)
    _stripped="${ORIGIN_URL#git@}"     # host:path
    ORIGIN_URL="https://${_stripped/://}"
    ;;
esac

# Strip any existing inline credentials:  https://x:y@host/...  ->  https://host/...
case "$ORIGIN_URL" in
  https://*@*)
    ORIGIN_URL="https://${ORIGIN_URL#https://*@}"
    ;;
esac

PUSH_URL="https://${CI_BOT_NAME}:${CI_BOT_TOKEN}@${ORIGIN_URL#https://}"

# Sanity log (token is auto-masked by Aone CI in logs).
log "CI_BOT_NAME='${CI_BOT_NAME}' len=${#CI_BOT_NAME}"
log "CI_BOT_TOKEN len=${#CI_BOT_TOKEN}"
log "origin URL (no creds): ${ORIGIN_URL}"

log "pushing HEAD to refs/for/${TARGET_BRANCH}/${TOPIC}"
git push "${PUSH_OPTS[@]}" "$PUSH_URL" "HEAD:refs/for/${TARGET_BRANCH}/${TOPIC}"
log "done"
