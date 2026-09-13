#!/usr/bin/env node
/**
 * Publish guard: the vendored FTS artifact pin must match the installed core.
 *
 * `@ladybugdb/core` and the FTS extension version are separate upstream pins
 * (core 0.18.3 → extension 0.18.1). Dependabot does not ignore the core by
 * default; a green bump would ship a skewed artifact. This gate fails when
 * `vendor/lbug-fts/manifest.json` does not name the installed core.
 *
 * U13 owns the pairing predicate. U1 extends this script with checksum / tuple
 * / `files`-list coverage — do not add those checks here.
 *
 * Reads package.json `dependencies` and the committed manifest. Does not
 * shell out to `npm pack` (prepack re-entrancy; see the grammar gate header).
 */
const fs = require('fs');
const path = require('path');

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

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'));
  const manifestPath = path.join(gitnexusRoot, 'vendor', 'lbug-fts', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[fts-pairing] Refusing to publish — cannot read ${manifestPath}: ${err.message}`);
    process.exit(1);
  }

  const installedCoreVersion = readInstalledCoreVersion(pkg);
  const problems = findPairingProblems({
    installedCoreVersion,
    manifestCoreVersion: manifest.coreVersion,
    manifestExtensionVersion: manifest.extensionVersion,
  });
  if (problems.length > 0) {
    console.error('[fts-pairing] Refusing to publish — core and FTS extension pins do not match:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: update vendor/lbug-fts/manifest.json to the installed @ladybugdb/core ' +
        'and refresh the vendored artifacts, or revert the core bump.',
    );
    process.exit(1);
  }

  console.log(
    `[fts-pairing] OK — core ${installedCoreVersion.replace(/^[^\d]*/, '')} ↔ extension ${manifest.extensionVersion}.`,
  );
}

if (require.main === module) main();

module.exports = {
  findPairingProblems,
  readInstalledCoreVersion,
};
