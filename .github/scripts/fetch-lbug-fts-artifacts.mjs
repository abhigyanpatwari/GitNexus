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

/** Only the Ladybug official extension host — never a manifest-supplied origin. */
const OFFICIAL_REPO = 'https://extension.ladybugdb.com/';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_UPSTREAM = /^(linux_amd64|linux_arm64|osx_amd64|osx_arm64|win_amd64)$/;

/**
 * Build the official artifact URL from allowlisted fields only.
 * `officialRepo` in the manifest must match {@link OFFICIAL_REPO}; the
 * origin itself is a constant so an edited manifest cannot redirect the fetch.
 */
export function officialArtifactUrl(manifest, upstreamPlatform) {
  const officialRepo = String(manifest?.officialRepo ?? '');
  if (officialRepo !== OFFICIAL_REPO) {
    throw new Error(`refusing unofficial FTS repo: '${officialRepo}'`);
  }
  const version = String(manifest?.extensionVersion ?? '');
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`unsafe extensionVersion: '${version}'`);
  }
  if (!SAFE_UPSTREAM.test(String(upstreamPlatform ?? ''))) {
    throw new Error(`unsafe upstream platform: '${upstreamPlatform}'`);
  }
  const filename = String(manifest?.filename ?? '');
  if (!SAFE_FILENAME.test(filename)) {
    throw new Error(`unsafe FTS artifact filename: '${filename}'`);
  }
  return `${OFFICIAL_REPO}v${version}/${upstreamPlatform}/fts/${filename}`;
}

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
  // codeql[js/request-forgery] — origin is OFFICIAL_REPO; path segments are allowlisted.
  // lgtm[js/request-forgery]
  // codeql[js/file-access-to-http] — versions/platforms are regex-pinned, not raw file bytes.
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const writeAllowlistedArtifact = (prebuildsDir, dest, buf) => {
  if (!isPathInsideRoot(prebuildsDir, dest)) {
    throw new Error(`FTS artifact dest is not inside prebuildsDir: ${dest}`);
  }
  // codeql[js/http-to-file-access] — dest is assertSafeArtifactDest + containment-checked.
  writeFileSync(dest, buf);
};

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
    const url = officialArtifactUrl(manifest, upstreamPlatform);
    const previousHash = readExistingHash(dest);
    const previousSize = previousHash ? readFileSync(dest).byteLength : 0;
    const buf = await download(url);
    const nextHash = sha256(buf);
    writeAllowlistedArtifact(prebuildsDir, dest, buf);
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
