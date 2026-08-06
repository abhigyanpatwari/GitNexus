import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** Cap the out-of-process native load probe so a hung filesystem cannot wedge a
 *  CLI startup gate (same bounding rationale as the extension probe below). */
const NATIVE_LOAD_PROBE_TIMEOUT_MS = 15_000;

/**
 * Why the native check failed. A failed check is NOT necessarily a missing
 * binary — the package may be absent, the binary may be absent, or a binary that
 * is right there may fail to load (host glibc too old, truncated download).
 * Callers that render a status line must tell those apart: reporting all of them
 * as "missing" sends users to reinstall a file they already have (#2672).
 */
export type NativeCheckFailureKind = 'package_missing' | 'binary_missing' | 'load_failed';

export interface NativeCheckResult {
  ok: boolean;
  binaryPath?: string;
  message?: string;
  /** Set only when `ok` is false. */
  kind?: NativeCheckFailureKind;
}

/**
 * Outcome of the prebuilt-binary restore below. Not a boolean, because the two
 * failure modes need OPPOSITE remedies: `no-prebuilt` means nothing was there to
 * copy (a genuinely skipped/absent install — the lifecycle-script advice
 * applies), while `copy-failed` means the binary IS on disk and only writing it
 * into place failed, which is a filesystem permission problem that allowing
 * build scripts cannot fix. Collapsing them sent read-only-`node_modules` users
 * (a baked container layer mounted read-only, a common CI pattern) around the
 * `trustedDependencies` / `--allow-build` loop forever.
 */
type RestoreOutcome = 'restored' | 'no-prebuilt' | 'copy-failed';

/**
 * bun repair advice, shared by both failure messages so they cannot drift.
 *
 * `trustedDependencies` in a package.json is NOT what makes `bunx gitnexus@latest`
 * work — see the note on restorePrebuiltNativeBinary — so a one-shot user, who
 * has no package.json to edit, gets an actionable alternative instead of advice
 * they cannot follow. The package list matches gitnexus/package.json's own
 * `trustedDependencies` field; a partial list leaves tree-sitter unbuilt.
 */
const BUN_REPAIR_LINES = [
  '  - bun: inside a project, add to package.json and reinstall:',
  '      "trustedDependencies": ["@ladybugdb/core", "gitnexus", "tree-sitter"]',
  '    A one-shot `bunx gitnexus@latest …` has no package.json to put that in —',
  '    install once instead:  bun install -g gitnexus',
];

/**
 * Re-do the copy `@ladybugdb/core`'s install script performs, when a package
 * manager skipped that script but still downloaded the prebuilt binary.
 *
 * The binary is published in a per-platform optional sub-package
 * (`@ladybugdb/core-<platform>-<arch>`) and the install script only copies it up
 * into the main package. Every "install lifecycle script was skipped" case
 * therefore has the file sitting on disk one directory over, and this restores
 * it without a network fetch or a source build.
 *
 * Load-bearing for `bunx gitnexus@latest …`: bun skips lifecycle scripts for a
 * `bunx` fetch and has no per-invocation opt-in (its `--trust` flag writes
 * trustedDependencies into a project package.json, which a one-shot has none
 * of), AND bun re-extracts the package on every `bunx` run — so a manual repair
 * is wiped before the next invocation and in-process recovery is the only thing
 * that can work. Also covers `pnpm dlx` without `--allow-build` and
 * `npm --ignore-scripts`.
 *
 * This — not the `trustedDependencies` field in gitnexus/package.json — is what
 * makes the bunx lane work. That field only takes effect for someone running
 * `bun install` / `pnpm install` INSIDE this repo: a `bunx gitnexus@latest`
 * one-shot never reads it, and neither does `bun add gitnexus` in a consumer
 * project (trust is read from the consumer's own root manifest, not from a
 * dependency's). Do not delete this function as redundant with that field.
 *
 * Best-effort by construction: any failure (read-only node_modules, absent
 * sub-package, unsupported platform) returns a non-`'restored'` outcome and the
 * caller falls through to the existing diagnostics unchanged.
 */
function restorePrebuiltNativeBinary(pkgDir: string, binaryPath: string): RestoreOutcome {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as {
      name?: unknown;
    };
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) return 'no-prebuilt';

    const candidates: string[] = [];
    try {
      // require.resolve finds the sub-package regardless of hoisting depth,
      // matching how the install script locates it.
      const subPkg = createRequire(import.meta.url).resolve(
        `${manifest.name}-${process.platform}-${process.arch}/package.json`,
        { paths: [pkgDir] },
      );
      candidates.push(path.join(path.dirname(subPkg), 'lbugjs.node'));
    } catch {
      // Sub-package not installed (unsupported platform or missing optionalDep).
    }
    // Legacy prebuilt/ layout, for tarballs published before the per-platform
    // sub-package migration — the same fallback order the install script uses.
    candidates.push(
      path.join(pkgDir, 'prebuilt', `lbugjs-${process.platform}-${process.arch}.node`),
    );

    const prebuilt = candidates.find((candidate) => fs.existsSync(candidate));
    if (prebuilt === undefined) return 'no-prebuilt';

    // The copy gets its own catch: an EACCES/EROFS here is the one failure that
    // proves the binary exists and only the write was refused, and the outer
    // catch would flatten that back into "nothing to restore".
    try {
      fs.copyFileSync(prebuilt, binaryPath);
    } catch {
      return 'copy-failed';
    }
    return fs.existsSync(binaryPath) ? 'restored' : 'copy-failed';
  } catch {
    return 'no-prebuilt';
  }
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
        kind: 'package_missing',
        message: [
          'LadybugDB package (@ladybugdb/core) is not installed.',
          '',
          'Run:  npm install',
        ].join('\n'),
      };
    }
  }

  const binaryPath = path.join(pkgDir, 'lbugjs.node');
  // A missing binary is recoverable whenever the prebuilt sub-package is present
  // — the install script's copy is all that was skipped. Try that before
  // reporting failure, so runners that cannot opt into lifecycle scripts (bunx)
  // work instead of dead-ending on instructions they have no way to follow.
  const restore = fs.existsSync(binaryPath)
    ? 'restored'
    : restorePrebuiltNativeBinary(pkgDir, binaryPath);
  if (restore !== 'restored') {
    // `copy-failed` proves the prebuilt binary is on disk and only the write was
    // refused, so the entire skipped-lifecycle-script cause list below is the
    // wrong remedy — a read-only node_modules cannot be repaired in place no
    // matter which build scripts are allowed. Route that case to its own advice.
    const cause =
      restore === 'copy-failed'
        ? [
            'The prebuilt binary IS present in the platform sub-package — only copying it into',
            `  ${pkgDir}`,
            'was refused, which is a filesystem permission problem (read-only or non-writable',
            'node_modules), not a skipped install script.',
            '',
            'To repair, make that directory writable, or reinstall gitnexus somewhere writable:',
            '  npm i -g gitnexus@latest   # or: bun install -g gitnexus',
            '',
            'Allowing build scripts (trustedDependencies, --allow-build, ignore-scripts) will',
            'NOT help here — the install script fails on the same write.',
          ]
        : [
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
            ...BUN_REPAIR_LINES,
            '  - npm configured with ignore-scripts=true',
            '    (in .npmrc or via --ignore-scripts).',
          ];
    return {
      ok: false,
      binaryPath,
      kind: 'binary_missing',
      message: ['LadybugDB native binary (lbugjs.node) is missing.', '', ...cause].join('\n'),
    };
  }

  // Validate loadability in a THROWAWAY CHILD PROCESS, not in-process. A merely
  // truncated or corrupted .node (valid header, missing pages) does not throw a
  // catchable error — it SIGBUSes the dynamic loader mid-dlopen, which would take
  // the whole CLI down with a raw exit 135 and no guidance (#2441). Loading it in
  // a child lets us observe that crash (a non-zero exit or a kill signal) and turn
  // it into the same actionable failure as a clean load error. The child requires
  // the binary by absolute path, exactly as the former in-process load did.
  const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', binaryPath], {
    encoding: 'utf8',
    timeout: NATIVE_LOAD_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Run as Node even if process.execPath is an Electron/embedder binary.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  // Only a child that actually RAN and failed proves the binary is bad. If the
  // probe could not run at all — a spawn error or a timeout, e.g. a sandbox that
  // forbids subprocesses or a non-Node execPath — we could not test the binary,
  // so we stay out of the way and let the command's own load be the authority
  // rather than condemn a healthy binary. (#2441 still holds: a genuinely broken
  // binary loaded in-process later still exits non-zero.)
  if (probe.error || probe.status === 0) {
    return { ok: true, binaryPath };
  }

  // One failure class is NOT repairable by reinstalling: a host whose glibc is
  // older than the prebuilt binary requires. Every download ships the same
  // binary, so the generic advice below sends the user around a loop that always
  // ends here (#2672). Branch before it, and only here — on the arm where the
  // probe actually ran and failed, so an unrunnable probe still fails open above.
  const glibcExplanation = glibcTooOldMessage(probe.stderr ?? '');
  if (glibcExplanation !== null) {
    return {
      ok: false,
      binaryPath,
      kind: 'load_failed',
      message: [
        'LadybugDB native binary (lbugjs.node) exists but failed to load:',
        `  ${describeNativeLoadFailure(probe)}`,
        '',
        glibcExplanation,
      ].join('\n'),
    };
  }

  return {
    ok: false,
    binaryPath,
    kind: 'load_failed',
    message: [
      'LadybugDB native binary (lbugjs.node) exists but failed to load:',
      `  ${describeNativeLoadFailure(probe)}`,
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
      ...BUN_REPAIR_LINES,
    ].join('\n'),
  };
}

/**
 * Describe a child-observed native load failure. Reached only after a probe that
 * actually ran and failed: a fatal signal (SIGBUS/SIGSEGV ⇒ truncated/corrupt
 * binary), otherwise the child's own load error lifted from its stderr.
 */
function describeNativeLoadFailure(probe: SpawnSyncReturns<string>): string {
  if (probe.signal) {
    return `crashed while loading (signal ${probe.signal}) — the binary is likely truncated or corrupted`;
  }
  const lines = (probe.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.find((line) => /^\w*Error: /.test(line));
  return (
    errorLine?.replace(/^\w*Error:\s*/, '') ??
    lines.at(-1) ??
    `exited with code ${probe.status ?? 'unknown'}`
  );
}

/**
 * A `GLIBC_<version>` token. The dynamic loader names the first unresolved
 * versioned symbol as ``version `GLIBC_2.34' not found (required by …)``, but we
 * key on the token plus a "not found" line rather than on glibc's exact
 * backtick/apostrophe quoting: if that wording ever changes, this degrades to
 * the generic failure message instead of misfiring.
 */
const GLIBC_VERSION_TOKEN = /GLIBC_(\d+(?:\.\d+)+)/g;

/** Numeric dotted-segment order — glibc 2.9 is OLDER than 2.34, not newer. */
function compareDottedVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * This host's runtime glibc, or null when Node cannot report it (musl builds,
 * embedders without `process.report`). Read locally rather than through
 * analyzer-identity's `detectLibcVariant`: that module is deliberately reached
 * via dynamic import from the CLI lazy actions, and this file is the
 * dependency-light startup gate that must not pull it in.
 */
function hostGlibcVersion(): string | null {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const runtime = report?.header?.glibcVersionRuntime;
    return typeof runtime === 'string' && runtime.length > 0 ? runtime : null;
  } catch {
    // Report generation is optional on some embedded Node builds; an unknown
    // host version still leaves the required version worth printing.
    return null;
  }
}

/**
 * Explain a glibc-too-old native load failure, or null when the probe's stderr
 * describes something else.
 *
 * Reinstalling cannot fix this class — the package ships one prebuilt binary per
 * platform — so the caller must NOT fall through to the reinstall instructions
 * (#2672). Exported for direct unit testing: a real `GLIBC_2.34' not found`
 * cannot be provoked on a host whose glibc is new enough to run the tests.
 */
export function glibcTooOldMessage(stderr: string): string | null {
  const required = stderr
    .split('\n')
    .filter((line) => /not found/i.test(line))
    .flatMap((line) => [...line.matchAll(GLIBC_VERSION_TOKEN)].map((match) => match[1]))
    .sort(compareDottedVersions)
    .at(-1);
  if (required === undefined) return null;

  const host = hostGlibcVersion();
  return [
    "This host's C library (glibc) is older than the prebuilt binary requires.",
    `  required:  glibc ${required} or newer`,
    `  this host: ${host === null ? 'glibc version could not be determined' : `glibc ${host}`}`,
    '',
    'Reinstalling will NOT help — every download ships the same prebuilt binary.',
    '',
    'Options:',
    `  - Run GitNexus on a distribution with glibc ${required} or newer`,
    '    (Ubuntu 22.04+, RHEL/Rocky/Alma 9+, Debian 12+, Fedora 35+).',
    '  - Or use the GitNexus container image, which bundles a current glibc.',
  ].join('\n');
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
