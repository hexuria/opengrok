#!/usr/bin/env bash
# Restores the material this repository deliberately does not track (CLAUDE.md)
# from a checkout of the private hexuria/opengrok-stow archive, so that a bare
# clone can typecheck and test. Nothing here is ever committed back.
#
# Used by .github/workflows/check.yml and runnable locally against a clone of
# the archive, so CI and a local dry-run cannot drift apart.
#
# Usage: scripts/ci-restore-recovered.sh <path-to-opengrok-stow-checkout>
set -euo pipefail

archive="${1:?usage: ci-restore-recovered.sh <path-to-opengrok-stow-checkout>}"
test -d "$archive" || { echo "no such archive checkout: $archive" >&2; exit 1; }

# Generated protobuf trees: hundreds of source files import these.
for pkg in proto redacted-protos; do
  src="$archive/source/packages/$pkg/generated"
  test -d "$src" || { echo "archive is missing source/packages/$pkg/generated" >&2; exit 1; }
  mkdir -p "source/packages/$pkg"
  rm -rf "source/packages/$pkg/generated"
  cp -R "$src" "source/packages/$pkg/generated"
done

# Trees this repository ignores in full.
for dir in frontend manifests patches research-archives; do
  test -d "$archive/$dir" || { echo "archive is missing $dir/" >&2; exit 1; }
  rm -rf "$dir"
  cp -R "$archive/$dir" "$dir"
done

# docs/ is mixed: 14 files are tracked here and must win, the rest are private.
# -n never overwrites, so the committed copies stay authoritative.
test -d "$archive/docs" || { echo "archive is missing docs/" >&2; exit 1; }
cp -Rn "$archive/docs/." docs/ 2>/dev/null || true

printf 'restored %s proto files, frontend/, manifests/, patches/, research-archives/, docs\n' \
  "$(find source/packages -path '*generated*' -name '*.ts' | wc -l | tr -d ' ')"
