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
const VENDORED_GRAMMARS = ['tree-sitter-dart', 'tree-sitter-proto', 'tree-sitter-swift'];

if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn(
    '[gitnexus] Skipping vendored grammar materialize (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1). Dart/Proto/Swift parsing will be unavailable.',
  );
  process.exit(0);
}

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
      if (fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, dest);
        } catch {
          // If rollback also fails, the prior backup directory still exists on
          // disk — the catch block below surfaces both errors via the warning.
        }
      }
      throw renameErr;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    // Fail-soft: a single locked/inaccessible file (common on Windows) must not
    // abort the whole gitnexus install. Matches build-tree-sitter-*.cjs pattern.
    fs.rmSync(partial, { recursive: true, force: true });
    console.warn(`[gitnexus] Could not materialize vendor/${name}: ${err.message}`);
    console.warn(
      `[gitnexus] ${name} parsing will be unavailable. Other functionality is unaffected.`,
    );
  }
}
