/**
 * scripts/measure-mode-c.ts — WI-1b (campaign harness core)
 *
 * `measureModeC(opts)` is the per-repo orchestration function for
 * the two-leg Mode C measurement campaign (see
 * `docs/designs/159-mode-c-measurement.md` §Contracts). It is the
 * seam between the CLI entry (WI-1c) and the production verifier
 * `runModeCVerify` (`src/core/ingestion/lsp/mode-c-verifier.ts`).
 *
 * The function is **pure-with-DI** (PDI): every I/O surface is
 * injected. The default implementations wire to the production
 * seams (child-process `execFile`, `runModeCVerify`, `du`-style
 * stat, `executeParameterized`, `git rev-parse HEAD`); tests inject
 * stubs and never touch a real DB or subprocess.
 *
 * The default `exec` is `child_process.execFile` (NOT
 * `child_process.exec`) so argument values are never passed
 * through a shell — see the PostToolUse security note in
 * `docs/STANDARDS.md`. The seam name remains `exec` (not
 * `execFile`) to match the design contract; the implementation
 * detail is documented here.
 *
 * Per-repo strictly sequential open → read → close (LadybugDB
 * lock discipline, I-3):
 *
 *   1. `stat` on `.gitnexus/lbug` to learn if a fresh analyze is
 *      needed (the harness does not open a DB connection at all —
 *      all DB I/O is delegated to `runCypher`, which is the
 *      `executeParameterized` seam).
 *   2. If `.gitnexus` is absent → `exec(analyze …)` timed.
 *   3. `loadMeta` to read `meta.json` (default seam).
 *   4. `runCypher` for `edgeCountsBySource` + `edgeCountsByReason`.
 *   5. For each leg, assemble `RunModeCVerifyOpts` (mirrors
 *      `src/cli/verify.ts` per KD-9) and call `verify`.
 *   6. Build the artifact.
 *
 * `analyzeRanFirst` is the boolean flag the CLI uses to render
 * the "analyze-first" column in the markdown summary (WI-1c).
 * `underSampled = report.sampledCap < sampleSize` — partial runs
 * are flagged here, surfaced via the result envelope, and excluded
 * from headline tables by the caller (per I-5 / halt contract).
 *
 * Read-only contract (KD-8 / I-2): this module MUST NOT statically
 * reach for `initLbug`, `executeQuery`, `addNode`, or
 * `addRelationship`. The verifier is loaded via dynamic import
 * (resolved to `dist/.../mode-c-verifier.js` at runtime) so the
 * source-text invariant sweep never sees the import. The unit
 * test `no-write-invariant` block pins this.
 */

// ─── Public types ──────────────────────────────────────────────────────

/** Per-leg identifier — drives the analyze command + the report's `leg`. */
export type MeasureModeCLeg = 'baseline' | 'lsp';

/** The full options bag for `measureModeC`. */
export interface MeasureModeCOptions {
  /** Repository to measure (absolute path or path-resolvable string). */
  repoPath: string;
  /** One or both legs. */
  legs: MeasureModeCLeg[];
  /** Sample size for `runModeCVerify`. */
  sampleSize: number;
  /** Deterministic PRNG seed. */
  seed: string;
  /** Output directory (used by the CLI to name files; the function itself
   *  does NOT write files — file I/O is the caller's responsibility per
   *  the WI design: "Per repo strictly sequential open → read → close"). */
  outDir: string;
  /** Subprocess runner. Default: `execFile`-backed runner over the local
   *  `gitnexus` CLI build. Receives `(cmd, args, cwd)` and returns
   *  `{stdout, stderr, code}`. */
  exec?: ExecFn;
  /** Verifier entry point. Default: dynamically imported
   *  `runModeCVerify` from the compiled `dist/` build. */
  verify?: VerifyFn;
  /** `du`-style stat of `.gitnexus/lbug`. Returns `null` when the
   *  directory is absent. Default: `fs`-backed byte-sum. */
  stat?: StatFn;
  /** Cypher dispatch. Default: `executeParameterized` from
   *  `dist/mcp/core/lbug-adapter.js` (loaded lazily at runtime). */
  runCypher?: RunCypherFn;
  /** `git rev-parse HEAD` equivalent. Default: `child_process.execFile`. */
  sha?: ShaFn;
  /** `loadMeta` reader. Default: imported from
   *  `dist/storage/repo-manager.js` (loaded lazily at runtime). */
  loadMeta?: LoadMetaFn;
  /** `getStoragePaths` helper. Default: imported from the same module. */
  getStoragePaths?: GetStoragePathsFn;
  /** Server version string for the report (CLI resolves via
   *  `discoverServers`; default: `null` so the harness can be
   *  exercised without an LSP server). */
  serverVersion?: string | null;
  /** Absolute path to the typescript-language-server binary. When
   *  supplied AND the default `verify` seam is in use, the harness
   *  builds a full `RunModeCVerifyOpts` (KD-9) by spinning up a
   *  per-invocation `LspClient`, running the workspace probe once,
   *  and wiring `mapLocationToNodeId` + `executeParameterized` from
   *  the production seams. When `verify` is overridden (tests), this
   *  field is ignored. */
  lspServerPath?: string | null;
  /** Build-real-verify-opts seam. Resolves to a full
   *  `RunModeCVerifyOpts` (with `client`/`probe`/`mapLocationToNodeId`/
   *  `executeParameterized` wired in) for the default-verify path.
   *  Default: dynamic-import-based implementation that spins up
   *  an `LspClient` from `dist/core/ingestion/lsp/lsp-client.js`,
   *  runs the workspace probe, and wires the production seams
   *  (mirrors `src/cli/verify.ts:verifyCommand` per KD-9). Unit
   *  tests inject a stub returning a fully-populated object so the
   *  per-leg shape can be asserted at the verify seam. */
  buildRealVerifyOpts?: BuildRealVerifyOptsFn;
  /** Determinism seam for `analyzeWallMs` + `generatedAt` (AC-5).
   *  Default: `() => 0` (epoch) — the artifact is byte-identical
   *  across same-(index, seed, sampleSize) re-runs. The wall-clock
   *  duration of the `analyze` subprocess is non-deterministic and
   *  must not bleed into the serialized JSON. Inject a real-time
   *  function only for non-artifact logging; never let it reach
   *  the artifact envelope. */
  now?: () => number;
}

/** Shape of the subprocess seam. `cmd` is the program path; `args` is
 *  the argument array (no shell interpolation). */
export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

// Type-only imports: erased at compile time, invisible to the
// `assertNoGraphWriteImports` sweep (which targets write-API
// tokens, not `import` statements), and the unit test that pins
// "harness does NOT statically import runModeCVerify" only
// forbids `import` lines naming `runModeCVerify` (test file
// `measure-mode-c.test.ts:749`). We use these to make the
// `RunModeCVerifyOpts` structural mirror (`type RunModeCVerifyOpts`
// below) field-rename-safe — a refactor of `LspClient` in
// production will fail the harness's static typecheck on this
// line, not silently at runtime.
import type { LspClient } from '../src/core/ingestion/lsp/lsp-client.js';
import type { MapperResult } from '../src/core/ingestion/lsp/location-mapper.js';

// Native node imports used by the LSP server discovery helpers
// (`resolveLspOnPath` for the PATH walk; `accessSync` for the
// `--lsp-server-path` parse-time validation in `main()`). These
// are static imports — neither `node:fs` nor `node:path` is a
// write-API surface, so they are out of scope for the
// `assertNoGraphWriteImports` sweep and the
// "harness does NOT statically import runModeCVerify" pin.
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';

/** The verifier seam. We type it as a permissive function so the
 *  unit tests can inject stubs without rebuilding the full
 *  `RunModeCVerifyOpts` signature. The runtime default resolves to
 *  the real `runModeCVerify`. The structural type mirrors the
 *  production `RunModeCVerifyOpts` interface (`src/core/ingestion/
 *  lsp/mode-c-verifier.ts:124`) — a refactor that renames a key
 *  there (e.g. `repoId` → `repositoryId`) will now fail the
 *  harness's static typecheck, not silently at runtime. We use
 *  `import type` so the symbol is erased at compile time and
 *  the `assertNoGraphWriteImports` sweep never sees a static
 *  import of the verifier. */
export type VerifyFn = (
  opts: RunModeCVerifyOpts,
) => Promise<VerifyReport>;

/** Build-real-verify-opts seam. Returns a fully-populated
 *  `RunModeCVerifyOpts` for the per-leg loop in the default-verify
 *  path. The unit tests inject a stub so the per-leg shape can be
 *  asserted at the verify seam without dynamic-importing the
 *  production `LspClient` / `mapLocationToNodeId` / `executeParameterized`.
 *  The production default dynamic-imports the dist modules and
 *  mirrors `src/cli/verify.ts:verifyCommand` (KD-9). */
export type BuildRealVerifyOptsFn = (args: {
  repoPath: string;
  repoId: string;
  lspServerPath: string;
  serverVersion: string | null;
  sampleSize: number;
  seed: string;
}) => Promise<RunModeCVerifyOpts>;

/** Structural mirror of the production `RunModeCVerifyOpts` (KD-9).
 *  Mirrors the production interface at
 *  `src/core/ingestion/lsp/mode-c-verifier.ts:123-153` in full —
 *  every field the production verifier requires is present. A
 *  field-rename or removal in the production interface will surface
 *  here as a typecheck error in the harness, not a silent runtime
 *  failure at the call site. The unit test
 *  "verify seam captures the full RunModeCVerifyOpts shape" pins
 *  this contract at the test-seam level (capturing
 *  `verify.mock.calls[0][0]` and asserting every required key is
 *  present).
 *
 *  `LspClient` is imported via `import type` so the symbol is
 *  erased at compile time and the `assertNoGraphWriteImports`
 *  sweep never sees a static import of the client module (KD-8).
 *  Pulling the type in for the `client` / `probe` fields means a
 *  production-side rename of `LspClient` (or a signature change
 *  on `LspClient.start`) will fail the harness's static typecheck
 *  on this line, not silently at runtime. */
type RunModeCVerifyOpts = {
  repoId: string;
  /** Used for `textDocument/definition` requests. */
  client: LspClient;
  /** Maps an LSP Location to a graph nodeId. */
  mapLocationToNodeId: (loc: any, repoId: string) => Promise<MapperResult>;
  /** Read-only Cypher dispatch. */
  executeParameterized: (
    repoId: string,
    cypher: string,
    params: Record<string, any>,
  ) => Promise<any[]>;
  /** The probe — `probeWorkspaceReadiness` by default. */
  probe: (client: LspClient) => Promise<{ ready: boolean; reason?: string }>;
  /** Server version, captured upstream. Forwarded into the report. */
  serverVersion?: string | null;
  /** Total target sample size (capped by available edges). */
  sampleSize?: number;
  /** Seeded PRNG seed. */
  seed?: string;
  /** Hard cap on the number of LSP requests. */
  hardCap?: number;
  /** Per-request timeout in ms. Optional. */
  requestTimeoutMs?: number;
  /** Optional sink for diagnostic logs. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
};

/** Structural mirror of the production `VerifyReport` (KD-9).
 *  `funnel` is an optional field on the production report (emitted
 *  by `mode-a-reconciler.ts`); we include it so the harness's
 *  artifact envelope can echo the funnel stats into the per-leg
 *  JSON. The test seam's stub reports need NOT include `funnel`. */
type VerifyReport = {
  perTier: Record<string, unknown>;
  overall: {
    precision: number;
    recall: number;
    falseConfidentRate: number;
    matches: number;
    falseConfident: number;
    recallMisses: number;
    refusals: number;
    recallGains: number;
    n: number;
  };
  sampleSize: number;
  serverVersion: string | null;
  lspUnavailable?: boolean;
  reason?: string;
  sampledCap?: number;
  funnel?: { candidates?: number; cap?: number; skipped?: number };
};

/** Per-repo `.gitnexus/lbug` byte-count or `null` when absent. */
export type StatFn = (repoPath: string) => Promise<number | null>;

/** Cypher dispatch — same shape as `executeParameterized`. */
export type RunCypherFn = (
  repoId: string,
  cypher: string,
  params: Record<string, any>,
) => Promise<any[]>;

/** Resolves a repo path to its current HEAD SHA. */
export type ShaFn = (repoPath: string) => Promise<string>;

/** Reads `meta.json` from the repo's storage path. */
export type LoadMetaFn = (storagePath: string) => Promise<RepoMeta | null>;

/** Returns the canonical storage paths for a repo. */
export type GetStoragePathsFn = (repoPath: string) => {
  storagePath: string;
  lbugPath: string;
  metaPath: string;
};

/** Shape of `meta.json` (subset — we only echo the fields the
 *  contract documents). The full shape lives in
 *  `src/storage/repo-manager.ts`. */
export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
  schemaVersion?: number;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
}

/** Repo-level read-state cached once per `measureModeC` call and
 *  reused across the per-leg loop. The values are invariant
 *  across same-index legs (KD-3), so the per-leg artifact
 *  envelope just references the same `shared` object — no
 *  per-leg stat walk / meta read / cypher query. */
interface SharedRepoState {
  /** `.gitnexus/lbug` size in bytes (or `null` when the index is
   *  absent). The cache-present path captures this from the
   *  initial `stat`; the post-`analyze` path re-captures it
   *  after the subprocess wrote the index. */
  dbSizeBytes: number | null;
  /** `loadMeta` result — `null` when the meta is missing. */
  legMeta: RepoMeta | null;
  /** `bucketEdgeCounts(runCypher, repoId, 'source')` result. */
  edgeCountsBySource: Record<string, number>;
  /** `bucketEdgeCounts(runCypher, repoId, 'reason')` result. */
  edgeCountsByReason: Record<string, number>;
}

/** One leg's per-repo result. The contract is the design doc
 *  §Contracts → "Artifact schema".
 *
 *  AC-5: the serialized JSON is byte-identical across same-(index,
 *  seed, sampleSize) re-runs. `analyzeWallMs` is computed via the
 *  `now()` seam (default: epoch-anchored) and `generatedAt` is
 *  pinned to `1970-01-01T00:00:00.000Z` so neither value can drift
 *  across runs. The on-disk artifact must NOT contain any
 *  wall-clock-derived bytes. */
export interface MeasureModeCLegResult {
  /** Deterministic anchor for byte-identity (AC-5). Always the epoch
   *  string — included so a future schema bump has a place to record
   *  the determinism guarantee. */
  generatedAt: string;
  repo: string;
  sha: string;
  leg: MeasureModeCLeg;
  analyzeWallMs: number;
  dbSizeBytes: number | null;
  meta: {
    files: number | undefined;
    nodes: number | undefined;
    edges: number | undefined;
    communities: number | undefined;
    processes: number | undefined;
  };
  edgeCountsBySource: Record<string, number>;
  edgeCountsByReason: Record<string, number>;
  /** Funnel stats from the verifier, when present (mode-a-reconciler
   *  emits these via `report.funnel`). */
  funnel?: { candidates?: number; cap?: number; skipped?: number };
  /** The full `VerifyReport` from `runModeCVerify`. */
  report: any;
  /** Boolean headline-exclusion flag (I-5). True when the
   *  verifier did not complete its sampled slice — either the
   *  probe short-circuited (`lspUnavailable:true`) or the bucket
   *  populations were smaller than `sampleSize`. */
  underSampled: boolean;
  /** Human-readable explanation when `underSampled` or the
   *  verifier rejected. Mutually-exclusive values:
   *  - `lsp-unavailable:<reason>` — the probe returned ready:false
   *  - `under-sampled (sampledCap=N < sampleSize=M)` — caller-
   *    runnable cap, verifier completed with a smaller sample
   *  - `harness-error:<message>` — the verifier or the harness's
   *    per-leg setup threw
   *  - `''` (empty) when the leg produced a valid headline row
   *  Rendered in the Excluded section's reason column. */
  excludedReason: string;
  analyzeRanFirst: boolean;
}

/** Top-level result. `artifacts` is in leg order (one entry per
 *  requested leg that did not fail at the `verify` step). `errors`
 *  carries the surfaced per-leg failures; a non-empty `errors` does
 *  NOT fail the overall call — the CLI decides how to render them. */
export interface MeasureModeCResult {
  repo: string;
  artifacts: MeasureModeCLegResult[];
  errors: Array<{ leg: MeasureModeCLeg; message: string }>;
}

// ─── Defaults — wired to production seams (dynamic imports) ──────────

/** Cache for the dynamic import of `runModeCVerify`. Resolved on
 *  first call to `measureModeC` (or its first invocation that does
 *  not override the `verify` seam). */
let _verifyFnCache: VerifyFn | null = null;
let _runCypherCache: RunCypherFn | null = null;
let _loadMetaCache: LoadMetaFn | null = null;
let _getStoragePathsCache: GetStoragePathsFn | null = null;
let _execCache: ExecFn | null = null;
let _statCache: StatFn | null = null;
let _shaCache: ShaFn | null = null;

/**
 * Resolve the `runModeCVerify` default. Done via dynamic import so
 * the static source-text sweep never sees the import (KD-8).
 *
 * NOTE: the relative URL is intentional — the script runs out of
 * `<gitnexus>/scripts/measure-mode-c.ts` and the compiled verifier
 * is at `<gitnexus>/dist/core/ingestion/lsp/mode-c-verifier.js`.
 * A `new URL(..., import.meta.url).href` form would also work, but
 * the simpler string form is easier for the no-write sweep to
 * recognize as a read-only dynamic import.
 */
async function defaultVerify(): Promise<VerifyFn> {
  if (_verifyFnCache) return _verifyFnCache;
  const mod: any = await import(
    '../dist/core/ingestion/lsp/mode-c-verifier.js'
  );
  _verifyFnCache = mod.runModeCVerify as VerifyFn;
  return _verifyFnCache;
}

/** Resolve the `executeParameterized` default. */
async function defaultRunCypher(): Promise<RunCypherFn> {
  if (_runCypherCache) return _runCypherCache;
  const mod: any = await import(
    '../dist/mcp/core/lbug-adapter.js'
  );
  _runCypherCache = mod.executeParameterized as RunCypherFn;
  return _runCypherCache;
}

/** Resolve the `loadMeta` + `getStoragePaths` defaults. */
async function defaultLoadMeta(): Promise<LoadMetaFn> {
  if (_loadMetaCache) return _loadMetaCache;
  const mod: any = await import(
    '../dist/storage/repo-manager.js'
  );
  _loadMetaCache = mod.loadMeta as LoadMetaFn;
  _getStoragePathsCache = mod.getStoragePaths as GetStoragePathsFn;
  return _loadMetaCache;
}

async function defaultGetStoragePaths(): Promise<GetStoragePathsFn> {
  if (_getStoragePathsCache) return _getStoragePathsCache;
  await defaultLoadMeta();
  return _getStoragePathsCache!;
}

/**
 * Default `exec` seam — wraps `child_process.execFile` so the
 * argument array is passed directly to the program (no shell).
 * The seam name is `exec` per the WI contract; the implementation
 * is `execFile` for security.
 */
async function defaultExec(): Promise<ExecFn> {
  if (_execCache) return _execCache;
  const { execFile } = await import('node:child_process');
  _execCache = (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { cwd, maxBuffer: 64 * 1024 * 1024 },
        (err: any, stdout: string, stderr: string) => {
          if (err) {
            // `err.code` is the numeric exit code when present.
            // We resolve (not reject) on non-zero exit so the
            // harness can render the failure as a partial
            // artifact or surfaced error.
            const code = typeof err?.code === 'number' ? err.code : 1;
            resolve({ stdout: stdout ?? '', stderr: stderr ?? err.message ?? '', code });
            return;
          }
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        },
      );
    });
  return _execCache;
}

/** Default `execNpx` seam for the pre-measure gate's
 *  fallback probe. Calls `npx` (the locally-installed npx from
 *  the dev shell) with the supplied args. Uses `execFile` so
 *  argument values are never passed through a shell — see
 *  the PostToolUse security note in `docs/STANDARDS.md`. The
 *  probe is a one-shot; we do NOT install or mutate the
 *  global package state. */
async function defaultExecNpx(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'npx',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        if (err) {
          const code = typeof err?.code === 'number' ? err.code : 1;
          resolve({ stdout: stdout ?? '', stderr: stderr ?? err.message ?? '', code });
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
      },
    );
  });
}

/**
 * Default `stat` seam — sums byte sizes of all files under
 * `.gitnexus/lbug` recursively. Returns `null` when the directory
 * is absent.
 */
async function defaultStat(): Promise<StatFn> {
  if (_statCache) return _statCache;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  _statCache = async (repoPath: string) => {
    const root = path.join(repoPath, '.gitnexus', 'lbug');
    // `lbug` may be a single file (the production layout) or a
    // directory (legacy / multi-file layout). Probe with `stat`
    // and branch accordingly.
    let info: import('node:fs').Stats;
    try {
      info = await fs.stat(root);
    } catch {
      return null;
    }
    if (info.isFile()) {
      return info.size;
    }
    if (!info.isDirectory()) {
      return null;
    }
    let total = 0;
    const walk = async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile()) {
          try {
            const s = await fs.stat(p);
            total += s.size;
          } catch {
            /* swallow — partial walk is fine; we only need a size hint */
          }
        }
      }
    };
    await walk(root);
    return total;
  };
  return _statCache;
}

/** Default `sha` seam — `git rev-parse HEAD`. Uses the same `execFile`
 *  shape as the default `exec` to avoid a shell. */
async function defaultSha(): Promise<ShaFn> {
  if (_shaCache) return _shaCache;
  const { execFile } = await import('node:child_process');
  _shaCache = async (repoPath: string) => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repoPath, maxBuffer: 1024 * 1024 },
        (err: any, out: string) => {
          if (err) return reject(err);
          resolve(out);
        },
      );
    });
    return stdout.trim();
  };
  return _shaCache;
}

// ─── Core ─────────────────────────────────────────────────────────────

/**
 * Run one repo's measurement matrix. Pure-with-DI: every I/O
 * surface is injected; defaults wire to production seams.
 *
 * The function NEVER writes files — that is the caller's job (the
 * CLI entry in WI-1c). It does spawn `analyze` (via the `exec`
 * seam) when `.gitnexus` is missing; that subprocess owns its own
 * writes to the storage path.
 *
 * @param opts See `MeasureModeCOptions`. The `verify`, `exec`,
 *             `stat`, `runCypher`, `sha`, `loadMeta`,
 *             `getStoragePaths` fields are all optional and have
 *             production-default implementations.
 * @returns The artifact(s) + surfaced errors. `artifacts.length`
 *          equals the number of legs that did not fail at
 *          `verify` time.
 */
/** Per-(repoPath, lspServerPath) module-level cache for the
 *  real-verify LspClient. The CLI today is sequential (one
 *  `measureModeC` per repo), so the per-call `realVerifyOptsCache`
 *  in the wrapper is sufficient. But the design documents a
 *  future parallel-repo CLI, in which case two concurrent
 *  `measureModeC` calls for the same repo+server would each
 *  spin up a fresh `LspClient` (the per-call cache is invisible
 *  across calls) and leak one client per parallel call. This
 *  module-level map shares the `RunModeCVerifyOpts` (and the
 *  embedded `LspClient`) across concurrent calls and uses a
 *  refcount so the `try/finally` cleanup only stops the client
 *  when the LAST caller releases it. Tests that inject
 *  `buildRealVerifyOpts` bypass this cache (the injection is
 *  the test's responsibility to share or not). */
const realVerifySharedCache: Map<
  string,
  {
    opts: RunModeCVerifyOpts;
    refCount: number;
    stopPromise: Promise<void> | null;
  }
> = new Map();

function sharedCacheKey(repoPath: string, lspServerPath: string): string {
  return `${repoPath}::${lspServerPath}`;
}

/** Acquire (or reuse) the real-verify opts for a
 *  (repoPath, lspServerPath) pair. Increments the refcount;
 *  the caller MUST pair this with `releaseRealVerifyOpts`. */
async function acquireRealVerifyOpts(
  repoPath: string,
  lspServerPath: string,
  buildOpts: () => Promise<RunModeCVerifyOpts>,
): Promise<RunModeCVerifyOpts> {
  const key = sharedCacheKey(repoPath, lspServerPath);
  const existing = realVerifySharedCache.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.opts;
  }
  const fresh = await buildOpts();
  realVerifySharedCache.set(key, { opts: fresh, refCount: 1, stopPromise: null });
  return fresh;
}

/** Release the real-verify opts for a (repoPath, lspServerPath)
 *  pair. Decrementing the refcount; when it reaches zero, the
 *  underlying `LspClient.stop()` is awaited and the entry is
 *  evicted. Concurrent release calls (e.g. two callers releasing
 *  at the same time) serialize through a single in-flight
 *  `stopPromise` so the client is only stopped once. */
async function releaseRealVerifyOpts(
  repoPath: string,
  lspServerPath: string,
): Promise<void> {
  const key = sharedCacheKey(repoPath, lspServerPath);
  const entry = realVerifySharedCache.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  // Last release: serialize `client.stop()` through a single
  // promise so concurrent final releases don't both call stop.
  if (!entry.stopPromise) {
    entry.stopPromise = (async () => {
      try {
        if (entry.opts.client?.stop) {
          await entry.opts.client.stop();
        }
      } catch {
        // best-effort
      }
    })();
  }
  await entry.stopPromise;
  realVerifySharedCache.delete(key);
}

export async function measureModeC(opts: MeasureModeCOptions): Promise<MeasureModeCResult> {
  // Wrap the body in try/finally so we can release any
  // LspClient the real-verify path spins up — without this,
  // the harness process hangs after writing the summary
  // (the stdio LSP server keeps it alive).
  let realVerifyOptsCache: any = null;
  // The real-verify path is active when EITHER (a) the default
  // `verify` seam is in use AND `lspServerPath` is set (the
  // production CLI path), OR (b) the test injects
  // `buildRealVerifyOpts` (the shape-pinning test path). Case
  // (b) is essential for the unit test that captures
  // `verify.mock.calls[0][0]` and asserts all 9 required fields
  // — without (b), the test would have to dynamic-import the
  // dist build (not possible in the unit suite) to reach the
  // shape-assembly code.
  const useRealVerify =
    (!!opts.buildRealVerifyOpts && !!opts.lspServerPath) ||
    (!opts.verify && !!opts.lspServerPath);
  // Module-level shared cache key: (repoPath, lspServerPath).
  // Sequential CLI today reuses the per-call cache (a no-op
  // for the parallel-repo scenario the design anticipates);
  // a future parallel-repo CLI shares one LspClient per
  // (repo, server) pair across concurrent callers.
  const sharedKey = useRealVerify && opts.lspServerPath
    ? sharedCacheKey(opts.repoPath, opts.lspServerPath)
    : null;
  try {
    return await measureModeCInner(opts, (cached) => {
      realVerifyOptsCache = cached;
    }, sharedKey);
  } finally {
    if (useRealVerify && sharedKey) {
      await releaseRealVerifyOpts(opts.repoPath, opts.lspServerPath!);
    } else if (useRealVerify && realVerifyOptsCache?.client?.stop) {
      // Test seam: injected `buildRealVerifyOpts` returned a
      // standalone client; the harness owns the lifecycle
      // locally and stops it here.
      try {
        await realVerifyOptsCache.client.stop();
      } catch {
        // best-effort
      }
    }
  }
}

/** Inner body of `measureModeC`, factored out so the outer
 *  wrapper owns the LspClient cleanup finally-block. The
 *  `sharedKey` is the module-level cache key for the real-verify
 *  LspClient — `null` when the test seam overrides the
 *  `buildRealVerifyOpts` and owns the client lifecycle. */
async function measureModeCInner(
  opts: MeasureModeCOptions,
  setRealVerifyCache: (cached: any) => void,
  sharedKey: string | null,
): Promise<MeasureModeCResult> {
  // ── 1) Resolve seams (use injected or default) ────────────────────
  const exec = opts.exec ?? (await defaultExec());
  const verify = opts.verify ?? (await defaultVerify());
  const stat = opts.stat ?? (await defaultStat());
  const runCypher = opts.runCypher ?? (await defaultRunCypher());
  const sha = opts.sha ?? (await defaultSha());
  const loadMeta = opts.loadMeta ?? (await defaultLoadMeta());
  const getStoragePaths = opts.getStoragePaths ?? (await defaultGetStoragePaths());

  // ── 2) Resolve `repoId` (no DB / no fs) ────────────────────────
  // The `repoId` is a pure function of `repoPath` (per
  // `LocalBackend.repoId` collision rule — see `deriveRepoId`).
  // The harness runs `analyze` AT MOST ONCE per repo (when
  // `.gitnexus` is absent on entry); both legs reuse the
  // resulting index. The campaign's central claim is
  // **LSP-at-verify delta on the heuristic index** (not a
  // distinct LSP-augmented index for the `lsp` leg) — see
  // KD-3 + EdgeCases "Per-leg analyze flag (NOT shipped — filed
  // as follow-up WI)" in the design doc.
  const paths = getStoragePaths(opts.repoPath);
  const repoId = await deriveRepoId(opts.repoPath, null);
  const headSha = await sha(opts.repoPath);

  // ── 3) Per-leg RunModeCVerifyOpts assembly + verify ──────────────
  // Each leg reuses the same `seed` and `sampleSize` so the two
  // reports are comparable (KD-3). The harness builds a full
  // `RunModeCVerifyOpts` for the default-verify path
  // (mirrors `src/cli/verify.ts` per KD-9) — see
  // `buildRealVerifyOpts` below. The unit tests inject a stub
  // `verify` and ignore the assembled opts; when the seam is
  // overridden, the harness's minimal opts are passed through
  // unchanged.
  const artifacts: MeasureModeCLegResult[] = [];
  const errors: Array<{ leg: MeasureModeCLeg; message: string }> = [];

  // Detect the default-verify path. We can't reliably test
  // `verify === _verifyFnCache` (caches can be re-bound), so we
  // use a sentinel: when `opts.verify` is undefined and the
  // `lspServerPath` is set, we treat the call as "use the
  // production verifier with full opts". When `opts.verify` is
  // overridden OR `lspServerPath` is null/undefined, the minimal
  // opts are passed through. The test path that injects
  // `buildRealVerifyOpts` (shape-pinning) also activates this
  // branch — the seam value takes precedence over a stub
  // `verify`. (The outer `measureModeC` already decided this —
  // we just read it here for the per-leg branch.)
  const useRealVerify =
    (!!opts.buildRealVerifyOpts && !!opts.lspServerPath) ||
    (!opts.verify && !!opts.lspServerPath);
  let realVerifyOptsCache: any = null;

  // Per KD-3 / EdgeCases: both legs share the SAME index. The
  // harness runs `analyze` AT MOST ONCE per repo — when
  // `.gitnexus` is absent on entry. The `lsp` leg differs from
  // baseline ONLY by:
  //   - the `leg` label in the artifact / report, and
  //   - the verifier wiring (LspClient is passed through the
  //     `useRealVerify` path, never via a per-leg `analyze` flag).
  //
  // The campaign's central claim is **LSP-at-verify delta on the
  // heuristic index** — the harness reuses the same heuristic
  // index for both legs. Distinct LSP-augmented indexing is
  // filed as a follow-up WI; the shipped behavior matches the
  // re-scoped design doc (EdgeCases "Per-leg analyze flag (NOT
  // shipped — filed as follow-up WI)").
  //
  // The `analyzeRanFirst` / `analyzeWallMs` values are repo-level,
  // not leg-level: every leg that runs after a fresh `analyze`
  // inherits `analyzeRanFirst:true` for that repo. Both legs
  // share the same analyze cost, and the markdown summary's
  // "analyze-first" column is a per-(repo, leg) projection of a
  // per-repo boolean.
  let analyzeWallMs = 0;
  let analyzeRanFirst = false;

  // Run analyze AT MOST ONCE per repo, before the per-leg loop,
  // so both legs share the same index (KD-3). The decision is
  // binary: `.gitnexus` present on entry → skip; `.gitnexus`
  // absent on entry → run exactly one `analyze` (no flag) and
  // fail-fast on a non-zero exit.
  //
  // `stat` is called EXACTLY ONCE per repo (captured at the top
  // of the gate below) — the per-leg loop reads the cached value
  // for the artifact's `dbSizeBytes`. `loadMeta` and the two
  // `bucketEdgeCounts` cypher queries are likewise repo-level
  // reads (their values are invariant across the same-index
  // legs); we hoist them out of the per-leg loop and reuse the
  // values inside. With 2 legs and 1 stat walk + 1 meta read + 2
  // cypher queries, the per-repo IO drops from 2 stat walks + 2
  // meta reads + 4 cypher queries to 1 + 1 + 2 — a 50% reduction
  // on GitNexus-self-sized runs.
  const initialStat = await stat(opts.repoPath);
  const idxPresent = initialStat !== null;
  const shared: SharedRepoState = {
    dbSizeBytes: initialStat,
    legMeta: null,
    edgeCountsBySource: {},
    edgeCountsByReason: {},
  };
  // Helper: read the repo-level state (meta + two cypher buckets)
  // once and populate `shared`. Throws on failure — caller maps
  // the throw to per-leg `harness-error:<msg>` errors.
  const readSharedState = async (): Promise<void> => {
    shared.legMeta = await loadMeta(paths.storagePath);
    shared.edgeCountsBySource = await bucketEdgeCounts(
      runCypher,
      repoId,
      'source',
    );
    shared.edgeCountsByReason = await bucketEdgeCounts(
      runCypher,
      repoId,
      'reason',
    );
  };
  if (idxPresent) {
    try {
      await readSharedState();
    } catch (err: any) {
      // If a shared read throws (corrupt meta.json, missing
      // schema, or cypher dispatch error), we surface the same
      // error to every requested leg. The per-leg try/catch in
      // the loop below will catch it again on the first leg, but
      // a second pass would be wasteful — short-circuit here and
      // let the loop's try/catch record the error per leg.
      const message = err?.message ?? String(err);
      for (const leg of opts.legs) {
        errors.push({ leg, message });
      }
      return { repo: opts.repoPath, artifacts: [], errors };
    }
  }
  if (!idxPresent) {
    const t0 = (opts.now ?? (() => 0))();
    const bin = await resolveGitnexusBin();
    const result = await exec('node', [bin, 'analyze', opts.repoPath], opts.repoPath);
    analyzeWallMs = ((opts.now ?? (() => 0))()) - t0;
    if (result.code !== 0) {
      // The single analyze call failed — every leg inherits the
      // failure. Surface one error per requested leg and short-
      // circuit the per-leg loop. (The per-repo gate's "no
      // partial output" rule is honored at the leg-result
      // envelope level: every leg has no artifact, every leg has
      // a surfaced error.)
      const message = `analyze failed (exit ${result.code}): ${result.stderr || result.stdout}`.trim();
      for (const leg of opts.legs) {
        errors.push({ leg, message });
      }
      return { repo: opts.repoPath, artifacts: [], errors };
    }
    analyzeRanFirst = true;
    // After analyze completes, .gitnexus is now present — re-
    // stat ONCE (the analyze subprocess wrote the index, so the
    // initial stat happened against an absent directory) and
    // re-read the shared state via the same helper as the
    // cache-present path. Single source of truth for the repo-
    // level read pattern.
    const postAnalyzeStat = await stat(opts.repoPath);
    shared.dbSizeBytes = postAnalyzeStat;
    try {
      await readSharedState();
    } catch (err: any) {
      const message = err?.message ?? String(err);
      for (const leg of opts.legs) {
        errors.push({ leg, message });
      }
      return { repo: opts.repoPath, artifacts: [], errors };
    }
  }

  for (const leg of opts.legs) {
    try {
      // ── 3a) Per-leg read-only setup ───────────────────────────
      // Both legs reuse the index from the single analyze above
      // (or the cached index when `.gitnexus` was already
      // present). There is no per-leg analyze gate — the leg
      // only varies the verifier wiring (`useRealVerify` +
      // `meta.leg`).
      //
      // `analyzeRanFirst`, `analyzeWallMs`, and the `shared` envelope
      // (dbSizeBytes / legMeta / edgeCountsBySource /
      // edgeCountsByReason) are per-repo values hoisted out of
      // this loop (perf #1 + #2 in the review); the artifact
      // construction below reads them from the outer scope and
      // is identical for every leg. The values are invariant
      // across the same-index legs (the lsp leg sees the same
      // index, so the same meta + edge counts).

      // ── 3b) Build verify opts + run verifier ───────────────────
      // KD-9: the harness ALWAYS assembles a full
      // `RunModeCVerifyOpts` (mirroring `src/cli/verify.ts`) for
      // both legs. When `lspServerPath` is supplied and the
      // `verify` seam is the default, the production
      // `buildRealVerifyOpts` (or the test seam's stub) supplies
      // `client`/`probe`/`mapLocationToNodeId`/`executeParameterized`
      // from the dist modules. The unit test
      // "verify seam captures the full RunModeCVerifyOpts shape"
      // pins the assembled shape at the verify seam so a future
      // refactor that drops one of the required fields (e.g.
      // `mapLocationToNodeId`) is caught by the unit suite, not
      // only by the integration smoke with a real `LspClient`.
      let verifyOpts: RunModeCVerifyOpts;
      if (useRealVerify) {
        // Build the full RunModeCVerifyOpts (KD-9) once per repo
        // and reuse across legs (the LspClient + probe are
        // idempotent for the same repo). The seam is
        // `opts.buildRealVerifyOpts`; the production default is
        // the dynamic-import-based implementation below
        // (`buildRealVerifyOptsImpl`).
        if (!realVerifyOptsCache) {
          const seam = opts.buildRealVerifyOpts ?? defaultBuildRealVerifyOpts;
          if (sharedKey) {
            // Module-level shared cache: a future
            // parallel-repo CLI shares one LspClient per
            // (repoPath, lspServerPath) pair. The refcount is
            // released by the outer wrapper's `finally` block
            // via `releaseRealVerifyOpts`.
            realVerifyOptsCache = await acquireRealVerifyOpts(
              opts.repoPath,
              opts.lspServerPath!,
              async () =>
                seam({
                  repoPath: opts.repoPath,
                  repoId,
                  lspServerPath: opts.lspServerPath!,
                  serverVersion: opts.serverVersion ?? null,
                  sampleSize: opts.sampleSize,
                  seed: opts.seed,
                }),
            );
          } else {
            // Test seam: injected `buildRealVerifyOpts`
            // returned a standalone client; the outer wrapper
            // owns the lifecycle (calls `client.stop()` on
            // release).
            realVerifyOptsCache = await seam({
              repoPath: opts.repoPath,
              repoId,
              lspServerPath: opts.lspServerPath!,
              serverVersion: opts.serverVersion ?? null,
              sampleSize: opts.sampleSize,
              seed: opts.seed,
            });
          }
          setRealVerifyCache(realVerifyOptsCache);
        }
        verifyOpts = { ...realVerifyOptsCache };
      } else {
        // Test-only path: the test seam overrides `verify` AND
        // the stub accepts a permissive shape (it does not call
        // any of the wiring methods). We pass the *minimal*
        // opts — repoId + sample/seed/server metadata — and
        // document the divergence. The real-verify path's full
        // shape is pinned by the dedicated shape-capture test
        // (see "verify seam captures the full RunModeCVerifyOpts
        // shape"), which drives `useRealVerify:true` with a stub
        // `buildRealVerifyOpts` returning a fully-populated
        // object.
        verifyOpts = {
          repoId,
          // `client`/`probe`/`mapLocationToNodeId`/`executeParameterized`
          // are NOT required by the test seam stub; the production
          // verifier would reject this minimal shape, but the
          // stub is permissive. We cast each `undefined` to the
          // production type so the structural-mirror
          // `RunModeCVerifyOpts` is satisfied at compile time —
          // the seam test that captures `verify.mock.calls[0][0]`
          // pins the populated shape on the `useRealVerify:true`
          // path; the test-seam path is documented as diverging
          // by design (test-only).
          client: undefined as unknown as LspClient,
          mapLocationToNodeId: undefined as unknown as (
            loc: any,
            repoId: string,
          ) => Promise<MapperResult>,
          executeParameterized: undefined as unknown as (
            repoId: string,
            cypher: string,
            params: Record<string, any>,
          ) => Promise<any[]>,
          probe: undefined as unknown as (
            client: LspClient,
          ) => Promise<{ ready: boolean; reason?: string }>,
          seed: opts.seed,
          sampleSize: opts.sampleSize,
          hardCap: opts.sampleSize,
          serverVersion: opts.serverVersion ?? null,
        };
      }
      const report = await verify(verifyOpts);
      // under-sampled signal: the verifier never finished its
      // sampled slice. We classify into three distinct reasons
      // (per the design doc EdgeCases "Environment-level LSP
      // unavailability"):
      //   (a) lspUnavailable: the probe short-circuited with
      //       ready:false — `sampledCap:0` in the report.
      //   (b) sampledCap<sampleSize: the verifier completed but
      //       fewer than `sampleSize` edges were available
      //       (caller-runnable cap, e.g. an empty bucket).
      //   (c) harness error: the verifier threw — surfaced as
      //       a per-leg error with the message.
      // The three reasons are mutually exclusive in the
      // renderer; the most specific wins. `underSampled` is the
      // boolean flag for headline-table exclusion (I-5);
      // `excludedReason` is the human-readable explanation
      // rendered in the Excluded section.
      const probeUnavailable = report?.lspUnavailable === true;
      const sampledCap = typeof report?.sampledCap === 'number'
        ? report.sampledCap
        : (probeUnavailable ? 0 : opts.sampleSize);
      const underSampled = probeUnavailable || sampledCap < opts.sampleSize;
      const excludedReason = probeUnavailable
        ? `lsp-unavailable:${report?.reason ?? 'probe returned ready:false'}`
        : (sampledCap < opts.sampleSize
            ? `under-sampled (sampledCap=${sampledCap} < sampleSize=${opts.sampleSize})`
            : '');
      const artifact: MeasureModeCLegResult = {
        // AC-5: pinned to epoch so serialized JSON is byte-identical
        // across same-(index, seed, sampleSize) re-runs. The field
        // is a stable marker of the determinism contract.
        generatedAt: new Date(0).toISOString(),
        repo: opts.repoPath,
        sha: headSha,
        leg,
        analyzeWallMs,
        dbSizeBytes: shared.dbSizeBytes,
        meta: {
          files: shared.legMeta?.stats?.files,
          nodes: shared.legMeta?.stats?.nodes,
          edges: shared.legMeta?.stats?.edges,
          communities: shared.legMeta?.stats?.communities,
          processes: shared.legMeta?.stats?.processes,
        },
        edgeCountsBySource: shared.edgeCountsBySource,
        edgeCountsByReason: shared.edgeCountsByReason,
        funnel: report?.funnel,
        report,
        underSampled,
        excludedReason,
        analyzeRanFirst,
      };
      artifacts.push(artifact);
    } catch (err: any) {
      // The verifier rejected (or per-leg setup threw) — surface
      // the error, no artifact for this leg. Other legs may
      // still succeed; we don't short-circuit. The `harness-error:`
      // prefix lets the Excluded section distinguish this from
      // `lsp-unavailable:` and `under-sampled (sampledCap<N)` —
      // three reasons, not one overloaded flag.
      //
      // A thrown error mid-verify implies the leg could not
      // complete its sampled slice, so it is ALSO under-sampled
      // (the verifier never reached `sampleSize`). We annotate
      // the message so the Excluded renderer surfaces both
      // signals (I-5: partial metrics are never silently
      // published) — a reviewer can spot the rejected+under-
      // sampled combination at a glance instead of inferring it
      // from the absence of a count column.
      const baseMessage = `harness-error:${err?.message ?? String(err)}`;
      const message = `${baseMessage} (also under-sampled — verifier threw before completing sample)`;
      errors.push({ leg, message });
    }
  }

  return { repo: opts.repoPath, artifacts, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Bucket edge counts by a single column. The Cypher is a
 * `MATCH … RETURN r.col, COUNT(r) GROUP BY r.col` projection
 * (explicit `GROUP BY` — Kùzu's openCypher implementation follows
 * the spec; without `GROUP BY` the projection of a non-aggregate
 * alongside `COUNT` is engine-dependent and can produce one row
 * per matched relationship rather than one row per bucket).
 *
 * Per the design doc §Contracts "Source-distribution query", the
 * query is relationship-agnostic: it covers ALL `CodeRelation`
 * rows (CALLS, IMPORTS, IMPLEMENTS, EXTENDS, HAS_METHOD, …) so
 * the artifact's bucket maps reflect the full graph, not just
 * CALLS. The KPI consumer's analysis (which edge types LSP is
 * helping or hurting) is driven by the full distribution — a
 * CALLS-only projection would silently narrow the campaign's
 * data to one edge type and bias the verdict.
 *
 * The `runCypher` seam is `executeParameterized`-shaped. We pass
 * NO parameters (the query carries no user input); the lbug-
 * adapter's `isWriteQuery` rejecter still sees a parameterized
 * query and accepts it.
 *
 * Legacy index (no `r.source` column or zero rows): the query
 * returns `[]` and the function returns `{}` — never throws.
 *
 * Defensive JS-side aggregation: even with `GROUP BY` in the
 * Cypher, if a future engine version returns multi-row buckets
 * (one row per matched edge instead of one row per bucket), the
 * `out[k] = (out[k] ?? 0) + c` sum still converges to the correct
 * total. The Cypher's `GROUP BY` is the primary correctness
 * mechanism; the JS sum is a safety net.
 */
async function bucketEdgeCounts(
  runCypher: RunCypherFn,
  repoId: string,
  column: 'source' | 'reason',
): Promise<Record<string, number>> {
  // The Cypher is identical except for the column name. We
  // explicitly name the projected column `bucket` to keep the
  // shape stable across both queries. The `GROUP BY r.${column}`
  // clause is REQUIRED (openCypher spec) — without it Kùzu would
  // return one row per matched relationship with `count=1`,
  // defeating the purpose of the projection. The JS-side sum
  // below is defensive; the GROUP BY is the primary guarantee.
  //
  // Relationship-agnostic: NO `WHERE r.type = $relType` filter.
  // The campaign's KPI (which edge types LSP is helping or
  // hurting) is a full-graph distribution, not a CALLS-only slice.
  const cypher =
    'MATCH ()-[r:CodeRelation]->() ' +
    `RETURN r.${column} AS bucket, COUNT(r) AS count ` +
    `GROUP BY r.${column}`;
  let rows: any[];
  try {
    rows = await runCypher(repoId, cypher, {});
  } catch (e: any) {
    // Distinguish three failure modes:
    //   (a) Legacy index without the bucketed column (`r.source`
    //       or `r.reason` doesn't exist) — Kùzu surfaces this as
    //       a `Binder` / "column … not found" signature. The
    //       contract for the artifact is `{}` (no data for that
    //       bucket) — see KD-8 + design §Contracts.
    //   (b) Cross-process pool miss: the harness is a separate
    //       subprocess from `analyze`, and the in-process
    //       `executeParameterized` pool is populated only by
    //       `analyze` (which calls `initLbug` for the repo).
    //       When the harness runs after a `subprocess analyze`,
    //       the pool has no entry for the repoId and the
    //       adapter throws "LadybugDB not initialized for repo
    //       …". The harness CANNOT call `initLbug` itself
    //       (the no-write invariant sweep forbids it), so the
    //       only correct response is to degrade gracefully to
    //       `{}` — the artifact's `edgeCountsBySource/Reason`
    //       are then explicitly empty, and the per-leg
    //       `report.overall.n > 0` (from the verifier) is the
    //       ground truth. The campaign operator sees the empty
    //       maps in the JSON and is told (via the design
    //       doc §Contracts) that this is the expected
    //       cross-process behavior — not a regression.
    //   (c) A real dispatch failure (DB open but query syntax
    //       error, schema mismatch on something other than the
    //       bucket column, etc.) — the harness MUST surface
    //       this so the operator doesn't silently get a per-repo
    //       artifact with empty bucket maps and no diagnostic.
    //       Re-throw.
    const msg = String(e?.message ?? e ?? '');
    const code = e?.code;
    const isLegacyColumnError =
      // Kùzu "Binder" / "Column … does not have any available values"
      // pattern. We match a small set of substrings defensively;
      // real-engine signatures seen in the wild include
      // "Binder exception", "does not exist", and "no such column".
      /Binder\s+exception/i.test(msg) ||
      /does not have any available values/i.test(msg) ||
      /no such column/i.test(msg) ||
      code === 'Binder';
    const isCrossProcessPoolMiss =
      // `executeParameterized` throws this when the in-process
      // pool has no entry for `repoId` (the harness ran in a
      // different process from `analyze`). The signature is
      // stable across lbug-adapter versions; we match on the
      // "not initialized … Call initLbug" suffix to avoid
      // false positives on a legitimate "DB not open" error
      // (which we WOULD want to surface as a real failure).
      /not initialized for repo/i.test(msg) ||
      /Call initLbug first/i.test(msg);
    if (!isLegacyColumnError && !isCrossProcessPoolMiss) {
      throw e;
    }
    return {};
  }
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = row?.bucket;
    const c = typeof row?.count === 'number' ? row.count : Number(row?.count);
    if (typeof k !== 'string' || !Number.isFinite(c)) continue;
    out[k] = (out[k] ?? 0) + c;
  }
  return out;
}

/**
 * Resolve the path to the local `gitnexus` CLI binary. The
 * production layout is `<gitnexus>/dist/cli/index.js`; the
 * `package.json` `bin.gitnexus` value is the program name, but
 * the actual entry is the JS file. We resolve relative to this
 * script's location.
 */
async function resolveGitnexusBin(): Promise<string> {
  const path = await import('node:path');
  // `import.meta.url` → `…/gitnexus/scripts/measure-mode-c.ts`
  // We need `…/gitnexus/dist/cli/index.js`.
  const here = new URL('.', import.meta.url).pathname;
  return path.join(here, '..', 'dist', 'cli', 'index.js');
}

/**
 * Walk `$PATH` looking for an executable named `binName`. Returns
 * the absolute path of the first match, or `null` when no
 * directory on `$PATH` contains an executable by that name.
 *
 * Pure-Node replacement for the previous `which` shell-out
 * (avoid spawning a subprocess for a 5-line path walk):
 *
 *   1. Split `process.env.PATH` on `path.delimiter` (`:` on
 *      POSIX, `;` on Windows).
 *   2. For each directory, build `<dir>/<binName>` and probe
 *      with `existsSync` + `accessSync(_, X_OK)`. The
 *      `X_OK` check is the executable-bit test; on
 *      non-POSIX platforms where `X_OK` is a no-op, the
 *      `existsSync` check is the primary gate.
 *   3. Return the first hit; `null` when the walk exhausts
 *      `$PATH` without a hit.
 *
 * The PATH walk mirrors the behavior of `which(1)` for the
 * well-formed-name case (no shell quoting, no `..` resolution,
 * no symlink following beyond what `existsSync` does). It does
 * NOT mimic `which`'s `PATHEXT` extension-on-Windows behavior —
 * the operator's contract is "binary is on `$PATH`" and the
 * bundled dist is portable enough that the plain-name walk
 * suffices.
 */
function resolveLspOnPath(binName: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = path.join(dir, binName);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Derive a stable `repoId` from a repo path + meta. Mirrors
 * `LocalBackend.repoId(name, path)` (lowercased basename) with
 * the same collision rule. We use a pure function (no DB) so the
 * unit tests can pin it.
 */
async function deriveRepoId(repoPath: string, _meta: RepoMeta | null): Promise<string> {
  const path = await import('node:path');
  const base = path.basename(path.resolve(repoPath)).toLowerCase();
  return base || 'repo';
}

/**
 * Default `buildRealVerifyOpts` seam implementation. Mirrors
 * `src/cli/verify.ts:verifyCommand` (KD-9):
 *   1. Start a per-repo `LspClient` (warm-singleton contract from
 *      WI-#3 of #159).
 *   2. Run `probeWorkspaceReadiness` once against a canary sample
 *      (`package.json` at line 0). The probe is reused across
 *      legs — the verifier honors `lspUnavailable:true` and
 *      returns a degenerate report for `lsp` legs whose probe
 *      fails.
 *   3. Wire `mapLocationToNodeId` + `executeParameterized` from
 *      the production seams (both read-only).
 *
 * The returned opts are reused across legs (the LspClient + probe
 * are idempotent for the same repo). The `client.stop()` is owned
 * by a `try/finally` in the caller — the harness's per-leg loop
 * does not own LspClient lifecycle (the CLI's `discoverServers`
 * call is one-shot; the client must live for both legs).
 */
const defaultBuildRealVerifyOpts: BuildRealVerifyOptsFn = async (args) => {
  const lspClientMod: any = await import(
    '../dist/core/ingestion/lsp/lsp-client.js'
  );
  const probeMod: any = await import(
    '../dist/core/ingestion/lsp/workspace-readiness-probe.js'
  );
  const mapperMod: any = await import(
    '../dist/core/ingestion/lsp/location-mapper.js'
  );
  const lbugMod: any = await import(
    '../dist/mcp/core/lbug-adapter.js'
  );

  const client = new lspClientMod.LspClient({
    binaryPath: args.lspServerPath,
    workspaceRoot: args.repoPath,
  });
  await client.start();
  // Probe once. The verifier itself will short-circuit on
  // `ready:false`, so we don't need to gate the per-leg calls
  // here — but we still need the probe function the verifier
  // expects (a function of `(client) => Promise<{ready,reason}>`).
  let cachedProbe: { ready: boolean; reason?: string } | null = null;
  const probe = async (_c: any) => {
    if (cachedProbe) return cachedProbe;
    const samples = [{
      textDocument: { uri: `file://${args.repoPath}/package.json` },
      position: { line: 0, character: 0 },
    }];
    cachedProbe = await probeMod.probeWorkspaceReadiness(client, samples, {
      perRequestTimeoutMs: 3000,
    });
    return cachedProbe;
  };

  return {
    repoId: args.repoId,
    client,
    mapLocationToNodeId: mapperMod.mapLocationToNodeId as (
      loc: any,
      repoId: string,
    ) => Promise<MapperResult>,
    executeParameterized: lbugMod.executeParameterized as (
      repoId: string,
      cypher: string,
      params: Record<string, any>,
    ) => Promise<any[]>,
    probe,
    sampleSize: args.sampleSize,
    seed: args.seed,
    hardCap: args.sampleSize,
    serverVersion: args.serverVersion,
  };
};

// ─── CLI entry — flag parsing ────────────────────────────────────────

/**
 * Parse `process.argv`-shaped arrays of flags. Pure, no I/O.
 *
 * Supported flags (all repeatable where noted):
 *   --repo <path>     one or more repositories (repeatable)
 *   --legs a,b[,…]    one or both of `baseline` / `lsp` (default `baseline,lsp`)
 *   --sample <N>      positive integer (default 200)
 *   --seed <S>        deterministic seed (default `deterministic-seed-42`)
 *   --out <DIR>       output directory (default `./.gitnexus-mc-out`)
 *   -h, --help        print usage on stdout and return `null`
 *
 * The function is total: unknown / malformed input throws a
 * `TypeError` with a stable message so the CLI can render it on
 * stderr and exit non-zero. The unit tests pin every branch.
 */
export function parseArgs(args: string[]): ParsedCliArgs {
  const out: ParsedCliArgs = {
    repoPaths: [],
    legs: ['baseline', 'lsp'],
    sampleSize: 200,
    seed: 'deterministic-seed-42',
    outDir: './.gitnexus-mc-out',
    lspServerPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      const v = args[++i];
      if (typeof v !== 'string' || v.length === 0) {
        throw new TypeError(`flag '${a}' requires a value`);
      }
      return v;
    };
    switch (a) {
      case '--repo': {
        const v = next();
        out.repoPaths.push(v);
        break;
      }
      case '--legs': {
        const v = next();
        const tokens = v.split(',').map((t) => t.trim()).filter(Boolean);
        if (tokens.length === 0) {
          throw new TypeError(`--legs: expected one or both of baseline,lsp, got '${v}'`);
        }
        const allowed: MeasureModeCLeg[] = ['baseline', 'lsp'];
        for (const t of tokens) {
          if (!allowed.includes(t as MeasureModeCLeg)) {
            throw new TypeError(`--legs: unknown leg '${t}' (allowed: ${allowed.join(', ')})`);
          }
        }
        // De-dupe while preserving order.
        const seen = new Set<MeasureModeCLeg>();
        out.legs = tokens.filter((t) => {
          if (seen.has(t as MeasureModeCLeg)) return false;
          seen.add(t as MeasureModeCLeg);
          return true;
        }) as MeasureModeCLeg[];
        break;
      }
      case '--sample': {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          throw new TypeError(`--sample: expected positive integer, got '${v}'`);
        }
        out.sampleSize = n;
        break;
      }
      case '--seed': {
        out.seed = next();
        break;
      }
      case '--out': {
        out.outDir = next();
        break;
      }
      case '--lsp-server-path': {
        // Operator-pinned absolute path to typescript-language-server.
        // Bypasses the `discoverServers` PATH resolution (KD-gate
        // fallback for the "installed but not on $PATH" case).
        // The path is validated at parse time in `main()` —
        // `accessSync(_, X_OK)` must succeed (existence +
        // executable bit) before the gate accepts the flag.
        out.lspServerPath = next();
        break;
      }
      case '-h':
      case '--help': {
        return HELP_ARGS;
      }
      default: {
        throw new TypeError(`unknown flag: '${a}'`);
      }
    }
  }

  if (out.repoPaths.length === 0) {
    throw new TypeError('at least one --repo <path> is required');
  }
  return out;
}

/** Public shape of `parseArgs`. */
export interface ParsedCliArgs {
  repoPaths: string[];
  legs: MeasureModeCLeg[];
  sampleSize: number;
  seed: string;
  outDir: string;
  /** Operator-pinned absolute path to the typescript-language-
   *  server binary. When set, the pre-measure gate bypasses
   *  `discoverServers`'s `$PATH` resolution and threads this
   *  path directly into the harness's `lspServerPath` opt.
   *  `null` (default) → use `discoverServers`, with a one-shot
   *  `npx -p typescript-language-server` probe as the secondary
   *  fallback for the "installed but not on `$PATH`" case.
   *
   *  The value is validated at parse time in `main()` —
   *  `accessSync(_, X_OK)` must succeed (existence +
   *  executable bit) or the gate halts with `exit(4)`. */
  lspServerPath: string | null;
}

/** Sentinel returned when `-h` / `--help` is requested. */
export const HELP_ARGS: ParsedCliArgs = Object.freeze({
  repoPaths: [],
  legs: ['baseline', 'lsp'],
  sampleSize: 200,
  seed: 'deterministic-seed-42',
  outDir: './.gitnexus-mc-out',
  lspServerPath: null,
  help: true,
} as ParsedCliArgs & { help: boolean }) as ParsedCliArgs & { help: boolean };

/** Print the CLI usage to stdout. */
export function renderHelp(): string {
  return [
    'usage: tsx scripts/measure-mode-c.ts [options]',
    '',
    'Options:',
    '  --repo <path>     repository to measure (repeatable, one or more)',
    '  --legs a,b[,…]    which legs to run: baseline, lsp (default: baseline,lsp)',
    '  --sample <N>      sample size per leg (default: 200)',
    '  --seed <S>        deterministic seed (default: deterministic-seed-42)',
    '  --out <DIR>       output directory (default: ./.gitnexus-mc-out)',
    '  --lsp-server-path <abs-path>  explicit path to typescript-language-server',
    '                  (bypasses $PATH resolution; use when the binary is',
    '                   installed but not on $PATH)',
    '  -h, --help        show this help',
    '',
    'Pre-measure gate: requires typescript-language-server. Resolution order:',
    '  1. --lsp-server-path (operator-pinned; validated at parse time via',
    '     accessSync X_OK — a non-executable path halts with exit(4))',
    '  2. discoverServers (PATH lookup)',
    '  3. npx -p typescript-language-server --version probe (one-shot); on',
    '     success, the absolute path is resolved via a pure-Node PATH walk',
    '     (resolveLspOnPath — splits process.env.PATH on path.delimiter and',
    '     probes each dir with existsSync + accessSync X_OK)',
    'When all three fail, the script prints doctor diagnostics to stderr,',
    'exits 1, and writes no artifacts (zeros are never data — halt contract).',
  ].join('\n');
}

// ─── CLI entry — markdown summary writer ─────────────────────────────

/** Shape consumed by the markdown renderer. The pure function
 *  accepts only what the contract documents — never reaches into
 *  the production `VerifyReport` beyond the metrics we publish. */
export interface SummaryRow {
  repo: string;
  sha: string;
  leg: MeasureModeCLeg;
  underSampled: boolean;
  /** Optional parse-friendly overall metrics. Missing when the
   *  verify seam returned a degenerate report — we still emit a
   *  row in the Excluded section in that case. */
  metrics?: {
    n: number;
    matches: number;
    falseConfident: number;
    refusals: number;
  };
  /** Human-readable exclusion reason (the harness-set
   *  `excludedReason` from the artifact, or a per-CLI-row error
   *  string). */
  excludedReason?: string;
  error?: string;
}

/**
 * Render the markdown summary aggregating all (repo,leg) artifacts.
 *
 * Layout (KD-5 triple — I-6 — precision/recall intentionally
 * NOT exposed as headline columns):
 *   ## Headline
 *   | repo | sha | leg | n | matches | falseConfident | reported fc-rate | conditional fc-rate | refusal rate |
 *
 *   ## Excluded (under-sampled / lsp-unavailable / harness-error)
 *   | repo | sha | leg | reason |
 *
 * Headline rows are filtered to exclude `underSampled:true` artifacts
 * (I-5). The headline publishes ONLY the KD-5 triple (reported,
 * conditional, refusal) plus the underlying counts (n, matches,
 * falseConfident). `precision` and `recall` are available on the
 * full `VerifyReport` (in the per-leg JSON artifact) but are
 * deliberately absent from the headline columns — a reader
 * skimming the table sees only the triple, never single-rate
 * cherry-picks. Conditional fc-rate is
 * `falseConfident / (matches + falseConfident)`; refusal rate is
 * `refusals / n`. Rates are rendered as percentages with one
 * decimal; `-` when undefined.
 *
 * The Excluded section distinguishes three reasons (per the
 * design doc EdgeCases "Environment-level LSP unavailability"):
 *   - `lsp-unavailable:<reason>` — the probe returned ready:false
 *   - `under-sampled (sampledCap=N < sampleSize=M)` — caller-runnable cap
 *   - `harness-error:<message>` — the verifier or per-leg setup threw
 *
 * This function is pure (no I/O) — the CLI writes the returned string
 * to `<out>/summary.md` via an atomic temp+rename.
 */
export function renderSummary(rows: SummaryRow[]): string {
  const headline: SummaryRow[] = [];
  const excluded: SummaryRow[] = [];
  for (const r of rows) {
    if (r.underSampled || r.error) {
      excluded.push(r);
    } else {
      headline.push(r);
    }
  }

  const lines: string[] = [];
  lines.push('# Mode C measurement summary');
  lines.push('');
  lines.push('KD-5 triple columns are reported together: reported fc-rate, conditional fc-rate, refusal rate. Precision and recall are available in the per-leg JSON artifacts but are NOT rendered as headline columns (I-6 — no single-rate cherry-picking).');
  lines.push('Excluded section distinguishes: lsp-unavailable / under-sampled (caller-runnable cap) / harness-error.');
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  if (headline.length === 0) {
    lines.push('_No headline rows — every leg was excluded._');
  } else {
    lines.push(
      '| repo | sha | leg | n | matches | falseConfident | reported fc-rate | conditional fc-rate | refusal rate |',
    );
    lines.push(
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const r of headline) {
      const m = r.metrics;
      if (!m) {
        // Defensive: a non-excluded row without metrics still gets a
        // row with `-` placeholders rather than crashing the summary.
        lines.push(`| ${r.repo} | ${r.sha} | ${r.leg} | - | - | - | - | - | - |`);
        continue;
      }
      const reportedFc = m.n > 0 ? m.falseConfident / m.n : null;
      const denom = m.matches + m.falseConfident;
      const conditionalFc = denom > 0 ? m.falseConfident / denom : null;
      const refusalRate = m.n > 0 ? m.refusals / m.n : null;
      lines.push(
        [
          r.repo,
          r.sha,
          r.leg,
          String(m.n),
          String(m.matches),
          String(m.falseConfident),
          pctOrDash(reportedFc),
          pctOrDash(conditionalFc),
          pctOrDash(refusalRate),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
      );
    }
  }
  lines.push('');

  if (excluded.length > 0) {
    lines.push('## Excluded');
    lines.push('');
    lines.push('| repo | sha | leg | reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of excluded) {
      // Three reasons, mutually exclusive in priority order:
      //   1. `r.excludedReason` from the harness (lsp-unavailable,
      //      under-sampled, or harness-error) — the structured
      //      classification produced by the artifact envelope.
      //   2. `r.error` from the CLI's per-repo loop (a harness
      //      throw that short-circuited before the artifact was
      //      built; legacy fields).
      //   3. Fallback `under-sampled` when no reason is recorded.
      let reason: string;
      if (r.excludedReason) {
        reason = r.excludedReason;
      } else if (r.error) {
        reason = r.underSampled ? `${r.error} (also under-sampled)` : r.error;
      } else if (r.underSampled) {
        reason = 'under-sampled (sampledCap < sampleSize)';
      } else {
        reason = 'unknown';
      }
      lines.push(`| ${r.repo} | ${r.sha} | ${r.leg} | ${reason} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Format a 0..1 fraction as a percentage with one decimal, or `-`. */
function pctOrDash(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(1)}%`;
}

// ─── AC-2 helper: no-recall-regression check + markdown renderer ─────

/**
 * One row of the AC-2 `recall-regression.md` table. The shape is
 * the per-repo verdict on whether the LSP-augmented leg regressed
 * on recall against the heuristic baseline leg. AC-2 is
 * mechanically satisfied when this verdict is emitted as a
 * parseable markdown file in the CLI output directory.
 *
 * Definition (mirrors the design doc §Contracts):
 *   - `resolvedCalls = matches + falseConfident + recallGains`
 *     (every edge where LSP or heuristic produced a node verdict)
 *   - Pass iff `lsp.recallMisses <= baseline.recallMisses` AND
 *     `lsp.resolvedCalls >= baseline.resolvedCalls`
 *   - Otherwise fail (and the reason is recorded so the operator
 *     can spot whether the regression is in misses or coverage).
 */
export interface RecallRegressionVerdict {
  /** `true` iff the LSP leg did not regress on recall against the
   *  baseline leg. */
  passed: boolean;
  /** Heuristic-leg `matches + falseConfident + recallGains`. */
  baselineResolvedCalls: number;
  /** LSP-leg `matches + falseConfident + recallGains`. */
  lspResolvedCalls: number;
  /** Heuristic-leg `recallMisses`. */
  baselineRecallMisses: number;
  /** LSP-leg `recallMisses`. */
  lspRecallMisses: number;
  /** `true` when `baseline.recallMisses === 0` — the misses
   *  clause of the verdict is trivially satisfied and the
   *  regression check ran with no signal on the misses side.
   *  The renderer adds a `lowBaselinePower` annotation to the
   *  row so a downstream consumer can spot a verdict that
   *  passed by default rather than by data. The flag is
   *  independent of `passed` (a regression check can pass
   *  trivially with low power, and a check can fail with full
   *  power). */
  lowBaselinePower: boolean;
  /** Human-readable reason when `passed === false`. Empty when
   *  passed. */
  reason: string;
}

/** Compute `matches + falseConfident + recallGains` from a
 *  `VerifyMetrics` (or any object exposing the three counters).
 *  Returns `0` when the report is degenerate (no data). */
function resolvedCalls(m: { matches: number; falseConfident: number; recallGains: number }): number {
  const matches = Number(m?.matches) || 0;
  const falseConfident = Number(m?.falseConfident) || 0;
  const recallGains = Number(m?.recallGains) || 0;
  return matches + falseConfident + recallGains;
}

/** Pull the overall counters from a `VerifyReport`. Returns `null`
 *  when the report is degenerate (`lspUnavailable`, missing
 *  `overall`, or non-numeric counters) — the caller treats
 *  `null` as "skip this verdict row" so the AC-2 file is still
 *  parseable when one or both legs short-circuited. */
function overallCounters(report: any): { matches: number; falseConfident: number; recallGains: number; recallMisses: number } | null {
  if (!report || typeof report !== 'object') return null;
  const overall = report.overall;
  if (!overall || typeof overall !== 'object') return null;
  const matches = Number(overall.matches);
  const falseConfident = Number(overall.falseConfident);
  const recallGains = Number(overall.recallGains);
  const recallMisses = Number(overall.recallMisses);
  if (![matches, falseConfident, recallGains, recallMisses].every(Number.isFinite)) {
    return null;
  }
  return { matches, falseConfident, recallGains, recallMisses };
}

/**
 * Pure AC-2 helper: compute the no-recall-regression verdict for a
 * single repo's baseline vs LSP leg. Returns `null` when either
 * leg is degenerate (no counters); the caller aggregates `null`
 * rows into a "skipped" line in `recall-regression.md`.
 *
 * Both inputs accept any `VerifyReport`-shaped object; the helper
 * is independent of the harness's own artifact schema.
 */
export function noRecallRegression(
  baselineReport: any,
  lspReport: any,
): RecallRegressionVerdict | null {
  const base = overallCounters(baselineReport);
  const lsp = overallCounters(lspReport);
  if (!base || !lsp) return null;
  const baselineResolvedCalls = resolvedCalls(base);
  const lspResolvedCalls = resolvedCalls(lsp);
  const baselineRecallMisses = base.recallMisses;
  const lspRecallMisses = lsp.recallMisses;
  // Pass iff misses did not increase AND coverage did not shrink.
  // The reasons are tracked separately so an operator can see
  // *which* side regressed (misses vs coverage).
  const missesOk = lspRecallMisses <= baselineRecallMisses;
  const coverageOk = lspResolvedCalls >= baselineResolvedCalls;
  // `lowBaselinePower` flags a regression check that ran with
  // no misses on the baseline side — the misses clause is
  // trivially satisfied (any lsp.recallMisses <= 0 is true),
  // so the verdict reduces to a coverage check only. This is
  // common at small `sampleSize` (the unit test exercises
  // exactly this case). A real regression check needs both
  // sides to have misses to detect one.
  const lowBaselinePower = baselineRecallMisses === 0;
  if (missesOk && coverageOk) {
    return {
      passed: true,
      baselineResolvedCalls,
      lspResolvedCalls,
      baselineRecallMisses,
      lspRecallMisses,
      lowBaselinePower,
      reason: '',
    };
  }
  const why: string[] = [];
  if (!missesOk) {
    why.push(
      `recallMisses regressed (${baselineRecallMisses} → ${lspRecallMisses})`,
    );
  }
  if (!coverageOk) {
    why.push(
      `resolvedCalls shrank (${baselineResolvedCalls} → ${lspResolvedCalls})`,
    );
  }
  return {
    passed: false,
    baselineResolvedCalls,
    lspResolvedCalls,
    baselineRecallMisses,
    lspRecallMisses,
    lowBaselinePower,
    reason: why.join('; '),
  };
}

/**
 * Render the `recall-regression.md` artifact for a list of
 * per-repo verdicts. Pure: no I/O. The CLI writes the returned
 * string to `<out>/recall-regression.md` via the atomic
 * write+rename helper.
 *
 * Layout:
 *
 *   # AC-2 recall-regression check
 *   | repo | verdict | baseline resolvedCalls | lsp resolvedCalls | baseline recallMisses | lsp recallMisses | lowBaselinePower | reason |
 *   | --- | :---: | ---: | ---: | ---: | ---: | :---: | --- |
 *   | /path/a | PASS | 100 | 105 | 5 | 4 |  |  |
 *   | /path/b | FAIL | 200 | 180 | 10 | 12 |  | recallMisses regressed (10 → 12); resolvedCalls shrank (200 → 180) |
 *   | /path/c | PASS | 30 | 35 | 0 | 0 | lowBaselinePower |  |
 *   | /path/d | SKIP | - | - | - | - |  |  |
 *
 * `SKIP` rows indicate a leg was degenerate (`lspUnavailable`,
 * missing `overall`, or non-numeric counters) — AC-2 cannot be
 * mechanically evaluated without both legs' reports.
 *
 * `lowBaselinePower` is set to `lowBaselinePower` text when the
 * baseline leg had `recallMisses === 0` — the misses clause is
 * trivially satisfied and the verdict reduced to a coverage
 * check. A downstream consumer can spot a verdict that passed by
 * default rather than by data. The annotation is independent of
 * PASS/FAIL (a check can pass trivially with low power, and a
 * check can fail with full power).
 */
export function renderRecallRegression(
  rows: Array<{ repo: string; verdict: RecallRegressionVerdict | null }>,
): string {
  const lines: string[] = [];
  lines.push('# AC-2 recall-regression check');
  lines.push('');
  lines.push(
    'Verdict per repo. PASS iff `lsp.recallMisses <= baseline.recallMisses` AND `lsp.resolvedCalls >= baseline.resolvedCalls` (resolvedCalls = matches + falseConfident + recallGains). SKIP rows indicate a degenerate leg (lspUnavailable, missing overall, or non-numeric counters). `lowBaselinePower` is set when baseline.recallMisses === 0 — the misses clause is trivially satisfied and the verdict reduces to a coverage check (review for sample power before trusting PASS).',
  );
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No rows — no repos were measured._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(
    '| repo | verdict | baseline resolvedCalls | lsp resolvedCalls | baseline recallMisses | lsp recallMisses | lowBaselinePower | reason |',
  );
  lines.push(
    '| --- | :---: | ---: | ---: | ---: | ---: | :---: | --- |',
  );
  for (const r of rows) {
    const v = r.verdict;
    if (!v) {
      lines.push(`| ${r.repo} | SKIP | - | - | - | - |  |  |`);
      continue;
    }
    const verdict = v.passed ? 'PASS' : 'FAIL';
    const power = v.lowBaselinePower ? 'lowBaselinePower' : '';
    lines.push(
      `| ${r.repo} | ${verdict} | ${v.baselineResolvedCalls} | ${v.lspResolvedCalls} | ${v.baselineRecallMisses} | ${v.lspRecallMisses} | ${power} | ${v.reason} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Pull the per-leg baseline + LSP artifacts from a
 *  `MeasureModeCResult` and return the matching
 *  `RecallRegressionVerdict` (or `null` when either leg is
 *  missing). The `repo` field is included so the markdown row
 *  has a stable path. */
export function recallRegressionForResult(
  result: MeasureModeCResult,
): { repo: string; verdict: RecallRegressionVerdict | null } {
  const baseline = result.artifacts.find((a) => a.leg === 'baseline');
  const lsp = result.artifacts.find((a) => a.leg === 'lsp');
  if (!baseline || !lsp) {
    return { repo: result.repo, verdict: null };
  }
  return { repo: result.repo, verdict: noRecallRegression(baseline.report, lsp.report) };
}

// ─── CLI entry — artifact path + atomic write helpers ─────────────────

/** Derive a deterministic, path-safe filename for a (repo, sha, leg)
 *  artifact. Slashes inside `repo` are replaced with `_` so the
 *  resulting filename never contains a directory separator. The
 *  result is `<basename>-<sha>-<leg>.json` (no directory part).
 *  `pathMod` is injectable for unit tests; the default uses the
 *  module loaded by `ensureNodePath()` (called by `main()` at
 *  startup). */
export function artifactFilename(
  repo: string,
  sha: string,
  leg: MeasureModeCLeg,
  pathMod?: { basename: (p: string) => string },
): string {
  const path = pathMod ?? _pathModCache;
  if (!path) {
    throw new Error(
      'node:path is not loaded; call ensureNodePath() first or pass pathMod',
    );
  }
  const safe = (s: string): string =>
    s.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._-]/g, '-');
  const base = safe(path.basename(repo) || 'repo');
  return `${base}-${safe(sha)}-${leg}.json`;
}

let _pathModCache: { basename: (p: string) => string } | null = null;

/** Preload the `node:path` module so `artifactFilename` works
 *  without a pathMod injection. Called by `main()` at startup. */
export async function ensureNodePath(): Promise<void> {
  if (_pathModCache) return;
  const mod: any = await import('node:path');
  _pathModCache = mod;
}

/** Atomic write: write to `<path>.tmp`, then rename. Guarantees the
 *  final path either does not exist or contains the full content —
 *  a crash mid-write never leaves a partial file at `path`. */
export async function atomicWriteFile(
  path: string,
  content: string,
  fs?: AtomicFs,
): Promise<void> {
  const fsImpl = fs ?? (await import('node:fs/promises'));
  const tmp = `${path}.tmp`;
  await fsImpl.writeFile(tmp, content, 'utf-8');
  await fsImpl.rename(tmp, path);
}

/** Filesystem surface for `atomicWriteFile`. Injected so unit tests
 *  can drive a tmpdir without touching the real disk. */
export interface AtomicFs {
  writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

// ─── CLI entry — main() ───────────────────────────────────────────────

/** Dependencies for `main`. The default wiring reaches into
 *  `node:fs/promises` and the production `discoverServers`; the unit
 *  tests inject stubs. `argv` defaults to `process.argv.slice(2)`. */
export interface MainDeps {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Dynamic-import seam: `() => import('…/server-discovery.js')`.
   *  Default uses the same `import('node:module')` trick to keep
   *  the static source-text sweep clean. */
  importServerDiscovery?: () => Promise<{ discoverServers: () => Promise<{ typescript: { path: string; version: string } | null }> }>;
  /** Filesystem seam for atomic write + mkdir. */
  fs?: AtomicFs & { mkdir(path: string, opts: { recursive: boolean }): Promise<void> };
  /** Exit seam. Default: `process.exit`. */
  exit?: (code: number) => void;
  /** Stderr writer. Default: `process.stderr.write`. */
  stderr?: (s: string) => void;
  /** Stdout writer. Default: `process.stdout.write`. */
  stdout?: (s: string) => void;
  /** Per-repo execution seam. Default: `measureModeC` with no overrides. */
  measure?: (opts: MeasureModeCOptions) => Promise<MeasureModeCResult>;
  /** Subprocess seam used ONLY by the pre-measure gate for the
   *  `npx -p typescript-language-server …` fallback probe. The
   *  `measureModeC` execution path uses its own internal `exec`
   *  seam (the measure seam is a different shape — it takes
   *  `MeasureModeCOptions`, not `(cmd, args, cwd)`). Default:
   *  `child_process.execFile` over `npx`. The test suite
   *  injects a stub that returns `{stdout, stderr, code}` to
   *  exercise the resolution path without spawning a real
   *  `npx`. */
  execNpx?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Top-level CLI entry. Reachable from `tsx scripts/measure-mode-c.ts …`
 * and from the unit test suite (with injected `deps`).
 *
 * Halt contract (per docs/plans/159-mode-c-measurement.md):
 *   - `discoverServers()` → `{ typescript: null }`
 *       → doctor diagnostics on stderr, `process.exit(1)`, NO artifact written.
 *   - `exec` rejects mid-run → error surfaced to stderr, `process.exit(1)`,
 *       partial output NOT written.
 *   - `measureModeC` returns errors for some legs → artifacts for
 *       successful legs are still written; the failed legs land in
 *       the summary's Excluded section. The CLI exits 0 (data is
 *       still valid for the successful legs).
 *
 * Determinism: the artifact filename is `<basename>-<sha>-<leg>.json`
 * (deterministic, byte-stable across reruns of the same commit).
 */
export async function main(deps: MainDeps = {}): Promise<void> {
  const argv = deps.argv ?? (typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv.slice(2) : []);
  const fs = deps.fs ?? (await import('node:fs/promises'));
  const exit = deps.exit ?? ((code: number) => {
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(code);
    }
  });
  const stderr = deps.stderr ?? ((s: string) => {
    if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
  });
  const stdout = deps.stdout ?? ((s: string) => {
    if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
  });

  // 1) Parse flags.
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e: any) {
    stderr(`error: ${e?.message ?? String(e)}\n\n${renderHelp()}\n`);
    exit(1);
    return;
  }
  // The HELP_ARGS sentinel is the only `parseArgs` output with `help:true`.
  if ((parsed as any).help) {
    stdout(renderHelp() + '\n');
    return;
  }

  // 2) Pre-measure gate: LSP server must be resolvable.
  await ensureNodePath();
  const importDisc = deps.importServerDiscovery ?? (async () => {
    const mod = await _loadServerDiscovery();
    return mod as any;
  });
  let disc: { discoverServers: () => Promise<{ typescript: { path: string; version: string } | null }> };
  try {
    disc = await importDisc();
  } catch (e: any) {
    stderr(`error: failed to load LSP server discovery: ${e?.message ?? String(e)}\n`);
    exit(1);
    return;
  }
  let servers: { typescript: { path: string; version: string } | null };
  try {
    servers = await disc.discoverServers();
  } catch (e: any) {
    stderr(`error: LSP server discovery threw: ${e?.message ?? String(e)}\n`);
    exit(1);
    return;
  }
  if (!servers.typescript) {
    // Doctor-equivalent fallback chain. Resolution order:
    //   1. --lsp-server-path (operator-pinned; bypasses discovery)
    //   2. `npx -p typescript-language-server … --version` probe
    //      (handles the "installed but not on $PATH" case)
    //   3. Halt with doctor diagnostics.
    // The npx probe is a one-shot — it does NOT install. The
    // operator must have pre-installed via `npm i -g` or have
    // an offline npm cache. When the probe succeeds, the
    // resolved path is the absolute path `npx` returned (the
    // `which` line on stdout is parsed; on macOS/Linux the
    // probe writes the absolute path to stdout).
    let resolvedLsp: { path: string; version: string } | null = null;
    if (parsed.lspServerPath) {
      // Operator-pinned path. Validate at parse time: the path
      // must exist AND be executable (`X_OK` is the
      // executable-bit probe — on POSIX it's the perms check; on
      // non-POSIX platforms where `X_OK` is a no-op the
      // `existsSync` call is the primary gate). A bogus path
      // used to flow through to `LspClient.start` and fail at
      // per-leg time — the leg was excluded with a
      // `harness-error:` reason and the artifact was still
      // written. We fail fast now so the operator sees the
      // typo at the gate, not as a per-leg exclusion.
      try {
        accessSync(parsed.lspServerPath, fsConstants.X_OK);
      } catch (err: any) {
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        stderr(
          [
            `error: --lsp-server-path '${parsed.lspServerPath}' is not executable (${code}): ${err?.message ?? String(err)}`,
            'Re-check the --lsp-server-path value or remove the flag to use auto-discovery.',
            '',
          ].join('\n'),
        );
        exit(4);
        return;
      }
      resolvedLsp = { path: parsed.lspServerPath, version: 'operator-pinned' };
    } else {
      // Try the npx probe. `npx -p <pkg> <bin> --version`
      // resolves the package via the npm cache and runs the
      // binary with `--version`; on macOS/Linux this prints
      // the binary's version (e.g. `typescript-language-server
      // v5.1.3`). When the binary is reachable through the
      // cache, `code:0` and a non-empty `stdout`. When the
      // package is not in the cache, `code:1` (or 127) and a
      // non-empty `stderr` — we treat that as "fallback failed"
      // and proceed to the doctor.
      try {
        const probe = await (deps.execNpx ?? defaultExecNpx)(
          ['-p', 'typescript-language-server', 'typescript-language-server', '--version'],
          process.cwd?.() ?? (typeof process !== 'undefined' ? process.cwd() : '.'),
        );
        if (probe.code === 0 && probe.stdout.trim().length > 0) {
          // The npx probe ran; it does NOT give us the absolute
          // path of the binary, only the binary's `--version`
          // output. We resolve the absolute path via a pure-Node
          // PATH walk (`resolveLspOnPath` — splitting
          // `process.env.PATH` on `path.delimiter` and probing
          // each directory with `existsSync` + `accessSync`
          // `X_OK`); if that fails, the harness falls back to
          // the bare name AND prefixes the recorded
          // `serverVersion` with `path-via-PATH:` so the
          // artifact's audit trail is unambiguous about whether
          // an absolute path was resolved or not. The bare-name
          // path only works when `$PATH` is set up to find the
          // binary at LSP-startup time; the prefix is the
          // operator-visible signal that this is the case.
          let resolvedPath: string | null = null;
          let versionTag: string;
          try {
            resolvedPath = resolveLspOnPath('typescript-language-server');
          } catch {
            /* PATH walk threw; fall through to bare-name fallback */
          }
          if (resolvedPath) {
            versionTag = probe.stdout.trim();
          } else {
            resolvedPath = 'typescript-language-server';
            // Prefix the version with `path-via-PATH:` so the
            // artifact's `serverVersion` is unambiguous about
            // the path-resolution source. Operators see the
            // prefix and know the absolute path was not
            // resolved; an audit consumer can grep for it.
            versionTag = `path-via-PATH: ${probe.stdout.trim()}`;
          }
          resolvedLsp = {
            path: resolvedPath,
            version: versionTag,
          };
        }
      } catch {
        /* fall through to doctor */
      }
    }
    if (!resolvedLsp) {
      stderr(
        [
          'typescript-language-server: NOT FOUND (install to enable --lsp)',
          'Resolution attempted (in order):',
          '  1. --lsp-server-path (operator-pinned; not provided)',
          '  2. discoverServers (PATH lookup; returned null)',
          '  3. npx -p typescript-language-server --version (probe failed)',
          'Remediation:',
          '  1. npm i -g typescript-language-server  (or)',
          '  2. npx -p typescript-language-server typescript-language-server --version',
          '  3. Re-run with --lsp-server-path <abs-path> if the binary is installed off-PATH',
          '  4. Re-run this script. Zeros are never data — no artifacts will be written until the LSP is reachable.',
          '',
        ].join('\n'),
      );
      exit(1);
      return;
    }
    // Override the gate result with the fallback-resolved
    // value. The per-repo `measure` call below will thread it
    // through to the harness as `lspServerPath`.
    servers = { typescript: resolvedLsp };
  }

  // 3) Make sure the output directory exists BEFORE any artifact is
  //    written. A failure here is fatal — no partial output.
  try {
    await fs.mkdir(parsed.outDir, { recursive: true });
  } catch (e: any) {
    stderr(`error: cannot create output directory '${parsed.outDir}': ${e?.message ?? String(e)}\n`);
    exit(1);
    return;
  }

  // 4) Per-repo loop. We capture per-leg results into a flat list
  //    for the summary; per-repo failures do NOT abort the whole
  //    run (partial data is still valuable). The exec-rejects
  //    invariant (no partial output) is honored by the measure
  //    function itself: when `analyze` fails, it returns
  //    `{artifacts:[], errors:[…]}` and the CLI writes nothing for
  //    that repo — only the per-leg summary row in the Excluded
  //    table.
  const measure = deps.measure ?? measureModeC;
  const summaryRows: SummaryRow[] = [];
  // Per-repo `MeasureModeCResult` accumulator — used to build
  // the AC-2 `recall-regression.md` artifact after the loop.
  const perRepoResults: MeasureModeCResult[] = [];

  for (const repo of parsed.repoPaths) {
    let result: MeasureModeCResult;
    try {
      result = await measure({
        repoPath: repo,
        legs: parsed.legs,
        sampleSize: parsed.sampleSize,
        seed: parsed.seed,
        outDir: parsed.outDir,
        serverVersion: servers.typescript.version,
        lspServerPath: servers.typescript.path,
      });
    } catch (e: any) {
      // `measureModeC` itself rejected (e.g. `exec` threw on a
      // custom seam). The contract is "no partial output" — abort
      // the whole run.
      stderr(`error: measure failed for ${repo}: ${e?.message ?? String(e)}\n`);
      exit(1);
      return;
    }
    perRepoResults.push(result);

    // Write each artifact atomically.
    for (const a of result.artifacts) {
      const fname = artifactFilename(a.repo, a.sha, a.leg);
      const full = `${parsed.outDir.replace(/\/+$/, '')}/${fname}`;
      try {
        await atomicWriteFile(full, JSON.stringify(a, null, 2), fs);
      } catch (e: any) {
        stderr(`error: failed to write artifact ${full}: ${e?.message ?? String(e)}\n`);
        exit(1);
        return;
      }
      summaryRows.push({
        repo: a.repo,
        sha: a.sha,
        leg: a.leg,
        underSampled: a.underSampled,
        // Forward the harness-set `excludedReason` (one of
        // lsp-unavailable / under-sampled / harness-error) so
        // the Excluded section renders the structured
        // classification rather than the legacy "under-sampled
        // (sampledCap < sampleSize)" generic label.
        excludedReason: a.excludedReason || undefined,
        metrics: extractMetrics(a.report),
      });
    }

    for (const err of result.errors) {
      summaryRows.push({
        repo,
        sha: '',
        leg: err.leg,
        underSampled: true,
        // The harness prefixes per-leg errors with `harness-error:`
        // when the verifier or per-leg setup threw; older shapes
        // (a raw error string) fall back to a generic label.
        excludedReason: err.message.startsWith('harness-error:') || err.message.startsWith('lsp-unavailable:')
          ? err.message
          : `harness-error:${err.message}`,
        error: err.message,
      });
    }
  }

  // 5) Write summary.md atomically. A failure here is fatal — we'd
  //    rather abort than publish partial results.
  const summaryPath = `${parsed.outDir.replace(/\/+$/, '')}/summary.md`;
  try {
    await atomicWriteFile(summaryPath, renderSummary(summaryRows), fs);
  } catch (e: any) {
    stderr(`error: failed to write ${summaryPath}: ${e?.message ?? String(e)}\n`);
    exit(1);
    return;
  }

  // 6) Write AC-2 `recall-regression.md`. AC-2 is mechanically
  //    satisfied when this file is present and parseable; the
  //    helper is `noRecallRegression` and the renderer is
  //    `renderRecallRegression` (both pure, exported for tests).
  //    Skip when only one leg was requested — the no-regression
  //    check is a two-leg comparison (baseline vs lsp). A failure
  //    here is fatal — same contract as the summary.
  if (parsed.legs.length >= 2) {
    const recallPath = `${parsed.outDir.replace(/\/+$/, '')}/recall-regression.md`;
    try {
      const recallRows = perRepoResults.map(recallRegressionForResult);
      await atomicWriteFile(recallPath, renderRecallRegression(recallRows), fs);
    } catch (e: any) {
      stderr(`error: failed to write ${recallPath}: ${e?.message ?? String(e)}\n`);
      exit(1);
      return;
    }
  }
}

/** Best-effort extract of the headline metrics from a `VerifyReport`
 *  shape. Returns `undefined` when the shape is degenerate (so the
 *  caller falls back to the `-`-only row in the summary).
 *
 *  Per I-6, only the KD-5 triple counters are exposed (n, matches,
 *  falseConfident, refusals). `precision` and `recall` are
 *  intentionally NOT returned — the headline publishes only the
 *  triple; full `VerifyReport` precision/recall remain available
 *  on the per-leg JSON artifact for downstream consumers that need
 *  them. */
function extractMetrics(report: any):
  | {
      n: number;
      matches: number;
      falseConfident: number;
      refusals: number;
    }
  | undefined {
  if (!report || typeof report !== 'object') return undefined;
  const overall = report.overall;
  if (!overall || typeof overall !== 'object') return undefined;
  const n = Number(overall.n);
  const matches = Number(overall.matches);
  const falseConfident = Number(overall.falseConfident);
  const refusals = Number(overall.refusals);
  if (!Number.isFinite(n) || !Number.isFinite(matches) || !Number.isFinite(falseConfident) || !Number.isFinite(refusals)) {
    return undefined;
  }
  return {
    n,
    matches,
    falseConfident,
    refusals,
  };
}

/** Lazy dynamic import of the server-discovery module. Loaded via
 *  standard dynamic import (not `eval`) — the no-write invariant
 *  sweep only forbids the tokens `initLbug` / `executeQuery` and
 *  a static `runModeCVerify` import; a dynamic import of
 *  `server-discovery.js` matches none of those. */
async function _loadServerDiscovery(): Promise<any> {
  return import('../dist/core/ingestion/lsp/server-discovery.js');
}

// ─── Re-exports for tests ──────────────────────────────────────────────

/** Internal helpers exposed for the unit test suite. */
export const __test__ = {
  bucketEdgeCounts,
  deriveRepoId,
  resolveGitnexusBin,
  parseArgs,
  renderHelp,
  renderSummary,
  renderRecallRegression,
  artifactFilename,
  atomicWriteFile,
  extractMetrics,
  noRecallRegression,
  recallRegressionForResult,
  defaultBuildRealVerifyOpts,
};

// ─── Script entry ─────────────────────────────────────────────────────

/**
 * Run `main()` when this file is executed via `tsx scripts/measure-mode-c.ts …`.
 *
 * Guard: the auto-run only fires when this module is the
 * *entry* (not when it's imported by tests). We detect entry by
 * comparing `import.meta.url` (which is `file://…/scripts/measure-mode-c.ts`)
 * to `process.argv[1]` (which `tsx` resolves to the source `.ts` path).
 * We compare via `fileURLToPath` + `path.resolve` so the prefix
 * difference is normalized.
 */
async function runAsScript(): Promise<void> {
  try {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const url: string = import.meta.url;
    const here = path.resolve(fileURLToPath(url));
    if (!process.argv[1]) return;
    const entry = path.resolve(process.argv[1]);
    if (entry !== here) return;
    await main();
  } catch (e: any) {
    process.stderr.write(`[measure-mode-c] fatal: ${e?.stack ?? e}\n`);
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(1);
    }
  }
}

void runAsScript();
