import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import lbug from '@ladybugdb/core';
import {
  diagnoseExtensionLoad,
  inspectExtensionBinary,
} from '../../src/core/lbug/extension-load-error.js';
import { requireFtsResourceOrSkip } from '../helpers/fts-availability.js';

/**
 * #2374: exercise the language-independent structural classifier against REAL
 * binaries, not synthetic headers. Registered in cross-platform-tests.ts
 * PLATFORM_LOGIC so it runs on the Windows + macOS matrix too — where
 * `process.execPath` / `lbugjs.node` are real PE / Mach-O files, proving the
 * PE and Mach-O header parsing on genuine binaries (the ubuntu suite covers ELF).
 */

const tmpDirs: string[] = [];
function makeTmpFile(prefix: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return join(dir, name);
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** The real LadybugDB native addon for this platform, if resolvable. */
function resolveLbugNative(): string | null {
  const roots = [`core-${process.platform}-${process.arch}`, 'core'];
  for (const root of roots) {
    const candidate = join(process.cwd(), 'node_modules', '@ladybugdb', root, 'lbugjs.node');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The actual installed FTS extension binary for the running lbug version. */
function resolveInstalledFtsExtension(): string | null {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  const base = join(home, '.lbdb', 'extension', lbug.VERSION);
  try {
    const platformDir = readdirSync(base).find((entry) =>
      statSync(join(base, entry)).isDirectory(),
    );
    if (!platformDir) return null;
    const ext = join(base, platformDir, 'fts', 'libfts.lbug_extension');
    return existsSync(ext) ? ext : null;
  } catch {
    return null;
  }
}

const lbugNative = resolveLbugNative();
const installedFts = resolveInstalledFtsExtension();

describe('structural classifier on real binaries (#2374)', () => {
  it('the running Node executable is a valid host binary', () => {
    // Real ELF (Linux), PE (Windows), or Mach-O (macOS) for the host arch.
    expect(inspectExtensionBinary(process.execPath)).toBe('valid');
  });

  // These inspect the extension FILE directly, so they gate on the artifact's
  // presence — but under GITNEXUS_REQUIRE_FTS=1 a missing artifact is a HARD FAILURE,
  // never a silent skip that could vanish from a green CI run (#2299, #2383 F6d).
  it('the real lbugjs.node native addon is a valid host binary', (ctx) => {
    requireFtsResourceOrSkip(ctx, lbugNative, 'lbugjs.node native addon');
    expect(inspectExtensionBinary(lbugNative)).toBe('valid');
  });

  it('the installed FTS extension is valid → a load failure is missing_dependency, in any language', (ctx) => {
    requireFtsResourceOrSkip(ctx, installedFts, 'installed FTS extension');
    expect(inspectExtensionBinary(installedFts)).toBe('valid');
    // A localized OS tail we do not enumerate — the structural check decides it.
    const reason = `Failed to load library: ${installedFts} which is needed by extension: fts. Error: <localized>`;
    expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'missing_dependency' });
  });

  it('a real valid binary at a *.lbug_extension path diagnoses as missing_dependency', () => {
    const ext = makeTmpFile('real-valid-', 'libfts.lbug_extension');
    copyFileSync(process.execPath, ext);
    const reason = `Failed to load library: ${ext} which is needed by extension: fts. Error: <localized>`;
    expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'missing_dependency' });
  });

  it('a truncated real binary is corrupt', () => {
    const ext = makeTmpFile('real-trunc-', 'libfts.lbug_extension');
    // First 3 bytes of a real binary: a partial magic, too short for any header.
    writeFileSync(ext, readFileSync(process.execPath).subarray(0, 3));
    expect(inspectExtensionBinary(ext)).toBe('corrupt');
  });

  it('a real non-binary file placed as the extension is corrupt', () => {
    const ext = makeTmpFile('real-text-', 'libfts.lbug_extension');
    // A genuine text file (this repo's package.json) — the exact "user dropped the
    // wrong file" mistake, caught structurally with no valid magic.
    copyFileSync(join(process.cwd(), 'package.json'), ext);
    expect(inspectExtensionBinary(ext)).toBe('corrupt');
  });
});
