import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { isMainThread } from 'worker_threads';
import type lbug from '@ladybugdb/core';
import { logger } from '../logger.js';

// ─── Windows non-ASCII path workaround (#1811) ───────────────────────────────
//
// KuzuDB's native C++ layer on Windows uses CreateFileA (ANSI), not
// CreateFileW. Non-ASCII path bytes from Node.js (UTF-8) are
// misinterpreted via the system's Active Code Page (e.g. GBK), producing
// a garbled path — "Error 3: The system cannot find the path."
//
// Layered workaround:
//   1. Try 8.3 short-name form (fast, no persistent state)
//   2. Fall back to an NTFS junction from an ASCII temp path
//   3. If both fail, log a diagnostic and return the original path

const NON_ASCII_RE = /[^\x00-\x7F]/;
const JUNCTION_PREFIX = 'gitnexus-junction-';

const activeJunctions = new Set<string>();
let cleanupRegistered = false;
let orphanScanDone = false;

function junctionHash(targetDir: string): string {
  return crypto.createHash('sha256').update(targetDir).digest('hex').slice(0, 16);
}

function tryShortPath(p: string): string | null {
  try {
    // Pass the path via environment variable so the command string is
    // static — avoids CodeQL command-injection taint (the path never
    // appears in the shell command text).
    const result = execFileSync('cmd.exe', ['/c', 'for %I in ("%GITNEXUS_SP%") do @echo %~sI'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GITNEXUS_SP: p },
    });
    const shortPath = result.trim();
    if (
      shortPath &&
      !NON_ASCII_RE.test(shortPath) &&
      (!shortPath.includes('?') || p.includes('?'))
    ) {
      return shortPath;
    }
  } catch {
    // 8.3 unavailable or cmd failed
  }
  return null;
}

function tryJunction(targetDir: string, leaf: string): string | null {
  const hash = junctionHash(targetDir);
  const junctionLink = path.join(os.tmpdir(), `${JUNCTION_PREFIX}${hash}`);

  if (fsSync.existsSync(junctionLink)) {
    try {
      const existing = fsSync.readlinkSync(junctionLink);
      if (path.resolve(existing) === path.resolve(targetDir)) {
        activeJunctions.add(junctionLink);
        return path.join(junctionLink, leaf);
      }
      fsSync.rmSync(junctionLink, { recursive: true, force: true });
    } catch {
      // Stale or broken junction — remove and recreate
      try {
        fsSync.rmSync(junctionLink, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  try {
    fsSync.symlinkSync(targetDir, junctionLink, 'junction');
    activeJunctions.add(junctionLink);
    return path.join(junctionLink, leaf);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      try {
        const existing = fsSync.readlinkSync(junctionLink);
        if (path.resolve(existing) === path.resolve(targetDir)) {
          activeJunctions.add(junctionLink);
          return path.join(junctionLink, leaf);
        }
      } catch {
        /* cannot verify — fall through */
      }
    }
  }
  return null;
}

function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('exit', () => cleanupNativePathJunctions());

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      cleanupNativePathJunctions();
      if (process.platform === 'win32') {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      } else {
        process.kill(process.pid, signal);
      }
    });
  }
}

function scanOrphanedJunctions(): void {
  if (orphanScanDone) return;
  orphanScanDone = true;
  try {
    const tmpdir = os.tmpdir();
    const entries = fsSync.readdirSync(tmpdir);
    for (const entry of entries) {
      if (!entry.startsWith(JUNCTION_PREFIX)) continue;
      const junctionPath = path.join(tmpdir, entry);
      try {
        const target = fsSync.readlinkSync(junctionPath);
        try {
          fsSync.lstatSync(target);
        } catch {
          fsSync.rmSync(junctionPath, { recursive: true, force: true });
        }
      } catch {
        // Not a symlink/junction or unreadable — leave it
      }
    }
  } catch {
    // tmpdir unreadable — skip scan
  }
}

export function cleanupNativePathJunctions(): void {
  for (const junctionPath of activeJunctions) {
    try {
      fsSync.rmSync(junctionPath, { recursive: true, force: true });
    } catch {
      // Best effort — EPERM on Windows is common during exit
    }
  }
  activeJunctions.clear();
}

export function toNativeSafePath(p: string): string {
  if (process.platform !== 'win32') return p;
  if (!NON_ASCII_RE.test(p)) return p;

  if (isMainThread) {
    scanOrphanedJunctions();
    registerCleanupHandlers();
  }

  const shortPath = tryShortPath(p);
  if (shortPath) return shortPath;

  if (!isMainThread) {
    logger.warn(
      `GitNexus: non-ASCII path in worker thread — junction fallback skipped. ` +
        `Path: "${p}". 8.3 short names may need to be enabled on this volume.`,
    );
    return p;
  }

  const targetDir = path.dirname(p);
  const leaf = path.basename(p);
  if (fsSync.existsSync(targetDir)) {
    const junctionResult = tryJunction(targetDir, leaf);
    if (junctionResult) return junctionResult;
  }

  logger.warn(
    `GitNexus: non-ASCII path "${p}" could not be converted to an ASCII-safe form. ` +
      'LadybugDB may fail with "Cannot open file." To fix: move the repo to a path ' +
      'without CJK/Unicode characters, or enable 8.3 short names on this volume ' +
      '(fsutil 8dot3name set 0).',
  );
  return p;
}

/**
 * Resolve the on-disk CSV staging dir for `<storagePath>/<subdir>`, applying the
 * same ASCII-safe relocation `toNativeSafePath` enables: on Windows with a
 * non-ASCII storage path, LadybugDB's bulk COPY cannot open files under that
 * path, so the dir is relocated under `os.tmpdir()`. Shared by the structural
 * `csv/` dir and the streaming `pdg-csv/` dir (#2202) so the two can never
 * diverge on platform handling; the `gitnexus-<subdir>-` prefix keeps their tmp
 * locations distinct and recognizable.
 *
 * The relocated dir is created with `fs.mkdtempSync` (a unique, mode-0700,
 * guaranteed-not-pre-existing suffix) rather than a deterministic
 * `gitnexus-<subdir>-<hash>` name. A predictable name in the world-readable OS
 * temp dir is information-disclosure-prone and pre-plantable
 * (CWE-377/378 / CodeQL `js/insecure-temporary-file`); mkdtemp's random suffix
 * is the documented mitigation and is what reaches the streaming sink's
 * `fs.openSync`. The non-Windows / ASCII path stays a pure `path.join` (no dir
 * created) and is byte-identical to before.
 */
export function resolveNativeSafeStorageDir(storagePath: string, subdir: string): string {
  if (process.platform === 'win32' && NON_ASCII_RE.test(storagePath)) {
    // 8.3-shorten the tmpdir base first (a non-ASCII Windows *profile* path can
    // make os.tmpdir() itself non-ASCII), THEN mkdtemp so the returned path —
    // the one that flows into fs.openSync — is provably mkdtemp-sourced (random,
    // exclusive) and clears the insecure-temp-file dataflow.
    const base = toNativeSafePath(os.tmpdir());
    return fsSync.mkdtempSync(path.join(base, `gitnexus-${subdir}-`));
  }
  return path.join(storagePath, subdir);
}

/**
 * Shared configuration for `@ladybugdb/core` `Database` construction.
 *
 * Two values changed meaningfully in `@ladybugdb/core` 0.16.0 and need to be
 * pinned explicitly by every caller, otherwise GitNexus regresses:
 *
 * 1. `maxDBSize` defaults to `0`, which the native runtime interprets as
 *    "use the platform's full mmap address space" — typically 8 TB on
 *    64-bit Linux. Constrained environments (CI runners, containers, WSL)
 *    cannot reserve that much address space and crash with
 *    `Buffer manager exception: Mmap for size 8796093022208 failed.`
 *    See LadybugDB upstream JSDoc:
 *    > "introduced temporarily for now to get around with the default 8TB
 *    > mmap address space limit some environment".
 *
 * 2. `enableCompression` flipped its default from `false` (0.15.x) to
 *    `true` (0.16.0). Existing call sites that relied on the positional
 *    default must now pass `false` explicitly to preserve behaviour.
 *
 * 3. `bufferManagerSize` (not a 0.16.0 change, same pin-explicitly
 *    principle): `0` means "native default", and the native default buffer
 *    pool is 80% of physical RAM. A long-lived `gitnexus mcp` process or a
 *    large incremental analyze can balloon to that ceiling and OOM-kill the
 *    host session (#2557), so GitNexus pins an explicit bounded pool — see
 *    `resolveBufferManagerSize`.
 *
 * Putting these in one shared module guarantees every `new lbug.Database(...)`
 * call site agrees on the same ceilings and behaviour.
 */

/**
 * Upper bound for any single GitNexus LadybugDB file (graph index, group
 * bridge, install scratch, test fixture). 16 GiB is intentionally generous
 * for real-world code graphs (the GitNexus self-index uses < 50 MiB) while
 * remaining far below any 64-bit OS mmap ceiling.
 *
 * Override with the `GITNEXUS_LBUG_MAX_DB_SIZE` environment variable when
 * indexing genuinely huge monorepos. Values are coerced to a positive
 * integer; anything invalid falls back to the default.
 */
export const LBUG_MAX_DB_SIZE: number = (() => {
  const raw = process.env.GITNEXUS_LBUG_MAX_DB_SIZE;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 16 * 1024 * 1024 * 1024;
})();

export const parseWalCheckpointThreshold = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < -1) return undefined;
  return parsed;
};

/**
 * Default GitNexus WAL auto-checkpoint threshold in bytes (64 MiB).
 *
 * Larger than Ladybug's stock ~16 MiB to reduce checkpoint rename/remove
 * churn under heavy analyze write load — the original race that motivated
 * issue #1741 triggered at the stock threshold. README examples in
 * `README.md` and `gitnexus/README.md` and the recovery hint in
 * `analyze.ts` MUST stay in sync with this value.
 */
const DEFAULT_WAL_CHECKPOINT_THRESHOLD = 64 * 1024 * 1024;

const resolveCheckpointThreshold = (): number => {
  const raw = process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;
  if (raw === undefined) return DEFAULT_WAL_CHECKPOINT_THRESHOLD;
  const parsed = parseWalCheckpointThreshold(raw);
  if (parsed !== undefined) return parsed;
  // Non-empty but unparseable input: warn the operator and fall back. Mirrors
  // the CLI's `--wal-checkpoint-threshold` validation (which hard-errors)
  // but the env-var path stays soft to preserve "set once in your shell"
  // ergonomics across mixed-version invocations.
  if (raw.trim().length > 0) {
    logger.warn(
      { rawValue: raw, fallback: DEFAULT_WAL_CHECKPOINT_THRESHOLD },
      `Ignoring invalid GITNEXUS_WAL_CHECKPOINT_THRESHOLD=${raw}; expected integer >= -1; falling back to default (${DEFAULT_WAL_CHECKPOINT_THRESHOLD}).`,
    );
  }
  return DEFAULT_WAL_CHECKPOINT_THRESHOLD;
};

/**
 * Default ceiling for the LadybugDB buffer pool in bytes (#2557).
 *
 * The pool is a page cache with eviction, so the ceiling trades throughput
 * on very large working sets for a machine that stays alive: 2 GiB is
 * ~40× the GitNexus self-index, while the native 80%-of-RAM default let a
 * `detect_changes` call grow a 105 MiB on-disk index to 19.5 GiB RSS and
 * OOM-kill the reporter's session. The `min` with 80% of `os.totalmem()`
 * keeps sub-2.5-GiB machines at the native-equivalent bound (no regression
 * there); the 64 MiB floor keeps tiny containers above any plausible
 * native minimum pool size.
 */
const DEFAULT_BUFFER_POOL_CAP = 2 * 1024 * 1024 * 1024;
const BUFFER_POOL_FLOOR = 64 * 1024 * 1024;

// COPY-safety floor for the adaptive hint (below). LadybugDB's bulk COPY needs
// working buffer-pool memory that scales with the repo: a 64 MiB pool fails
// ("buffer pool is full and no memory could be freed") on any non-trivial repo,
// and even the ~1800-file GitNexus checkout needs ≥256 MiB. So the adaptive
// size never drops a repo below this — a distinct, higher floor than
// BUFFER_POOL_FLOOR, which only guards defaultBufferPoolSize on tiny-RAM
// machines. It is still clamped up to defaultBufferPoolSize, so a machine whose
// default is below this floor keeps its default rather than over-committing.
const ADAPTIVE_POOL_FLOOR = 256 * 1024 * 1024;

const parseBufferPoolSize = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
};

/**
 * The buffer-manager frame size compiled into every shipped `@ladybugdb/core`
 * binary (`LBUG_PAGE_SIZE_LOG2 = 12` in the engine's CMake) — frames are 4 KiB
 * on every platform, independent of the OS page size.
 */
const LBUG_ASSUMED_FRAME_SIZE = 4096;

/**
 * How much the OS page size amplifies buffer-pool consumption (#2631).
 *
 * LadybugDB's VM region charges pool budget per DISCARD GRANULE, not per
 * frame: `discardGranuleSize = max(frameSize, osPageSize)` (vm_region.cpp),
 * `claimFrame` bills the whole granule when its first 4 KiB frame becomes
 * resident, and `releaseFrame` refunds only when the granule's LAST frame
 * leaves. On a 64 KiB-page kernel (aarch64 openEuler — Ascend hosts) that is
 * 16 frames per granule: scattered access is billed up to 16× its real bytes,
 * and whole eviction passes can evict frames yet refund nothing — which is
 * exactly the engine's "buffer pool is full and no memory could be freed"
 * throw. Apple Silicon macOS (16 KiB pages) is the same mechanism at 4×.
 *
 * So the ANALYZE-path pool sizes (the per-element estimate, the COPY-safety
 * floor, and the cap the hint is clamped against) are scaled by this ratio:
 * the budget must cover worst-case granule charging or COPY dies on non-4K
 * hosts with a pool that would be ample on x86. The hintless default
 * (defaultBufferPoolSize — MCP serve, doctor, native-check) is deliberately
 * NOT scaled: the pool is a native eager allocation committed at DB open
 * (measured — see POOL_BYTES_PER_ELEMENT below), so scaling the global
 * default would revert the #2557 OOM cap on every 16 KiB/64 KiB host. If the
 * engine ever charges per-frame (or ships page-size-matched frames), this
 * collapses back to 1 and the scaling disappears.
 *
 * Fail-safe: an undetectable page size (win32 — where the granule mechanism
 * is absent anyway — or a failed `getconf`) means ratio 1, i.e. today's
 * behavior.
 */
export const granuleRatio = (pageSize: number | undefined = getOsPageSize()): number => {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return 1;
  return Math.max(1, Math.floor(pageSize / LBUG_ASSUMED_FRAME_SIZE));
};

/**
 * Hintless pool default — MCP serve, doctor, native-check, any open without a
 * per-run hint. Deliberately UNSCALED (#2557): the pool is an eager native
 * allocation at DB open, so a page-size-scaled default would hand a
 * long-lived `gitnexus mcp` on a 16 KiB/64 KiB host up to 80% of RAM — the
 * exact OOM exposure the 2 GiB cap was added to remove.
 */
const defaultBufferPoolSize = (): number =>
  Math.min(DEFAULT_BUFFER_POOL_CAP, Math.max(BUFFER_POOL_FLOOR, Math.floor(os.totalmem() * 0.8)));

/**
 * Upper bound for the ANALYZE-path (hinted) pool: the #2557 cap scaled by the
 * granule ratio, still bounded by 80% of RAM. Scaling only this bound — and
 * not defaultBufferPoolSize — is what lets the #2631 fix take effect during
 * the bulk COPY without touching hintless opens: with an unscaled cap the
 * min() below would clamp the scaled COPY floor straight back to 2 GiB.
 */
const scaledAnalyzePoolCap = (pageSize: number | undefined): number =>
  Math.min(
    DEFAULT_BUFFER_POOL_CAP * granuleRatio(pageSize),
    Math.max(BUFFER_POOL_FLOOR, Math.floor(os.totalmem() * 0.8)),
  );

/**
 * Clamp an adaptive pool request to [ADAPTIVE_POOL_FLOOR × granuleRatio,
 * scaledAnalyzePoolCap]. The lower bound keeps LadybugDB's COPY viable
 * (scaled because the granule accounting inflates consumption on non-4K
 * hosts, see granuleRatio); the upper bound means the hint can never exceed
 * the page-size-scaled #2557 cap or 80% of RAM — and on a machine whose cap
 * is below the COPY floor, the cap wins, so the pool is never over-committed.
 * On 4 KiB hosts (ratio 1) this is byte-identical to clamping against the
 * hintless default.
 */
const clampBufferPool = (bytes: number, pageSize: number | undefined = getOsPageSize()): number =>
  Math.min(
    scaledAnalyzePoolCap(pageSize),
    Math.max(ADAPTIVE_POOL_FLOOR * granuleRatio(pageSize), Math.floor(bytes)),
  );

/**
 * Buffer-pool bytes to provision per graph element (node + relationship).
 *
 * The fixed 2 GiB default is far larger than most repos' working set, and
 * LadybugDB eagerly commits the pool at DB open — measured: a full
 * `analyze --force` of the GitNexus checkout takes ~51 s with the 2 GiB pool
 * vs ~35 s with the ~414 MiB this factor yields (31% faster; the oversized
 * pool's commit dominates). The pool is a page cache over the on-disk index,
 * which scales with node/edge count, so a per-element budget sizes it to the
 * repo. Kept generous so the whole index stays resident (no COPY thrash) and
 * always clamped to at least ADAPTIVE_POOL_FLOOR; tuned by timing a real
 * large-repo `analyze --force` at this factor vs a forced 2 GiB pool (the pool
 * is a native eager allocation, measured with a real analyze, not a build-free
 * bench — see the emit-path COPY timing note in bench/emit-persistence).
 */
const POOL_BYTES_PER_ELEMENT = 4 * 1024;

/**
 * Size the buffer pool to an estimated graph size (node + relationship count),
 * clamped to [ADAPTIVE_POOL_FLOOR, scaledAnalyzePoolCap], with every term
 * scaled by granuleRatio (#2631): on non-4K hosts the engine bills pool
 * budget per OS-page-sized granule, so the same graph consumes up to
 * pageSize/4096 × the budget it needs on x86. On 4 KiB hosts the ratio is 1
 * and this is byte-identical to the pre-#2631 behavior. The estimate is never
 * above the page-size-scaled #2557 cap bounded by 80% of RAM, never below the
 * scaled COPY-safety floor; the hintless default stays unscaled.
 *
 * `pageSize` is a test seam (the pageSizeDoctorLines convention); production
 * callers omit it and get the memoized real OS page size.
 */
export const estimateBufferPool = (
  graphElementCount: number,
  pageSize: number | undefined = getOsPageSize(),
): number =>
  clampBufferPool(graphElementCount * POOL_BYTES_PER_ELEMENT * granuleRatio(pageSize), pageSize);

/**
 * Optional per-run buffer-pool size hint (bytes). The analyze orchestrator sets
 * it once the graph size is known (after the pipeline, before the DB open) so
 * the pool is sized to the repo instead of the fixed 2 GiB default, and clears
 * it at run end. Non-analyze opens (MCP serve, `native-check` `:memory:`) never
 * set it and keep the default.
 */
let bufferPoolSizeHint: number | undefined;

/** Set (bytes) or clear (`undefined`) the per-run buffer-pool size hint. */
export const setBufferPoolSizeHint = (bytes: number | undefined): void => {
  bufferPoolSizeHint = bytes;
};

/**
 * Resolve the `bufferManagerSize` passed to every `new lbug.Database(...)`.
 * `GITNEXUS_LBUG_BUFFER_POOL_SIZE` (bytes) overrides everything; `0` is a
 * deliberate escape hatch that restores LadybugDB's native unbounded
 * 80%-of-RAM default. With no env override, a per-run `setBufferPoolSizeHint`
 * (clamped to [floor, default]) sizes the pool to the repo; otherwise the
 * default. Resolved at call time (not module load) so tests can stub the env
 * var, the hint, and `os.totalmem`.
 */
const resolveBufferManagerSize = (): number => {
  const raw = process.env.GITNEXUS_LBUG_BUFFER_POOL_SIZE;
  if (raw === undefined) {
    return bufferPoolSizeHint !== undefined
      ? clampBufferPool(bufferPoolSizeHint)
      : defaultBufferPoolSize();
  }
  const parsed = parseBufferPoolSize(raw);
  if (parsed !== undefined) return parsed;
  // Non-empty but unparseable input: warn the operator and fall back —
  // mirrors the GITNEXUS_WAL_CHECKPOINT_THRESHOLD env path above.
  if (raw.trim().length > 0) {
    logger.warn(
      { rawValue: raw, fallback: defaultBufferPoolSize() },
      `Ignoring invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE=${raw}; expected integer >= 0 (bytes; 0 restores the native 80%-of-RAM default); falling back to the platform default pool size.`,
    );
  }
  return defaultBufferPoolSize();
};

/**
 * Doctor-facing view of the pool size the next Database open would get
 * (#2631): env override > clamped hint > unscaled hintless default. Read-only;
 * doctor prints it next to the page-size lines so support triage sees the
 * sizing inputs at a glance. `0` is the pass-through sentinel for LadybugDB's
 * native 80%-of-RAM default — callers must label it, not print "0 MiB".
 */
export const getEffectiveBufferPoolSize = (): number => resolveBufferManagerSize();

/**
 * Matches the engine's buffer-pool exhaustion throw (buffer_manager.cpp:
 * "Unable to allocate memory! The buffer pool is full and no memory could be
 * freed!"). Distinct from isLbugPageSizeFrameError above, which matches the
 * madvise/frame-release failure class.
 */
const BUFFER_POOL_EXHAUSTION_RE = /buffer pool is full|unable to allocate memory/i;

const formatMiB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MiB`;

/**
 * Actionable remedy for a buffer-pool exhaustion error (#2631), or undefined
 * when `message` is not that class. Cause → consequence → remedy, the
 * diagnoseExtensionLoad convention: names the effective pool, the override
 * knob, and — on non-4K hosts — the granule amplification that makes the
 * budget exhaust early (the reporter's Ascend/aarch64 64 KiB kernel billed a
 * pool up to 16× faster than the same analyze on x86).
 */
export const bufferPoolExhaustionRemedy = (
  message: string,
  pageSize: number | undefined = getOsPageSize(),
): string | undefined => {
  if (!BUFFER_POOL_EXHAUSTION_RE.test(message)) return undefined;
  const ratio = granuleRatio(pageSize);
  const pool = resolveBufferManagerSize();
  // 0 is the pass-through sentinel (GITNEXUS_LBUG_BUFFER_POOL_SIZE=0 →
  // LadybugDB's native 80%-of-RAM default) — "0 MiB" would be nonsense in the
  // very triage text this remedy exists to provide.
  const poolLabel = pool === 0 ? "LadybugDB's native 80%-of-RAM default" : formatMiB(pool);
  const pageNote =
    ratio > 1
      ? ` This host's ${(pageSize ?? 0) / 1024} KiB OS page size makes the engine bill pool ` +
        `memory in ${(pageSize ?? 0) / 1024} KiB granules — up to ${ratio}× faster budget use ` +
        `than a 4 KiB-page host running the same analyze.`
      : '';
  return (
    `The LadybugDB buffer pool (${poolLabel}) was exhausted during the bulk COPY.` +
    pageNote +
    ` Set GITNEXUS_LBUG_BUFFER_POOL_SIZE=<bytes> to raise it (e.g. ${4 * 1024 * 1024 * 1024}` +
    ` for 4 GiB); 0 restores LadybugDB's native 80%-of-RAM default.`
  );
};

/** Matches WAL corruption errors from the LadybugDB engine. */
const WAL_CORRUPTION_RE = /corrupt(ed)?\s+wal|invalid\s+wal\s+record|wal.*corrupt|checksum.*wal/i;

export const WAL_RECOVERY_SUGGESTION =
  'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.';

export function isWalCorruptionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return WAL_CORRUPTION_RE.test(msg);
}

// ─── Ladybug WAL checkpoint IO error matchers ───────────────────────────────
//
// Matched against LadybugDB v0.18.0 (see `gitnexus/package.json`
// @ladybugdb/core). Strict regexes encode local_file_system.cpp wording
// verified at that version. Two-tier strategy: strict matchers first so we
// only fire on real checkpoint-rotation shapes; a permissive fallback
// catches future Ladybug message drift so the recovery hint keeps surfacing
// even if upstream wording changes.
//
// From Ladybug native LocalFileSystem exceptions (`local_file_system.cpp`),
// surfaced in Node as:
// "Runtime exception: IO exception: Error renaming file ..."
// "Runtime exception: IO exception: Error removing directory or file ..."
// We only match checkpoint-rotation shapes:
//   - "<db>.wal -> <db>.wal.checkpoint" rename failures
//   - "<db>.wal.checkpoint" remove failures
// Example matches:
//   "Runtime exception: IO exception: Error renaming file /x/lbug.wal to /x/lbug.wal.checkpoint. ErrorMessage: Permission denied"
//   "Runtime exception: IO exception: Error removing directory or file /x/lbug.wal.checkpoint.  Error Message: Permission denied"
// Matching is case-insensitive to remain robust across wrappers/platforms.
const LBUG_CHECKPOINT_RENAME_RE =
  /^runtime exception: io exception:\s*error renaming file\s+.+?\.wal\s+to\s+.+?\.wal\.checkpoint(?:\.|\s|$)/i;
const LBUG_CHECKPOINT_REMOVE_RE =
  /^runtime exception: io exception:\s*error removing directory or file\s+.+?\.wal\.checkpoint(?:\.|\s|$)/i;
/**
 * Permissive fallback: any IO-exception-shaped message that mentions a
 * `.wal.checkpoint` path. Catches future Ladybug message drift (different
 * verb, additional preamble, locale variation) so the recovery hint keeps
 * surfacing even if the strict regexes go stale.
 */
const LBUG_CHECKPOINT_PERMISSIVE_RE = /io exception.*\.wal\.checkpoint/i;

/**
 * True when `err` looks like a Ladybug WAL-checkpoint rotation/remove IO
 * failure. Tries strict matchers first (renames + removes), then falls
 * back to the permissive matcher.
 */
export const isLbugCheckpointIoError = (err: unknown): boolean => {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (LBUG_CHECKPOINT_RENAME_RE.test(msg) || LBUG_CHECKPOINT_REMOVE_RE.test(msg)) return true;
  return LBUG_CHECKPOINT_PERMISSIVE_RE.test(msg);
};

// ─── Ladybug non-4K page-size frame-release matcher (#1231) ─────────────────
//
// LadybugDB <= 0.17.x hardcoded a 4 KiB OS-page assumption in its buffer
// manager: evicting a frame released physical memory with
// `madvise(frame, frameSize, MADV_DONTNEED)` on 4 KiB-aligned frame
// addresses (verified by disassembling `VMRegion::releaseFrame` in
// @ladybugdb/core-linux-arm64 0.17.1 — `mov w2, #0x4` = MADV_DONTNEED,
// throw on non-zero return). On kernels with 16 KiB pages (Raspberry Pi 5
// default 2712 kernel, Asahi Linux) or 64 KiB pages (some enterprise arm64
// distros), madvise rejects addresses that are not multiples of the real
// page size with EINVAL, surfacing as:
//   "Buffer manager exception: Releasing physical memory associated with a
//    frame failed with error code -1: Invalid argument."
// which aborts `gitnexus analyze` mid-COPY.
//
// @ladybugdb/core 0.18.0 rewrote the release path with runtime OS-page-size
// detection and discard-granule-aligned madvise (new binary strings:
// "Failed to detect the operating system page size.", "Unsupported page
// size combination: frame size {}, discard granule size {}, frame group
// size {}."), so upgrading is the fix. The residual 0.18.0 guard
// ("Unsupported page size combination") is matched here too so exotic
// configurations receive the same actionable guidance instead of a raw
// native message.
const LBUG_FRAME_RELEASE_RE = /releasing physical memory associated with a frame failed/i;
const LBUG_PAGE_COMBO_RE = /unsupported page size combination/i;

/**
 * True when `err` looks like the LadybugDB buffer manager failing to release
 * frame memory — the failure mode of a 4 KiB page-size assumption on a
 * 16 KiB/64 KiB-page kernel (#1231). Deliberately does NOT match the
 * generic "buffer pool is full" exhaustion error: that one is handled as a
 * SIZING problem — though since #2631 we know page size drives sizing too
 * (the engine bills pool budget per OS-page-sized discard granule, so non-4K
 * hosts exhaust the same budget up to pageSize/4096× earlier; see
 * granuleRatio, which scales the pool accordingly, and
 * bufferPoolExhaustionRemedy, which explains it to the operator).
 */
export const isLbugPageSizeFrameError = (err: unknown): boolean => {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return LBUG_FRAME_RELEASE_RE.test(msg) || LBUG_PAGE_COMBO_RE.test(msg);
};

/**
 * True when the given `@ladybugdb/core` version contains the runtime
 * OS-page-size detection introduced in 0.18.0 (see the matcher comment
 * above). Unknown/unparseable versions return false so callers err on the
 * side of showing the upgrade hint.
 */
export const isPageSizeAwareLadybug = (version: string | undefined): boolean => {
  if (!version) return false;
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 18;
};

// `undefined` = not probed yet; `null` = probed and unavailable. Cached
// because analyze error paths and doctor may both ask, and getconf forks.
let cachedOsPageSize: number | null | undefined;

/**
 * Test seam (the `_captureLogger` convention): pin the memoized OS page size
 * so sizing tests are host-independent — without this they would silently
 * drift on 16 KiB-page Apple Silicon runners. `number` pins a value, `null`
 * pins "undetectable", `undefined` clears the memo so the next call re-probes.
 */
export const _setOsPageSizeForTests = (pageSize: number | null | undefined): void => {
  cachedOsPageSize = pageSize;
};

/**
 * OS memory page size in bytes, or `undefined` when it cannot be determined
 * (Windows, missing getconf, sandboxed exec). Node exposes no page-size API,
 * so this shells out to POSIX `getconf PAGE_SIZE` — same execFileSync shape
 * as the Windows 8.3 short-path probe above, but with a tighter timeout and
 * an explicit killSignal (see the options comment below).
 */
export const getOsPageSize = (): number | undefined => {
  if (cachedOsPageSize !== undefined) return cachedOsPageSize ?? undefined;
  if (process.platform === 'win32') {
    // Windows allocation granularity is not what madvise alignment is about;
    // the #1231 failure mode is POSIX-only.
    cachedOsPageSize = null;
    return undefined;
  }
  try {
    // killSignal SIGKILL (first use in this repo): the default SIGTERM is
    // catchable, so a signal-trapping child held the "5s" timeout for 9s in
    // review reproduction — SIGKILL makes the timeout real for everything
    // except a child stuck in uninterruptible I/O (D state). 2000ms, not
    // 5000: doctor runs this probe on its happy path and real getconf
    // answers in ~2ms, but keep margin for loaded Pi-class hardware — a
    // too-tight ceiling would silently drop the very #1231 diagnostics this
    // probe exists to provide (the catch caches the failure). (#2424 review)
    const out = execFileSync('getconf', ['PAGE_SIZE'], {
      encoding: 'utf-8',
      timeout: 2000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = Number(out.trim());
    cachedOsPageSize = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    cachedOsPageSize = null;
  }
  return cachedOsPageSize ?? undefined;
};

type LbugModule = typeof lbug;

export interface LbugDatabaseOptions {
  readOnly?: boolean;
  throwOnWalReplayFailure?: boolean;
}

export interface LbugConnectionHandle {
  db: lbug.Database;
  conn: lbug.Connection;
}

/**
 * Return true when the error message indicates that a LadybugDB write
 * transaction could not proceed due to lock contention — either a file
 * lock that could not be acquired (either at construction time,
 * `new lbug.Database(...)` raising from `local_file_system.cpp`, or during
 * a query, another writer holds the exclusive lock), or a same-process
 * write transaction rejected because another write transaction is already
 * active on the connection.
 *
 * Lives here (not in `lbug-adapter.ts`) so both the construction-time
 * retry (`openWithLockRetry` in this file) and the query-time retry
 * (`withLbugDb` in `lbug-adapter.ts`) consult the same matcher. Callers
 * import directly from this module — no re-export to keep in sync.
 */
export const isDbBusyError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // `lock` already subsumes `could not set lock`; the broader term is kept
  // because graph-DB transient errors include "deadlock", "lock contention",
  // and the LadybugDB native module's "could not set lock on file" — all of
  // which deserve a retry. LadybugDB also reports same-process writer
  // contention without the words "busy" or "lock".
  //
  // "only one write transaction at a time" was observed against LadybugDB
  // 0.18.0 (see gitnexus/package.json @ladybugdb/core).
  //
  // If a non-transient lock-shaped error ever surfaces (e.g., "lock file
  // missing" during recovery), tighten this matcher rather than raising the
  // retry budget.
  return (
    msg.includes('busy') ||
    msg.includes('lock') ||
    msg.includes('already in use') ||
    msg.includes('only one write transaction at a time')
  );
};

/**
 * True when a WAL-checkpoint IO error ALSO carries a busy/lock signal — the
 * rotation failed because another handle (a `gitnexus mcp` server, or this
 * process's own reader) holds the store's WAL open, rather than a permanent
 * disk error. Reuses `isDbBusyError`'s already-tested keyword set instead of a
 * fresh regex, so an unmatched message degrades to "IO error" rather than
 * silently claiming a held-open cause. (#2599)
 */
export const isLbugCheckpointBusyError = (err: unknown): boolean => {
  if (!isLbugCheckpointIoError(err)) return false;
  // Anchor to real held-open wording rather than isDbBusyError's broad
  // `.includes('lock')`, which matches the DB PATH embedded in the checkpoint
  // error message (e.g. a repo under `blockchain-app`) and would misclassify a
  // pure disk fault as held-open (#2614 LOW).
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('could not set lock') ||
    msg.includes('lock is held') ||
    msg.includes('being used by another process') ||
    msg.includes('is busy')
  );
};

/** See {@link classifyDeleteAllError}. */
export type DeleteAllErrorClass = 'benign-missing-table' | 'rethrow';

/**
 * Classify an error thrown while clearing all relationships of one type
 * before an incremental re-write (`deleteAllRelationshipsOfType` in
 * `lbug-adapter.ts` — the `deleteAllInjects` / `deleteAllCallSummaries` /
 * `deleteAllInterprocTaintPaths` family).
 *
 * - `'benign-missing-table'`: the CodeRelation table does not exist yet
 *   (freshly-initialized DB) — the delete-all is a no-op, stay silent.
 * - `'rethrow'`: ANY other failure (lock, disk, closed connection, native
 *   error) leaves stale rows that the subsequent re-extract then DUPLICATES
 *   (CodeRelation has no PK), so the caller must abort the writeback
 *   (#2084 review P2-5).
 *
 * Pure classification, extracted here (next to the other error matchers) so
 * the load-bearing regex/branch is unit-testable without a native DB —
 * driving a synthetic failure through the real singleton connection would
 * break every later test in the shared integration suite (#2200 review).
 */
export const classifyDeleteAllError = (err: unknown): DeleteAllErrorClass => {
  const msg = err instanceof Error ? err.message : String(err);
  return /no table|not exist|not found|does not exist|Table .* does not exist/i.test(msg)
    ? 'benign-missing-table'
    : 'rethrow';
};

export function createLbugDatabase(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): lbug.Database {
  // .d.ts declares fewer args than the native constructor accepts.
  return new (lbugModule.Database as any)(
    databasePath,
    resolveBufferManagerSize(), // bufferManagerSize (#2557: default min(2 GiB, 80% RAM); GITNEXUS_LBUG_BUFFER_POOL_SIZE overrides; 0 restores the native 80%-of-RAM default)
    false, // enableCompression (pinned for v0.16.0)
    options.readOnly ?? false,
    LBUG_MAX_DB_SIZE,
    true, // autoCheckpoint (always on)
    resolveCheckpointThreshold(), // checkpointThreshold (default 64 MiB; override with GITNEXUS_WAL_CHECKPOINT_THRESHOLD; -1 keeps Ladybug stock ~16 MiB)
    options.throwOnWalReplayFailure ?? true,
    true, // enableChecksums
  ) as lbug.Database;
}

// ─── Lock-busy retry tuning knobs ───────────────────────────────────────────
//
// All four GitNexus retry pairs that touch native LadybugDB locks live with
// a comment cross-reference here so an SRE tuning Windows flakes finds them
// in one grep:
//
//   1. OPEN_LOCK_RETRY_ATTEMPTS / OPEN_LOCK_RETRY_DELAY_MS  (this file)
//      → `new lbug.Database()` constructor lock failures
//   2. HANDLE_RELEASE_PROBE_ATTEMPTS / HANDLE_RELEASE_PROBE_DELAY_MS  (this file)
//      → post-close fs.open probe to absorb Windows handle-release lag; also
//        the shared budget for wipeLbugDbFiles' ENOENT-verified removal
//        (lbug-adapter.ts) and the dirty-recovery sidecar park's
//        rename/rm retries (sidecar-recovery.ts) — same lock class
//   3. DB_LOCK_RETRY_ATTEMPTS / DB_LOCK_RETRY_DELAY_MS  (lbug-adapter.ts withLbugDb)
//      → query-time busy/lock retry around already-open connections
//
// `new lbug.Database()` calls into the native module which performs an
// OS-level exclusive lock on `<dbPath>`. On Windows that lock can fail
// for reasons specific to the OS (Defender briefly opens new files,
// libuv handle release lags the JS-side close). 5 attempts × 100ms
// linear back-off (max sleep 100+200+300+400 = 1s, plus 5 ctor RTTs
// of 10–50ms each = ~1.0–1.2s worst case) clears the typical
// AV-scanner hold without masking real cross-process conflicts.
//
// Source: https://github.com/LadybugDB/ladybug/blob/v0.18.0/src/common/file_system/local_file_system.cpp#L127
// (v0.18.0 appends " (Error: <code>)" / " (Lock is held by PID X)" on POSIX,
// but the "Could not set lock on file : " prefix `isDbBusyError` substring-
// matches on is unchanged.)
const OPEN_LOCK_RETRY_ATTEMPTS = 5;
const OPEN_LOCK_RETRY_DELAY_MS = 100;

// Exported (this shipping review, FIX 1/2): the dirty-recovery sidecar park
// (sidecar-recovery.ts) and the ENOENT-verified wipe (lbug-adapter.ts
// wipeLbugDbFiles) retry the SAME Windows handle-release/AV lock class, and
// their previous private mirror constants were documentation-coupled copies
// that could drift from this tuning-knob registry silently.
export const HANDLE_RELEASE_PROBE_ATTEMPTS = 5;
export const HANDLE_RELEASE_PROBE_DELAY_MS = 50;
const HANDLE_RELEASE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

// Retry-budget registry, part 2 (retry-budget consolidation): the remaining
// open-time lock retries live next to their call sites but are catalogued here
// so all lbug retry budgets surface in one grep. They retry the same lock class
// as 1–3 ("Could not set lock" while a writer rebuilds the index):
//   4. LOCK_RETRY_ATTEMPTS / LOCK_RETRY_DELAY_MS  (pool-adapter.ts)
//      → read pool's read-only open while `gitnexus analyze` is writing
//        (3 attempts, linear 2s·n back-off ≈ 6s total)
//   5. LBUG_OPEN_RETRY_ATTEMPTS / _BASE_MS / _MAX_MS  (group/bridge-db.ts)
//      → cross-repo bridge RO open race (10 attempts, linear 100ms·n capped
//        at 500ms ≈ 3.5s total)
// Kept in-file (not moved here) so explicit `lbug-config` test mocks don't have
// to enumerate them; change a budget in its call site and update this catalogue.

/**
 * Test-fixture directory prefixes recognized by `isTestFixturePath`.
 *
 * IMPORTANT: this list must stay in sync with the prefixes passed to
 * `createTempDir` in `gitnexus/test/helpers/test-db.ts` and the prefixes
 * used by `withTestLbugDB` (`gitnexus/test/helpers/test-indexed-db.ts`).
 * If you add a new test that passes a custom prefix to `createTempDir`,
 * add it here too — otherwise the stale-sidecar sweep silently won't
 * fire for that fixture and CI flakes return.
 *
 * The default `createTempDir('gitnexus-test-')` and the lbug variant
 * `'gitnexus-lbug-'` cover today's call sites.
 */
const TEST_FIXTURE_PREFIXES = ['gitnexus-lbug-', 'gitnexus-test-'];

/**
 * Marker symbol attached to lock errors after `openWithLockRetry` exhausts
 * its budget. `withLbugDb`'s outer query-time retry consults this so it
 * does not re-retry a path that just spent up to ~1.5s in the open-time
 * loop — preventing 6s tail latencies (3× outer × 5× inner attempts).
 *
 * The symbol is internal to GitNexus; consumers should treat the underlying
 * error message as the user-visible signal.
 */
export const LBUG_OPEN_RETRY_EXHAUSTED = Symbol.for('gitnexus.lbug.openRetryExhausted');

export const isOpenRetryExhausted = (err: unknown): boolean => {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  return (err as { [LBUG_OPEN_RETRY_EXHAUSTED]?: boolean })[LBUG_OPEN_RETRY_EXHAUSTED] === true;
};

const tagOpenRetryExhausted = (err: unknown): unknown => {
  if (err && typeof err === 'object') {
    (err as { [LBUG_OPEN_RETRY_EXHAUSTED]?: boolean })[LBUG_OPEN_RETRY_EXHAUSTED] = true;
  }
  return err;
};

/**
 * True when `dbPath` resolves to a recognized test fixture under the OS
 * temp directory. Used to gate the stale-sidecar sweep so production
 * paths never have their `.wal` / `.lock` files deleted.
 *
 * Defensive shape:
 *   - `path.resolve` normalizes `..` segments before the prefix check, so
 *     `<tmp>/gitnexus-lbug-x/../../etc/passwd` is rejected.
 *   - The tmpRoot check trims any trailing separator returned by some
 *     Windows TMP configurations (`C:\Users\X\Temp\`) so the startsWith
 *     comparison stays correct.
 *   - Only the IMMEDIATE parent directory is matched against the prefix
 *     list. An ancestor walk would let a tmpdir whose own basename starts
 *     with `gitnexus-lbug-` accept arbitrary nested paths under it.
 */
const isTestFixturePath = (dbPath: string): boolean => {
  const tmpRoot = os.tmpdir().replace(new RegExp(`${path.sep === '\\' ? '\\\\' : path.sep}+$`), '');
  const resolved = path.resolve(dbPath);
  if (!resolved.startsWith(tmpRoot + path.sep) && resolved !== tmpRoot) return false;
  const parentBase = path.basename(path.dirname(resolved));
  return TEST_FIXTURE_PREFIXES.some((p) => parentBase.startsWith(p));
};

/** Exported only for direct unit testing — production callers use `openWithLockRetry`. */
export const _isTestFixturePathForTest = isTestFixturePath;

// Exported alongside HANDLE_RELEASE_PROBE_* (this shipping review, FIX 1/2)
// so the consumers of the shared retry budget do not each grow a private copy.
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attempt to remove stale `.wal` / `.lock` sidecars that a previous aborted
 * test run may have left behind. Best-effort: ENOENT is normal, anything
 * else is swallowed so the caller's retry can surface the original error.
 */
const sweepStaleSidecars = async (dbPath: string): Promise<void> => {
  for (const suffix of ['.wal', '.lock']) {
    try {
      await fs.unlink(dbPath + suffix);
    } catch {
      /* missing sidecar or permission error — let the open retry surface it */
    }
  }
};

/**
 * Run `construct` with bounded retries when `new lbug.Database(...)` throws
 * a busy/lock error. The original (loop-captured) error is preferred over
 * any post-sweep error so triage sees the real LadybugDB lock message.
 * On exhaustion the rethrown error is tagged via
 * `LBUG_OPEN_RETRY_EXHAUSTED` so the outer query-time retry in
 * `withLbugDb` skips re-retrying a freshly-exhausted path.
 */
const openWithLockRetry = async (
  construct: () => lbug.Database,
  dbPath: string,
): Promise<lbug.Database> => {
  let originalLockError: unknown;
  for (let attempt = 1; attempt <= OPEN_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return construct();
    } catch (err) {
      if (!isDbBusyError(err)) throw err;
      originalLockError = err;
      if (attempt === OPEN_LOCK_RETRY_ATTEMPTS) break;
      await sleep(OPEN_LOCK_RETRY_DELAY_MS * attempt);
    }
  }

  // Final defense: only for recognized test fixtures, sweep stale sidecars
  // (a prior aborted test run can leave a `.wal` lock that survives the
  // tmp dir cleanup). Production paths never reach this branch — the guard
  // requires the immediate parent dir to match a test prefix AND the
  // resolved path to live under the OS temp directory.
  if (isTestFixturePath(dbPath)) {
    await sweepStaleSidecars(dbPath);
    try {
      return construct();
    } catch {
      // Intentionally do NOT overwrite originalLockError. The user-actionable
      // signal is "we exhausted lock retries" — a different error from the
      // post-sweep attempt is less useful than the lock failure that drove
      // the sweep in the first place.
    }
  }
  throw tagOpenRetryExhausted(originalLockError);
};

export async function openLbugConnection(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): Promise<LbugConnectionHandle> {
  const safePath = toNativeSafePath(databasePath);
  let db: lbug.Database | undefined;
  try {
    db = await openWithLockRetry(() => createLbugDatabase(lbugModule, safePath, options), safePath);
    return { db, conn: new lbugModule.Connection(db) };
  } catch (err) {
    if (db) await db.close().catch(() => {});
    throw err;
  }
}

export async function closeLbugConnection(handle: LbugConnectionHandle): Promise<void> {
  await handle.conn.close().catch(() => {});
  await handle.db.close().catch(() => {});
}

/**
 * Probe `dbPath` AND its `.wal` sidecar after `db.close()` so any
 * residual native file handle surfaces as EBUSY/EPERM/EACCES and the
 * bounded retry absorbs the release lag. Windows-only — Linux/macOS do
 * not exhibit this race.
 *
 * Both files matter. Empirically, on rapid open→close→reopen cycles the
 * main `dbPath` handle releases first; the `.wal` handle from the
 * previous Database lingers and the new Database's first write (CREATE
 * NODE TABLE during schema init) fails with "Could not set lock on
 * file". Probing both makes safeClose actually return when the kernel
 * is fully done with the path.
 *
 * Returns `true` when both probes succeeded (or skipped on non-lock
 * errors / missing files). Returns `false` when either probe exhausted
 * its budget with a lock code still in flight.
 *
 * Defensive shape:
 *   - Opens read+write (`'r+'`) so the probe actually surfaces exclusive
 *     locks held by the previous Database. A read-only probe (`'r'`) is
 *     insufficient — Windows will grant read access while the previous
 *     handle's exclusive write lock is still in flight, which lets
 *     `safeClose` return before the next CREATE NODE TABLE can lock the
 *     file.
 *   - `try/finally` around `handle.close()` guarantees no fd leak even
 *     if close itself throws.
 */
export const waitForWindowsHandleRelease = async (dbPath: string): Promise<boolean> => {
  const mainReleased = await probeSinglePath(dbPath);
  const walReleased = await probeSinglePath(dbPath + '.wal');
  return mainReleased && walReleased;
};

const probeSinglePath = async (filePath: string): Promise<boolean> => {
  for (let attempt = 1; attempt <= HANDLE_RELEASE_PROBE_ATTEMPTS; attempt++) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(filePath, 'r+');
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !HANDLE_RELEASE_LOCK_CODES.has(code)) return true; // ENOENT / unrelated → not our problem
      if (attempt === HANDLE_RELEASE_PROBE_ATTEMPTS) return false;
      await sleep(HANDLE_RELEASE_PROBE_DELAY_MS * attempt);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* swallow — caller cannot do anything useful with a probe-close failure */
        }
      }
    }
  }
  return false;
};
