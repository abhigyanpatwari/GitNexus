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
  if (fs.existsSync(binaryPath)) {
    return { ok: true, binaryPath };
  }

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
