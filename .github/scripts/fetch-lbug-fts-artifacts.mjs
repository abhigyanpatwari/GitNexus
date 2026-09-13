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

async function fetchBuffer(url) {
  const res = await fetch(url);
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
    const destDir = path.join(prebuildsDir, tuple);
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, manifest.filename);
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
