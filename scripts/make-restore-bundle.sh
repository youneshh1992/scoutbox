#!/usr/bin/env bash
# Build a verified git bundle of the unpushed work on this branch.
#
# Why a bundle: the branch carries a long chain of commits that has never been
# pushed. A bundle is a single self-contained file holding the real commit
# objects, so the history can be restored byte-for-byte on another machine
# without a remote — and `git bundle verify` proves it is complete before you
# trust it.
#
# What it contains: exactly what git tracks. Secrets, runtime databases,
# uploads, node_modules and build output are not tracked (see .gitignore) and
# therefore cannot be in the bundle; the script re-checks that before building.
#
#   usage: scripts/make-restore-bundle.sh [output-path]
set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BASE="${BASE_REF:-origin/$BRANCH}"
OUT="${1:-/tmp/scoutbox-${BRANCH##*/}-$(git rev-parse --short HEAD).bundle}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "No base ref '$BASE'; bundling the full branch history instead." >&2
  BASE=""
fi

echo "branch:      $BRANCH"
echo "base:        ${BASE:-<root>}"
echo "tip:         $(git rev-parse HEAD)"
if [ -n "$BASE" ]; then
  echo "base commit: $(git rev-parse "$BASE")"
  echo "commits:     $(git rev-list --count "$BASE..HEAD")"
fi

# Refuse to build if anything that must never leave the machine is tracked.
if git ls-files | grep -qiE '(^|/)\.env$|\.pem$|\.key$|(^|/)secrets?\.|\.sqlite$|/uploads/|(^|/)node_modules/'; then
  echo "REFUSING: a secret, key, database or dependency directory is tracked." >&2
  git ls-files | grep -iE '(^|/)\.env$|\.pem$|\.key$|(^|/)secrets?\.|\.sqlite$|/uploads/|(^|/)node_modules/' >&2
  exit 1
fi
echo "secret scan: clean (only .env.example placeholders are tracked)"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: the working tree is dirty — commit or stash first." >&2
  git status --short >&2
  exit 1
fi

git bundle create "$OUT" "$BRANCH"
echo
git bundle verify "$OUT"
echo
echo "bundle:      $OUT"
echo "size:        $(du -h "$OUT" | cut -f1)"
echo "sha256:      $(sha256sum "$OUT" | cut -d' ' -f1)"
cat <<EOF

── restore on another machine ─────────────────────────────────────────────
  git clone $(basename "$OUT") scoutbox -b $BRANCH     # from the bundle alone
      # …or into an existing clone of the repository:
  git bundle verify $(basename "$OUT")
  git fetch $(basename "$OUT") '$BRANCH:$BRANCH'
  git checkout $BRANCH
  git log --oneline -5                                  # tip should be $(git rev-parse --short HEAD)

  Then reinstall dependencies (they are deliberately not in the bundle):
  (cd scoutbox-server && npm install) && (cd scoutbox-club && npm install) \\
    && (cd scoutbox-grassroots && npm install) && (cd scoutbox-admin && npm install) \\
    && (cd scoutbox-player && npm install) && (cd e2e && npm install)
───────────────────────────────────────────────────────────────────────────
EOF
