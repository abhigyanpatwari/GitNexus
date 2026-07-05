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
        'Common causes:',
        '  - pnpm dlx / pnpx skip build scripts by default (security model). Options:',
        '      # Keep pnpm dlx — explicitly allow the required builds:',
        '      pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter \\',
        '        dlx gitnexus@latest serve',
        '      # Or install globally with build scripts allowed (pnpm 10.2+):',
        '      pnpm add -g --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter gitnexus',
        '      # Or npm i -g gitnexus@latest (bare npx on npm 11 may crash before gitnexus runs).',
        '  - bun: add to package.json and reinstall:',
        '      "trustedDependencies": ["@ladybugdb/core"]',
        '  - npm configured with ignore-scripts=true',
        '    (in .npmrc or via --ignore-scripts).',
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
        'If install scripts were skipped (pnpm dlx / pnpx / ignore-scripts):',
        '  pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter \\',
        '    dlx gitnexus@latest serve',
        '  pnpm add -g --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter gitnexus',
        '',
        'If using bun, add to package.json and reinstall:',
        '  "trustedDependencies": ["@ladybugdb/core"]',
      ].join('\n'),
    };
  }

  return { ok: true, binaryPath };
}

export interface FtsProbeResult {
  loaded: boolean;
  /** Collapsed LadybugDB error when `loaded` is false. */
  reason?: string;
}

/**
 * Live-probe `LOAD EXTENSION fts` on a throwaway in-memory database.
 *
 * `doctor` used to print the static platform capability, which contradicted
 * analyze whenever the extension file was missing or unloadable (#2374).
 * LOAD never touches the network, so the probe is safe offline, and it
 * surfaces LadybugDB's real error — which distinguishes a missing extension
 * file from a present-but-broken one (wrong platform, truncated download).
 * Dynamic import so doctor still runs when the native module itself is broken.
 */
export async function probeFtsExtensionLoad(): Promise<FtsProbeResult> {
  try {
    const { default: lbug } = await import('@ladybugdb/core');
    const db = new lbug.Database(':memory:');
    const conn = new lbug.Connection(db);
    try {
      const result = await conn.query('LOAD EXTENSION fts');
      for (const r of Array.isArray(result) ? result : [result]) r.close();
      return { loaded: true };
    } finally {
      await conn.close().catch(() => {});
      await db.close().catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { loaded: false, reason: message.replace(/\s+/g, ' ').trim() };
  }
}
