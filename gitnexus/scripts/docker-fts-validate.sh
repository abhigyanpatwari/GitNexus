#!/usr/bin/env bash
# FTS/BM25 smoke validation on Linux — do not reuse Windows host node_modules.
# Mount any Solidity (or mixed) corpus at /corpus. Override the hybrid query with
# GITNEXUS_FTS_QUERY (default is corpus-agnostic).
set -euo pipefail

echo "== docker FTS validate =="
node -v
export NODE_OPTIONS=--max-old-space-size=4096
QUERY="${GITNEXUS_FTS_QUERY:-contract}"

WORK=/tmp/gn-build
rm -rf "$WORK"
mkdir -p "$WORK/gitnexus" "$WORK/gitnexus-shared"

echo "== copy sources (no node_modules) =="
set +e
# Exclude host-native build/ artifacts — Windows .node files cause invalid ELF on Linux.
tar -C /workspace/gitnexus --exclude=node_modules --exclude=dist --exclude=.git \
  --exclude='tmp-*' --exclude='*.tsbuildinfo' --exclude='vendor/*/build' \
  -cf - . 2>/dev/null \
  | tar -C "$WORK/gitnexus" -xf -
tar -C /workspace/gitnexus-shared --exclude=node_modules --exclude=dist --exclude=.git \
  --exclude='*.tsbuildinfo' -cf - . 2>/dev/null \
  | tar -C "$WORK/gitnexus-shared" -xf -
set -e
test -f "$WORK/gitnexus/package.json"
test -f "$WORK/gitnexus-shared/package.json"
rm -f "$WORK/gitnexus-shared"/tsconfig.tsbuildinfo "$WORK/gitnexus"/tsconfig.tsbuildinfo

echo "== apt build deps =="
apt-get update -qq
apt-get install -y -qq python3 make g++ >/dev/null

echo "== build shared =="
cd "$WORK/gitnexus-shared"
npm ci
rm -f tsconfig.tsbuildinfo
npx tsc --build --force
test -f dist/index.d.ts
echo "shared dist OK"

echo "== install gitnexus (ignore scripts) + link shared =="
cd "$WORK/gitnexus"
npm ci --ignore-scripts
rm -rf node_modules/gitnexus-shared
ln -sfn "$WORK/gitnexus-shared" node_modules/gitnexus-shared
test -f node_modules/gitnexus-shared/dist/index.d.ts
test -f node_modules/gitnexus-shared/package.json
echo "shared link OK -> $(readlink -f node_modules/gitnexus-shared)"

echo "== postinstall grammars + ladybug + build =="
node scripts/build-tree-sitter-grammars.cjs
# Force Linux rebuild of Solidity binding (no prebuilds yet; host build/ excluded).
if [ -f vendor/tree-sitter-solidity/binding.gyp ]; then
  echo "rebuilding tree-sitter-solidity for linux..."
  (cd vendor/tree-sitter-solidity && npx node-gyp rebuild)
  test -f vendor/tree-sitter-solidity/build/Release/tree_sitter_solidity_binding.node
fi
node node_modules/@ladybugdb/core/install.js
npm run build
test -f dist/cli/index.js
node -e "import('@ladybugdb/core').then(() => console.log('ladybug OK')).catch((e)=>{console.error(e); process.exit(1)})"
node -e "
import { createRequire } from 'module';
const r = createRequire(import.meta.url);
r('./vendor/tree-sitter-solidity');
console.log('solidity grammar OK');
"

echo "== prepare corpus =="
rm -rf /tmp/corpus-work
mkdir -p /tmp/corpus-work
set +e
tar -C /corpus --exclude=.gitnexus --exclude=node_modules --exclude=.git \
  -cf - . 2>/dev/null | tar -C /tmp/corpus-work -xf -
set -e

echo "== analyze (FTS install=auto) =="
export GITNEXUS_LBUG_EXTENSION_INSTALL=auto
node dist/cli/index.js analyze /tmp/corpus-work --force --skip-git 2>&1 | tee /tmp/analyze.log | tail -100

echo "== FTS lines from analyze =="
grep -Ein 'FTS|BM25|fts|Ladybug|full.?text|extension|keyword|solidity' /tmp/analyze.log || true

echo "== .gitnexus =="
ls -la /tmp/corpus-work/.gitnexus | head -40

echo "== hybrid query (GITNEXUS_FTS_QUERY=${QUERY}) =="
node dist/cli/index.js query "$QUERY" --repo /tmp/corpus-work 2>&1 \
  | tee /tmp/query.log | head -120

echo "== query keyword hints =="
grep -Ein 'BM25|FTS|score|hybrid|semantic|keyword|embed|bm25|\.sol' /tmp/query.log || true

echo "== DONE =="
