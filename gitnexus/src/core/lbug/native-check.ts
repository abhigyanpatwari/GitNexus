import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

export interface NativeCheckResult {
  ok: boolean;
  binaryPath?: string;
  message?: string;
}

export function checkLbugNative(overridePkgDir?: string): NativeCheckResult {
  let pkgDir: string;

  if (overridePkgDir) {
    pkgDir = overridePkgDir;
  } else {
    try {
      const _require = createRequire(import.meta.url);
      const mainEntry = _require.resolve('@ladybugdb/core');
      pkgDir = path.dirname(mainEntry);
    } catch {
      return {
        ok: false,
        message: [
          'LadybugDB package (@ladybugdb/core) is not installed.',
          '',
          'Run:  npm install',
        ].join('\n'),
      };
    }
  }

  const binaryPath = path.join(pkgDir, 'lbugjs.node');
  if (!fs.existsSync(binaryPath)) {
    return {
      ok: false,
      binaryPath,
      message: [
        'LadybugDB native binary (lbugjs.node) is missing.',
        '',
        'This usually happens when the install lifecycle script was skipped.',
        '',
        'To repair:',
        `  node ${path.join(pkgDir, 'install.js')}`,
        '',
        'If using bun, add to package.json and reinstall:',
        '  "trustedDependencies": ["@ladybugdb/core"]',
        '',
        'Also check that npm is not configured with ignore-scripts=true',
        '(in .npmrc or via --ignore-scripts).',
      ].join('\n'),
    };
  }

  try {
    const _require = createRequire(import.meta.url);
    _require(binaryPath);
  } catch (err: unknown) {
    const nativeError = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      binaryPath,
      message: [
        'LadybugDB native binary (lbugjs.node) exists but failed to load:',
        `  ${nativeError}`,
        '',
        'This can happen with a truncated file, ABI mismatch, or wrong-platform binary.',
        '',
        'To repair:',
        `  node ${path.join(pkgDir, 'install.js')}`,
        '',
        'If using bun, add to package.json and reinstall:',
        '  "trustedDependencies": ["@ladybugdb/core"]',
      ].join('\n'),
    };
  }

  return { ok: true, binaryPath };
}
