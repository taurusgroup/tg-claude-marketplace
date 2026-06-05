#!/usr/bin/env bash
# vendor-plugins.sh
# Vendors approved plugins from the official Anthropic catalog into this
# (taurus-approved) marketplace repo, pinned to one reviewable commit.
#
# Usage:
#   ./vendor-plugins.sh [ref]     # ref = branch, tag, or commit SHA (default: main)
#
# Edit PLUGINS to control what is vendored. Each name must match a subdirectory
# under plugins/ in anthropics/claude-plugins-official. Run from the root of
# your taurus-approved repo, then review diffs, set/bump versions in
# .claude-plugin/marketplace.json, and commit.

set -euo pipefail

UPSTREAM="https://github.com/anthropics/claude-plugins-official.git"
REF="${1:-main}"

PLUGINS=(
  "gopls-lsp"
  "code-review"
  "feature-dev"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Blobless, sparse clone — only the named plugin subtrees are fetched.
git clone --filter=blob:none --sparse "$UPSTREAM" "$tmp"
git -C "$tmp" sparse-checkout set "${PLUGINS[@]/#/plugins/}"
git -C "$tmp" checkout "$REF"
SHA="$(git -C "$tmp" rev-parse HEAD)"

for name in "${PLUGINS[@]}"; do
  src="$tmp/plugins/$name"
  dest="plugins/$name"
  if [ ! -d "$src" ]; then
    echo "ERROR: plugins/$name not found upstream at ref '$REF'." >&2
    exit 1
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"
  cat > "$dest/.vendor.json" <<JSON
{
  "upstream": "anthropics/claude-plugins-official",
  "subdir": "plugins/$name",
  "ref": "$REF",
  "sha": "$SHA",
  "vendored_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  echo "Vendored $name @ $SHA -> ./$dest"
done

echo "Done. Review diffs, set versions in .claude-plugin/marketplace.json, commit & push."
