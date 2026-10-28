#!/usr/bin/env bash
# Skills are published one by one with `git subtree split`, so a module two skills need
# cannot be imported across skill directories; each skill carries its own copy instead.
# This check fails when those copies drift apart. To change a shared module, edit one
# copy and copy it over the others.
#
# Run: bash tests/check-shared-copies.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One line per shared module: the paths, relative to the repository root, that must be
# byte-identical. The first path is the one named in the failure message as the reference.
SHARED=(
  "skills/ui-audit/scripts/chrome-cdp.mjs skills/screen-map/scripts/chrome-cdp.mjs skills/dom-picker/scripts/chrome-cdp.mjs"
)

status=0
for group in "${SHARED[@]}"; do
  read -r -a paths <<<"$group"
  reference="${paths[0]}"
  if [ ! -f "$ROOT/$reference" ]; then
    echo "FAIL  missing shared module: $reference"
    status=1
    continue
  fi
  for copy in "${paths[@]:1}"; do
    if [ ! -f "$ROOT/$copy" ]; then
      echo "FAIL  missing copy: $copy (of $reference)"
      status=1
    elif cmp -s "$ROOT/$reference" "$ROOT/$copy"; then
      echo "PASS  $copy matches $reference"
    else
      echo "FAIL  $copy differs from $reference"
      diff -u "$ROOT/$reference" "$ROOT/$copy" | head -40 || true
      status=1
    fi
  done
done
exit "$status"
