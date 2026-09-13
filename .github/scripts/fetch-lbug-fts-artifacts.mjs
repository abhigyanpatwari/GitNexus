#!/usr/bin/env node
/**
 * Fetch Ladybug FTS artifacts into gitnexus/vendor/lbug-fts/prebuilds/.
 *
 * Lives outside the published package (`files` includes `scripts` wholesale).
 * Reads versions, filename, and tuple→upstream-platform mapping from
 * vendor/lbug-fts/manifest.json so the gate and runtime cannot drift.
 *
 * Usage: node .github/scripts/fetch-lbug-fts-artifacts.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = path.join(REPO_ROOT, 'gitnexus', 'vendor', 'lbug-fts');
const PREBUILDS = path.join(VENDOR, 'prebuilds');
const MANIFEST_PATH = path.join(VENDOR, 'manifest.json');

const artifactUrl = (manifest, upstreamPlatform) =>
  `${manifest.officialRepo}v${manifest.extensionVersion}/${upstreamPlatform}/fts/${manifest.filename}`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const readExistingHash = (filePath) => {
  if (!existsSync(filePath)) return null;
  return sha256(readFileSync(filePath));
};

export const supportedTuples = (manifest) => manifest.tuples.map((entry) => entry.tuple);

const SAFE_TUPLE = /^(darwin|linux|win32)-(x64|arm64)$/;
const SAFE_FILENAME = /^[\w.-]+\.lbug_extension$/;

/** Relative-path containment — not a prefix match (rejects `prebuilds-evil`). */
const isPathInsideRoot = (root, candidate) => {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative)) return false;
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..';
};

export function assertSafeArtifactDest({ prebuildsDir, tuple, filename }) {
  if (!SAFE_TUPLE.test(String(tuple ?? ''))) {
    throw new Error(
      `unsafe FTS artifact tuple: '${tuple}' (expected (darwin|linux|win32)-(x64|arm64))`,
    );
  }
  if (!SAFE_FILENAME.test(String(filename ?? ''))) {
    throw new Error(`unsafe FTS artifact filename: '${filename}' (expected *.lbug_extension)`);
  }
  const dest = path.join(prebuildsDir, tuple, filename);
  if (!isPathInsideRoot(prebuildsDir, dest)) {
    throw new Error(`FTS artifact dest is not inside prebuildsDir: ${dest}`);
  }
  return dest;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function refreshArtifacts({
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
  prebuildsDir = PREBUILDS,
  download = fetchBuffer,
} = {}) {
  mkdirSync(prebuildsDir, { recursive: true });
  const lines = [];
  for (const { tuple, upstreamPlatform } of manifest.tuples) {
    const dest = assertSafeArtifactDest({
      prebuildsDir,
      tuple,
      filename: manifest.filename,
    });
    mkdirSync(path.dirname(dest), { recursive: true });
    const url = artifactUrl(manifest, upstreamPlatform);
    const previousHash = readExistingHash(dest);
    const previousSize = previousHash ? readFileSync(dest).byteLength : 0;
    const buf = await download(url);
    const nextHash = sha256(buf);
    writeFileSync(dest, buf);
    const changed = previousHash !== nextHash;
    console.log(
      changed
        ? `[fts-fetch] ${tuple}: ${previousHash ?? '(new)'} (${previousSize} B) → ${nextHash} (${buf.byteLength} B)`
        : `[fts-fetch] ${tuple}: unchanged ${nextHash} (${buf.byteLength} B)`,
    );
    lines.push(`${nextHash}  ./${tuple}/${manifest.filename}`);
  }
  lines.sort();
  writeFileSync(path.join(prebuildsDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return lines;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  refreshArtifacts().catch((err) => {
    console.error(`[fts-fetch] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
