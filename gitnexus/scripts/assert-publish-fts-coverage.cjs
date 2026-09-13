#!/usr/bin/env node
/**
 * Publish guard: core↔extension pairing plus vendored FTS artifact integrity.
 *
 * Does not shell out to `npm pack` (prepack re-entrancy; see the grammar gate).
 * Checksums and the `files` allow-list are asserted as pure predicates so a
 * future lean-publish narrowing cannot drop the artifacts silently.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WIN32_ARM64 = 'win32-arm64';

/**
 * Pure pairing core (exported for tests). Returns human-readable problem
 * strings; an empty array means the core↔extension pin is consistent.
 */
function findPairingProblems({
  installedCoreVersion,
  manifestCoreVersion,
  manifestExtensionVersion,
}) {
  const problems = [];
  const installed = String(installedCoreVersion ?? '').replace(/^[^\d]*/, '');
  const pinned = String(manifestCoreVersion ?? '').replace(/^[^\d]*/, '');
  if (!installed || !pinned) {
    problems.push(
      `core pin missing: installed '${installedCoreVersion ?? ''}' vs manifest '${manifestCoreVersion ?? ''}'`,
    );
    return problems;
  }
  if (installed !== pinned) {
    problems.push(
      `core pin mismatch: installed ${installed} vs manifest ${pinned}` +
        (manifestExtensionVersion ? ` (extension ${manifestExtensionVersion})` : ''),
    );
  }
  return problems;
}

function readInstalledCoreVersion(pkg) {
  const raw = pkg?.dependencies?.['@ladybugdb/core'];
  return raw == null ? '' : String(raw);
}

function normalizeFilesEntry(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\/\*\*?$/, '');
}

/** True when package.json `files` still ships the FTS prebuild tree. */
function filesCoverFtsArtifacts(filesField) {
  return (filesField || []).some((entry) => {
    const n = normalizeFilesEntry(entry);
    return (
      n === 'vendor' ||
      n === 'vendor/lbug-fts' ||
      n === 'vendor/lbug-fts/prebuilds' ||
      n === 'vendor/**/prebuilds'
    );
  });
}

function supportedTuplesFromManifest(manifest) {
  return (manifest?.tuples ?? []).map((entry) => entry.tuple);
}

function unsupportedTuplesFromManifest(manifest) {
  return (manifest?.unsupportedTuples ?? []).map((entry) => entry.tuple);
}

function parseSha256Sums(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\.\/(\S+)$/.exec(line.trim());
    if (!m) continue;
    out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Integrity + coverage predicates. `artifactByTuple` is injected so tests
 * never invoke pack and never need the real binaries.
 */
function findArtifactProblems({
  tuples,
  unsupportedTuples,
  filesField,
  checksumByRelPath,
  artifactByTuple,
  filename,
}) {
  const problems = [];
  const filenameSafe = filename || 'libfts.lbug_extension';
  if (!filesCoverFtsArtifacts(filesField)) {
    problems.push('package.json files no longer covers vendor/lbug-fts/prebuilds');
  }
  if (!(unsupportedTuples || []).includes(WIN32_ARM64)) {
    problems.push('win32-arm64 must be declared unsupported (no upstream artifact)');
  }
  if ((tuples || []).includes(WIN32_ARM64)) {
    problems.push('win32-arm64 is listed as supported but has no upstream artifact');
  }
  for (const tuple of tuples || []) {
    const rel = `${tuple}/${filenameSafe}`;
    const artifact = artifactByTuple?.[tuple];
    if (!artifact?.exists) {
      problems.push(`missing artifact for ${tuple} (${rel})`);
      continue;
    }
    const expected = checksumByRelPath?.[rel];
    if (!expected) {
      problems.push(`missing SHA-256 for ${rel}`);
      continue;
    }
    if (artifact.hash !== expected) {
      problems.push(
        `checksum mismatch for ${tuple}: expected ${expected} got ${artifact.hash}` +
          (artifact.sizeBytes != null ? ` (${artifact.sizeBytes} bytes)` : ''),
      );
    }
  }
  return problems;
}

function readDiskArtifacts(prebuildsDir, tuples, filename) {
  const artifactByTuple = {};
  for (const tuple of tuples) {
    const filePath = path.join(prebuildsDir, tuple, filename);
    if (!fs.existsSync(filePath)) {
      artifactByTuple[tuple] = { exists: false };
      continue;
    }
    const buf = fs.readFileSync(filePath);
    artifactByTuple[tuple] = {
      exists: true,
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
      sizeBytes: buf.byteLength,
    };
  }
  return artifactByTuple;
}

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'));
  const vendorDir = path.join(gitnexusRoot, 'vendor', 'lbug-fts');
  const manifestPath = path.join(vendorDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[fts-pairing] Refusing to publish — cannot read ${manifestPath}: ${err.message}`);
    process.exit(1);
  }

  const installedCoreVersion = readInstalledCoreVersion(pkg);
  const pairing = findPairingProblems({
    installedCoreVersion,
    manifestCoreVersion: manifest.coreVersion,
    manifestExtensionVersion: manifest.extensionVersion,
  });

  const tuples = supportedTuplesFromManifest(manifest);
  const unsupportedTuples = unsupportedTuplesFromManifest(manifest);
  const filename = manifest.filename || 'libfts.lbug_extension';
  const prebuildsDir = path.join(vendorDir, 'prebuilds');
  let checksumByRelPath = {};
  try {
    checksumByRelPath = parseSha256Sums(fs.readFileSync(path.join(prebuildsDir, 'SHA256SUMS'), 'utf8'));
  } catch (err) {
    pairing.push(`cannot read SHA256SUMS: ${err.message}`);
  }

  const artifacts = findArtifactProblems({
    tuples,
    unsupportedTuples,
    filesField: pkg.files,
    checksumByRelPath,
    artifactByTuple: readDiskArtifacts(prebuildsDir, tuples, filename),
    filename,
  });

  const problems = [...pairing, ...artifacts];
  if (problems.length > 0) {
    console.error('[fts-pairing] Refusing to publish — FTS artifact coverage failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: refresh vendor/lbug-fts via .github/scripts/fetch-lbug-fts-artifacts.mjs, ' +
        'or restore the core pin / files allow-list.',
    );
    process.exit(1);
  }

  console.log(
    `[fts-pairing] OK — core ${installedCoreVersion.replace(/^[^\d]*/, '')} ↔ extension ${manifest.extensionVersion}; ` +
      `${tuples.length} artifacts.`,
  );
}

if (require.main === module) main();

module.exports = {
  findPairingProblems,
  findArtifactProblems,
  filesCoverFtsArtifacts,
  parseSha256Sums,
  readInstalledCoreVersion,
  supportedTuplesFromManifest,
  unsupportedTuplesFromManifest,
  sha256File,
};
