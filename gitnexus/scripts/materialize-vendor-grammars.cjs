#!/usr/bin/env node
/**
 * Copy vendored tree-sitter grammars into node_modules/ using real files (fs.cpSync).
 *
 * Published gitnexus used to declare these as optionalDependencies with
 * `file:./vendor/...`, which makes npm symlink/junction vendor → node_modules on
 * install. Windows without Developer Mode often fails with EPERM (#1728).
 *
 * Vendor trees stay read-only in gitnexus/vendor/; build artifacts must only
 * land under node_modules/ (see #836).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// tree-sitter-c is a REQUIRED grammar that we vendor prebuild-only purely to
// close upstream's ARM prebuild gap (#2116) — it needs no toolchain and is not a
// language the user opts out of, so it is always materialized, even under
// GITNEXUS_SKIP_OPTIONAL_GRAMMARS. The rest are optional (user-skippable, and
// Dart/Proto compile from source) and honor the skip flag.
const REQUIRED_VENDORED = ['tree-sitter-c'];
const OPTIONAL_VENDORED = [
  'tree-sitter-dart',
  'tree-sitter-proto',
  'tree-sitter-swift',
  'tree-sitter-kotlin',
];

const skipOptional = process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1';
if (skipOptional) {
  console.warn(
    '[gitnexus] GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1: skipping optional Dart/Proto/Swift/Kotlin materialize (required C is still materialized).',
  );
}
const VENDORED_GRAMMARS = skipOptional
  ? REQUIRED_VENDORED
  : [...REQUIRED_VENDORED, ...OPTIONAL_VENDORED];

for (const name of VENDORED_GRAMMARS) {
  const src = path.join(ROOT, 'vendor', name);
  const dest = path.join(ROOT, 'node_modules', name);

  if (!fs.existsSync(src)) {
    console.warn(`[gitnexus] vendor/${name} missing; skipping materialize.`);
    continue;
  }

  // Sequence: copy src → partial; rename dest → backup; rename partial → dest;
  // remove backup. If any step fails, restore from backup so a previously-
  // materialized grammar is never lost. Targets the #1728 EPERM scenario plus
  // narrower failure modes (Windows AV scanner racing on rename, EBUSY mid-swap).
  const partial = `${dest}.materialize-tmp`;
  const backup = `${dest}.materialize-bak`;
  try {
    fs.mkdirSync(path.join(ROOT, 'node_modules'), { recursive: true });
    fs.rmSync(partial, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(src, partial, { recursive: true, verbatim: true });
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, backup);
    }
    try {
      fs.renameSync(partial, dest);
    } catch (renameErr) {
      // Best-effort rollback: restore the previous dest from backup.
      let restored = false;
      if (fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, dest);
          restored = true;
        } catch {
          // Rollback also failed — dest is now missing. Leave the backup in
          // place (the catch below will NOT remove it) and surface where it is.
        }
      }
      if (!restored && fs.existsSync(backup)) {
        console.warn(
          `[gitnexus] CRITICAL: could not materialize vendor/${name} AND could not restore the ` +
            `previous node_modules/${name}. A recoverable copy remains at ${backup} — ` +
            `restore it (e.g. \`mv ${backup} ${dest}\`) or reinstall to recover ${name}.`,
        );
      }
      throw renameErr;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    // Fail-soft: a single locked/inaccessible file (common on Windows) must not
    // abort the whole gitnexus install. Matches build-tree-sitter-*.cjs pattern.
    // Only remove the scratch `partial`; never the `backup` (it may be the sole
    // recoverable copy after a failed rollback above).
    fs.rmSync(partial, { recursive: true, force: true });
    console.warn(`[gitnexus] Could not materialize vendor/${name}: ${err.message}`);
    console.warn(
      `[gitnexus] ${name} parsing will be unavailable. Other functionality is unaffected.`,
    );
  }
}
