#!/usr/bin/env bash
# vendor-plugins.sh
# Vendors approved plugins from the official Anthropic catalog into this
# (taurus-approved) marketplace repo, pinned to one reviewable commit, and
# rebuilds each catalog entry so it is complete and correct.
#
# PLUGINS (below) is the source of truth. For each listed plugin the script:
#   - copies plugins/<name> from the pinned upstream into ./plugins/<name>
#   - writes ./plugins/<name>/.vendor.json (upstream + ref + sha + timestamp)
#   - creates or updates its entry in .claude-plugin/marketplace.json:
#       * source            -> forced to ./plugins/<name> (the vendored copy)
#       * version           -> plugin.json -> upstream catalog -> 0.0.0+sha.<short>
#       * structural fields -> copied from the upstream catalog entry
#                              (strict, lspServers, skills, mcpServers, author, ...)
#       * description       -> kept if you set one, else taken from upstream
#       * any custom local fields are preserved
#
# Manifest-less plugins (LSP/skill bundles with no plugin.json) are handled
# automatically: their definition lives in the catalog entry, which is rebuilt
# from upstream here.
#
# Usage:
#   ./vendor-plugins.sh [REF] [--dry-run]
#     REF         branch, tag, or commit SHA to pin (default: main)
#     --dry-run   show what would change; touch nothing
#
# Env:
#   VENDOR_UPSTREAM   override the upstream repo URL (e.g. an internal mirror)
#
# Run from the marketplace repo root, review the diff, then commit & push.

set -euo pipefail

UPSTREAM="${VENDOR_UPSTREAM:-https://github.com/anthropics/claude-plugins-official.git}"
CATALOG=".claude-plugin/marketplace.json"
REF="main"
DRY_RUN=0

PLUGINS=(
  "gopls-lsp"
  "code-review"
  "feature-dev"
)

# --- args ------------------------------------------------------------------
print_help() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    -h|--help) print_help; exit 0 ;;
    --) shift; break ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 2 ;;
    *) REF="$1"; shift ;;
  esac
done

# --- preflight -------------------------------------------------------------
command -v git  >/dev/null 2>&1 || { echo "ERROR: git not found." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (needed to update $CATALOG)." >&2; exit 1; }
[ -f "$CATALOG" ] || { echo "ERROR: $CATALOG not found. Run from the marketplace repo root." >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  echo "WARN: not inside a git repo — vendored files won't be version-controlled here." >&2

for name in "${PLUGINS[@]}"; do
  case "$name" in
    *[!A-Za-z0-9._-]*|''|.|..) echo "ERROR: invalid plugin name in PLUGINS: '$name'" >&2; exit 2 ;;
  esac
done

[ "$DRY_RUN" -eq 1 ] && echo "(dry-run: no files will be written)"

# --- fetch (plugin subtrees + the upstream catalog) ------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --filter=blob:none --sparse "$UPSTREAM" "$tmp" 2>/dev/null \
  || { echo "ERROR: failed to clone $UPSTREAM" >&2; exit 1; }
git -C "$tmp" sparse-checkout set "${PLUGINS[@]/#/plugins/}" ".claude-plugin" \
  || { echo "ERROR: sparse-checkout failed" >&2; exit 1; }
git -C "$tmp" checkout "$REF" 2>/dev/null \
  || { echo "ERROR: ref '$REF' not found in $UPSTREAM" >&2; exit 1; }
SHA="$(git -C "$tmp" rev-parse HEAD)"
echo "Pinned $UPSTREAM @ $REF ($SHA)"

# --- vendor ----------------------------------------------------------------
FAILED=""
for name in "${PLUGINS[@]}"; do
  src="$tmp/plugins/$name"
  if [ ! -d "$src" ]; then
    echo "  ERROR: plugins/$name not found upstream at '$REF' — skipping." >&2
    FAILED="$FAILED $name"
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would vendor $name -> ./plugins/$name"
    continue
  fi
  dest="plugins/$name"
  prev_sha=""; prev_at=""
  if [ -f "$dest/.vendor.json" ]; then
    prev_sha=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$dest/.vendor.json")
    prev_at=$(sed -n 's/.*"vendored_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dest/.vendor.json")
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"
  if [ "$prev_sha" = "$SHA" ] && [ -n "$prev_at" ]; then
    vendored_at="$prev_at"; echo "  = $name: re-synced (already at ${SHA:0:12})"
  else
    vendored_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "  vendored $name -> ./$dest (${SHA:0:12})"
  fi
  cat > "$dest/.vendor.json" <<JSON
{
  "upstream": "anthropics/claude-plugins-official",
  "subdir": "plugins/$name",
  "ref": "$REF",
  "sha": "$SHA",
  "vendored_at": "$vendored_at"
}
JSON
done

# --- rebuild catalog entries ----------------------------------------------
echo "Catalog ($CATALOG):"
TG_PLUGINS="${PLUGINS[*]}" TG_SKIP="$FAILED" TG_CATALOG="$CATALOG" \
TG_UPSTREAM_CATALOG="$tmp/$CATALOG" TG_TMP="$tmp" TG_SHA="$SHA" TG_DRY="$DRY_RUN" \
node <<'JS'
const fs = require('fs');
const path = require('path');
const catalog = process.env.TG_CATALOG;
const tmp = process.env.TG_TMP;
const sha = (process.env.TG_SHA || '').slice(0, 12);
const dry = process.env.TG_DRY === '1';
const names = (process.env.TG_PLUGINS || '').split(/\s+/).filter(Boolean);
const skip = new Set((process.env.TG_SKIP || '').split(/\s+/).filter(Boolean));
const KEY_ORDER = ['name','description','version','author','category','source',
                   'strict','lspServers','mcpServers','hooks','commands','agents','skills','homepage'];
const PRESERVE_LOCAL = ['name','source','version'];          // never taken from upstream
const SKIP_FROM_UPSTREAM = ['name','source','version','description','homepage'];

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));

let mp;
try { mp = readJSON(catalog); }
catch (e) { console.error(`  ERROR: cannot parse ${catalog}: ${e.message}`); process.exit(2); }
mp.plugins = Array.isArray(mp.plugins) ? mp.plugins : [];

let upstream = { plugins: [] };
try { upstream = readJSON(process.env.TG_UPSTREAM_CATALOG); }
catch (e) { console.error(`  WARN: upstream catalog unreadable (${e.code || e.message}); structural fields not synced this run`); }
const upByName = new Map((upstream.plugins || []).filter(p => p && p.name).map(p => [p.name, p]));

function resolveVersion(name) {
  try {
    const v = readJSON(path.join(tmp, 'plugins', name, '.claude-plugin', 'plugin.json')).version;
    if (v) return [String(v), 'plugin.json'];
  } catch (e) {}
  const up = upByName.get(name);
  if (up && up.version) return [String(up.version), 'upstream catalog'];
  return [`0.0.0+sha.${sha}`, 'derived from sha'];
}

function reorder(o) {
  const out = {};
  for (const k of KEY_ORDER) if (k in o) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
  return out;
}
const norm = o => JSON.stringify(reorder(o));

function buildEntry(name, local) {
  local = local || {};
  const up = upByName.get(name) || {};
  const out = {};
  for (const [k, v] of Object.entries(up)) if (!SKIP_FROM_UPSTREAM.includes(k)) out[k] = v;     // structural + metadata
  for (const [k, v] of Object.entries(local)) if (!PRESERVE_LOCAL.includes(k) && !(k in out)) out[k] = v; // keep local-only fields
  const [version, vsrc] = resolveVersion(name);
  out.name = name;
  out.source = `./plugins/${name}`;                                                              // force vendored path
  out.description = local.description || up.description || `${name} (vendored from anthropics/claude-plugins-official).`;
  out.version = version;
  return [reorder(out), vsrc, !upByName.has(name)];
}

let changed = 0;
for (const name of names) {
  if (skip.has(name)) { console.log(`  ! ${name}: skipped (vendoring failed)`); continue; }
  const idx = mp.plugins.findIndex(p => p && p.name === name);
  const local = idx >= 0 ? mp.plugins[idx] : null;
  const [entry, vsrc, noUp] = buildEntry(name, local);
  const note = noUp ? ' [no upstream entry — structural fields not synced]' : '';
  if (idx < 0) {
    if (!dry) mp.plugins.push(entry);
    changed++;
    console.log(`  + ${name}: added (v${entry.version}, ${vsrc})${note}`);
  } else if (norm(entry) !== norm(local)) {
    if (!dry) mp.plugins[idx] = entry;
    changed++;
    console.log(`  ~ ${name}: updated (v${local.version ?? 'none'} -> v${entry.version}, ${vsrc})${note}`);
  } else {
    console.log(`  = ${name}: unchanged (v${entry.version})`);
  }
}

const managed = new Set(names);
for (const p of mp.plugins) if (p && p.name && !managed.has(p.name))
  console.error(`  NOTE: "${p.name}" is in ${catalog} but not in PLUGINS — left untouched, not managed by this script.`);

if (changed > 0 && !dry) {
  const tmpfile = catalog + '.tmp';
  fs.writeFileSync(tmpfile, JSON.stringify(mp, null, 2) + '\n');
  fs.renameSync(tmpfile, catalog);                                                               // atomic
  console.log(`  wrote ${changed} change(s).`);
} else if (changed > 0) {
  console.log(`  [dry-run] ${changed} change(s) would be written.`);
} else {
  console.log(`  no changes.`);
}
JS

if [ -n "$FAILED" ]; then
  echo "FAILED to vendor:$FAILED" >&2
  echo "Fix the names in PLUGINS (or the ref) and re-run." >&2
  exit 1
fi
[ "$DRY_RUN" -eq 1 ] || echo "Review the diff (vendored files + catalog), then commit & push."
