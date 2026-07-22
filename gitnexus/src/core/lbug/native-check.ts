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

/** Same shape for every optional extension; `FtsProbeResult` is the legacy name. */
export type ExtensionProbeResult = FtsProbeResult;

const DEFAULT_FTS_PROBE_TIMEOUT_MS = 10_000;

/** A LadybugDB query result exposes a synchronous `close()`. */
interface CloseableResult {
  close(): void;
}

/** Close each result, swallowing close-time errors so a successful LOAD is not
 *  misreported as a failure (native-check keeps no static lbug dependency, so it
 *  cannot reuse the adapter's closeQueryResults — that would eagerly load the
 *  module and defeat the dynamic import below). */
const closeProbeResults = (result: unknown): void => {
  for (const r of Array.isArray(result) ? result : [result]) {
    try {
      (r as CloseableResult)?.close?.();
    } catch {
      // ignore — a close failure must not flip a successful LOAD to failed
    }
  }
};

/**
 * Live-probe `LOAD EXTENSION fts` on a throwaway in-memory database.
 *
 * `doctor` used to print the static platform capability, which contradicted
 * analyze whenever the extension file was missing or unloadable (#2374).
 * LOAD never touches the network, so the probe is safe offline, and it
 * surfaces LadybugDB's real error — which distinguishes a missing extension
 * file from a present-but-broken one (wrong platform, truncated download).
 * Dynamic import so doctor still runs when the native module itself is broken.
 *
 * Bounded by `timeoutMs`: an unresponsive extension file (e.g. on a hung
 * network home dir) must never freeze `doctor` — the tool the degradation
 * warnings send users to. `Promise.race` lets doctor report and move on; it
 * cannot cancel an in-flight native call, so a future thread-blocking case
 * would need an out-of-process probe.
 */
export async function probeFtsExtensionLoad(
  timeoutMs: number = DEFAULT_FTS_PROBE_TIMEOUT_MS,
): Promise<FtsProbeResult> {
  return await probeExtensionLoad('fts', timeoutMs);
}

/**
 * Live-probe `LOAD EXTENSION vector`, the VECTOR counterpart of the FTS probe.
 *
 * Needed for the same reason #2374 needed the FTS one, and reported the same
 * way: #2623's reporter saw `doctor` print `VECTOR index: available` while
 * every incremental `analyze` was dying because the extension had not loaded.
 * `doctor` derived that line from a static platform capability, so it read
 * "available" no matter what the extension file was doing.
 *
 * Probes for real on every platform, Windows included: the extension server
 * ships win_amd64 VECTOR artifacts for every 0.18.x extension version (the
 * old blanket Windows refusal was stale, #1365-era). LOAD never touches the
 * network and never invokes the installer, so this probe is exactly as safe
 * as the FTS one above.
 */
export async function probeVectorExtensionLoad(
  timeoutMs: number = DEFAULT_FTS_PROBE_TIMEOUT_MS,
): Promise<ExtensionProbeResult> {
  return await probeExtensionLoad('vector', timeoutMs);
}

/**
 * Shared LOAD probe. `extension` is a fixed internal literal, never user input.
 */
async function probeExtensionLoad(
  extension: 'fts' | 'vector',
  timeoutMs: number,
): Promise<ExtensionProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExtensionProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          loaded: false,
          reason: 'probe timed out — extension file or filesystem unresponsive',
        }),
      timeoutMs,
    );
  });

  const probe = (async (): Promise<ExtensionProbeResult> => {
    try {
      const { default: lbug } = await import('@ladybugdb/core');
      const db = new lbug.Database(':memory:');
      // Nested finallys so `db` is closed even if the Connection ctor throws.
      try {
        const conn = new lbug.Connection(db);
        try {
          const result = await conn.query(`LOAD EXTENSION ${extension}`);
          closeProbeResults(result);
          return { loaded: true };
        } finally {
          await conn.close().catch(() => {});
        }
      } finally {
        await db.close().catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { loaded: false, reason: message.replace(/\s+/g, ' ').trim() };
    }
  })();

  return await Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
}
