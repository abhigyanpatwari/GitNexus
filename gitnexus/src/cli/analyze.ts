/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 *
 * Delegates core analysis to the shared runFullAnalysis orchestrator.
 * This CLI wrapper handles: heap management, progress bar, SIGINT,
 * skill generation (--skills), summary output, and process.exit().
 */

import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { isLbugReady } from '../core/lbug/lbug-adapter.js';
import { boundedCheckpointBeforeExit } from '../core/lbug/shutdown-helpers.js';
import {
  isLbugCheckpointIoError,
  isWalCorruptionError,
  parseWalCheckpointThreshold,
  WAL_RECOVERY_SUGGESTION,
} from '../core/lbug/lbug-config.js';
import {
  getStoragePaths,
  getGlobalRegistryPath,
  RegistryNameCollisionError,
  AnalysisNotFinalizedError,
  assertAnalysisFinalized,
} from '../storage/repo-manager.js';
import { getGitRoot, hasGitDir, getDefaultBranch } from '../storage/git.js';
import {
  loadAnalyzeConfig,
  mergeAnalyzeOptions,
  resolveDefaultBranch,
  validateBranchName,
  GitNexusRcError,
} from './analyze-config.js';
import { runFullAnalysis } from '../core/run-analyze.js';
import { getMaxFileSizeBannerMessage } from '../core/ingestion/utils/max-file-size.js';
import { warnMissingOptionalGrammars, getOptionalGrammarExtensions } from './optional-grammars.js';
import { glob } from 'glob';
import fs from 'fs/promises';
import { cliError } from './cli-message.js';
import { EMBEDDING_DIMS_ERROR, normalizeEmbeddingDims } from './embedding-dims.js';
import { formatElapsed } from './format-elapsed.js';
import { isHfDownloadFailure } from '../core/embeddings/hf-env.js';
import { safeUrl } from '../core/embeddings/http-client.js';
import { isLocalEmbeddingRuntimeBlockerMessage } from '../core/embeddings/runtime-support.js';
import { warnIfNpm11NpxRisk } from './resolve-invocation.js';

// Capture stderr.write at module load BEFORE anything (LadybugDB native
// init, progress bar, console redirection) can monkey-patch it. The
// fatal handlers below MUST reach the user even when the analyze path
// has redirected console.* through the progress bar's bar.log() — the
// previous behaviour silently swallowed stack traces and made #1169
// indistinguishable from a no-op success on Windows.
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realStdoutWrite = process.stdout.write.bind(process.stdout);

const writeFatalToStderr = (label: string, err: unknown): void => {
  const isErr = err instanceof Error;
  const message = isErr ? err.message : String(err);
  realStderrWrite(`\n  ${label}: ${message}\n`);
  if (isErr && err.stack) realStderrWrite(`${err.stack}\n`);
  // Walk and print the `cause` chain. The phase runner wraps the underlying
  // failure as `new Error("Phase 'X' failed: …", { cause })`, so the original
  // error (e.g. a WorkerPoolDispatchError carrying the worker-side stack from
  // #2068) is only reachable via `.cause`. Without this the user sees the
  // wrapper's main-thread stack and never the real frame. `cause.stack` already
  // begins with the cause's message, so we print the stack alone (not message +
  // stack) to avoid repeating it. Depth-bounded so a cyclic `cause` can't loop
  // (the phase runner wraps one level; the bound leaves headroom for future
  // nesting); uses realStderrWrite so the redirected console.error's ANSI
  // clear-line wrapping can't erase it (#1169).
  const MAX_CAUSE_DEPTH = 5;
  let cause: unknown = isErr ? (err as { cause?: unknown }).cause : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause instanceof Error; depth++) {
    realStderrWrite(`\n  Caused by: ${cause.stack ?? cause.message}\n`);
    cause = (cause as { cause?: unknown }).cause;
  }
};

let fatalHandlersInstalled = false;

/**
 * Install one-shot `unhandledRejection` / `uncaughtException` handlers
 * that surface the failure to the real stderr (bypassing any console
 * redirection installed by the progress bar) and force a non-zero exit
 * code. Without these, an async error escaping {@link analyzeCommand}'s
 * try/catch was reported as exit 0 with no diagnostic — the silent
 * failure mode tracked in #1169.
 */
const installFatalHandlers = (): void => {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  process.on('unhandledRejection', (err) => {
    writeFatalToStderr('Analysis failed (unhandled rejection)', err);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    writeFatalToStderr('Analysis failed (uncaught exception)', err);
    process.exit(1);
  });
};

/** Historical floor for the re-exec heap cap — the auto-sizer never goes below
 *  this, so small boxes / CI never regress. */
const DEFAULT_HEAP_MB = 16384;

/**
 * RAM-aware re-exec heap cap (MB): `0.75 × effective RAM`, clamped to
 * `>= DEFAULT_HEAP_MB`. Kept BELOW physical RAM on purpose — a cap `>=` RAM makes
 * V8 collect lazily and inflate the heap into swap-thrash (observed analyzing the
 * Linux kernel at a 30GB cap on a 31GB box). `constrainedBytes` is the cgroup
 * limit or `null`; it is honored only as a real, smaller-than-physical cap, because
 * `process.constrainedMemory()` returns a huge sentinel when UNCONSTRAINED.
 */
export function computeHeapCapMb(totalBytes: number, constrainedBytes: number | null): number {
  const effectiveBytes =
    constrainedBytes !== null && constrainedBytes > 0 && constrainedBytes < totalBytes
      ? constrainedBytes
      : totalBytes;
  const effectiveMb = Math.floor(effectiveBytes / (1024 * 1024));
  return Math.max(DEFAULT_HEAP_MB, Math.floor(0.75 * effectiveMb));
}

function readConstrainedBytes(): number | null {
  if (typeof process.constrainedMemory !== 'function') return null;
  const c = process.constrainedMemory();
  return typeof c === 'number' && c > 0 ? c : null;
}

const HEAP_MB = computeHeapCapMb(os.totalmem(), readConstrainedBytes());
const TEST_RESPAWN_HEAP_MB = Number(process.env.GITNEXUS_TEST_RESPAWN_HEAP_MB);
const RESPAWN_HEAP_MB =
  Number.isFinite(TEST_RESPAWN_HEAP_MB) && TEST_RESPAWN_HEAP_MB > 0
    ? Math.floor(TEST_RESPAWN_HEAP_MB)
    : HEAP_MB;
const HEAP_FLAG = `--max-old-space-size=${RESPAWN_HEAP_MB}`;
/** Larger semi-space (young-gen) cuts minor-GC frequency + promotion churn during
 *  the multi-million-node graph build/emit. Allowed in NODE_OPTIONS (unlike
 *  --stack-size), so it propagates to the re-exec env cleanly. */
const SEMI_SPACE_MB = 128;
const SEMI_FLAG = `--max-semi-space-size=${SEMI_SPACE_MB}`;
/** Increase default stack size (KB) to prevent stack overflow on deep class hierarchies. */
const STACK_KB = 4096;
const STACK_FLAG = `--stack-size=${STACK_KB}`;
const RESPAWN_OUTPUT_TAIL_CHARS = 1024 * 1024;
const RESPAWN_PROGRESS_ENV = 'GITNEXUS_RESPAWN_PROGRESS_TTY';

interface CliProgressTerminal {
  cursorSave(): void;
  cursorRestore(): void;
  cursor(enabled: boolean): void;
  lineWrapping(enabled: boolean): void;
  cursorTo(x?: number | null, y?: number | null): void;
  cursorRelative(dx?: number | null, dy?: number | null): void;
  cursorRelativeReset(): void;
  clearRight(): void;
  clearLine(): void;
  clearBottom(): void;
  newline(): void;
  write(s: string, rawWrite?: boolean): void;
  isTTY(): boolean;
  getWidth(): number;
}

const terminalColumns = (): number => {
  const parsed = Number(process.env.COLUMNS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
};

const ANSI_ESCAPE_PATTERN =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|[78]|[@-Z\\-_])/y;

interface IntlSegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

type IntlWithOptionalSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: 'grapheme' },
  ) => IntlSegmenterLike;
};

const splitGraphemes = (text: string): string[] => {
  const Segmenter = (Intl as IntlWithOptionalSegmenter).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (s) => s.segment,
    );
  }
  return Array.from(text);
};

const isZeroWidthCodePoint = (codePoint: number): boolean =>
  codePoint === 0x200d ||
  (codePoint >= 0x0300 && codePoint <= 0x036f) ||
  (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
  (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
  (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  (codePoint >= 0xfe20 && codePoint <= 0xfe2f);

const isWideCodePoint = (codePoint: number): boolean =>
  codePoint >= 0x1100 &&
  (codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd));

const visibleColumns = (text: string): number => {
  let columns = 0;
  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue;
    columns += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return columns;
};

const readAnsiEscapeAt = (text: string, index: number): string | undefined => {
  ANSI_ESCAPE_PATTERN.lastIndex = index;
  return ANSI_ESCAPE_PATTERN.exec(text)?.[0];
};

const truncateAnsiToColumns = (text: string, maxColumns: number): string => {
  if (!Number.isFinite(maxColumns) || maxColumns <= 0) return '';

  let output = '';
  let columns = 0;
  let index = 0;

  while (index < text.length) {
    const escape = readAnsiEscapeAt(text, index);
    if (escape) {
      output += escape;
      index += escape.length;
      continue;
    }

    const nextEscapeIndex = text.indexOf('\x1B', index);
    const plainEnd = nextEscapeIndex === -1 ? text.length : nextEscapeIndex;
    const plainText = text.slice(index, plainEnd);

    for (const segment of splitGraphemes(plainText)) {
      const width = visibleColumns(segment);
      if (width > 0 && columns + width > maxColumns) return output;
      output += segment;
      columns += width;
    }

    index = plainEnd;
  }

  return output;
};

const createAnsiPipeTerminal = (stream: NodeJS.WriteStream): CliProgressTerminal => {
  let linewrap = true;
  let dy = 0;
  const write = (s: string): void => {
    stream.write(s);
  };
  const moveVertical = (delta: number): void => {
    if (delta > 0) write(`\x1B[${delta}B`);
    else if (delta < 0) write(`\x1B[${Math.abs(delta)}A`);
  };

  return {
    cursorSave: () => write('\x1B7'),
    cursorRestore: () => write('\x1B8'),
    cursor: (enabled) => write(enabled ? '\x1B[?25h' : '\x1B[?25l'),
    lineWrapping: (enabled) => {
      linewrap = enabled;
      write(enabled ? '\x1B[?7h' : '\x1B[?7l');
    },
    cursorTo: (x = null, y = null) => {
      if (typeof y === 'number' && typeof x === 'number') {
        write(`\x1B[${y + 1};${x + 1}H`);
        return;
      }
      if (typeof x === 'number') {
        write(x === 0 ? '\r' : `\x1B[${x + 1}G`);
      }
    },
    cursorRelative: (dx = null, nextDy = null) => {
      if (typeof dx === 'number' && dx !== 0) {
        write(dx > 0 ? `\x1B[${dx}C` : `\x1B[${Math.abs(dx)}D`);
      }
      if (typeof nextDy === 'number' && nextDy !== 0) {
        dy += nextDy;
        moveVertical(nextDy);
      }
    },
    cursorRelativeReset: () => {
      moveVertical(-dy);
      write('\r');
      dy = 0;
    },
    clearRight: () => write('\x1B[0K'),
    clearLine: () => write('\x1B[2K'),
    clearBottom: () => write('\x1B[0J'),
    newline: () => {
      write('\n');
      dy++;
    },
    write: (s, rawWrite = false) => {
      const width = terminalColumns();
      write(linewrap && rawWrite === false ? truncateAnsiToColumns(s, width) : s);
    },
    isTTY: () => true,
    getWidth: terminalColumns,
  };
};

const shouldBridgeRespawnProgressTty = (): boolean =>
  process.stderr.isTTY === true || process.stdout.isTTY === true;

interface RespawnExit {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

const appendOutputTail = (tail: string, chunk: unknown): string => {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : typeof chunk === 'string'
      ? chunk
      : String(chunk ?? '');
  if (!text) return tail;
  const next = tail + text;
  return next.length > RESPAWN_OUTPUT_TAIL_CHARS ? next.slice(-RESPAWN_OUTPUT_TAIL_CHARS) : next;
};

/**
 * Run the respawned analyzer while teeing child output through to the parent
 * and keeping a bounded tail for crash classification.
 *
 * `execFileSync(..., { stdio: 'inherit' })` preserved live progress but hid
 * stderr/stdout from the parent on abnormal exits. That made every
 * SIGABRT/status-134 child look like an output-less V8 heap OOM, even when the
 * terminal had already shown a native crash such as
 * `libc++abi: ... Napi::Error`. Piped streams plus an explicit tee keeps the UX
 * and gives `childProcessLikelyOom` the evidence it needs.
 */
const runRespawnedAnalyze = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RespawnExit> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exit: RespawnExit): void => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };

    const child = spawn(process.execPath, [...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });

    child.stdout?.on('data', (chunk) => {
      stdout = appendOutputTail(stdout, chunk);
      realStdoutWrite(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendOutputTail(stderr, chunk);
      realStderrWrite(chunk);
    });
    child.on('error', (err) => {
      finish({
        status: 1,
        signal: null,
        stdout,
        stderr,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (status, signal) => {
      finish({
        status,
        signal,
        stdout,
        stderr,
        message: `Command failed: ${process.execPath} ${args.join(' ')}`,
      });
    });
  });

/**
 * Heuristic for "child re-exec likely died from V8 OOM".
 *
 * Platform-independent detection is best-effort: V8/Node usually emit stable
 * heap-exhaustion phrases in stderr/message across Linux/macOS/Windows (for
 * example "JavaScript heap out of memory" or "Reached heap limit"). When the
 * child produced no output at all, we still treat status 134/SIGABRT as likely
 * heap OOM. If stderr/stdout contains a native crash diagnostic, the output
 * evidence wins and we do not print heap guidance.
 */
const childProcessLikelyOom = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: unknown;
    signal?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };

  const hasHeapOomSignature = (v: unknown): boolean => {
    const text = (
      Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : ''
    ).toLowerCase();
    if (!text) return false;
    return (
      text.includes('javascript heap out of memory') ||
      text.includes('reached heap limit') ||
      text.includes('allocation failed - javascript heap out of memory') ||
      text.includes('fatalprocessoutofmemory')
    );
  };

  const fields = [e.message, e.stderr, e.stdout];
  if (fields.some((v) => hasHeapOomSignature(v))) return true;

  const hasAnyChildOutput = [e.stderr, e.stdout].some(
    (v) => (Buffer.isBuffer(v) && v.length > 0) || (typeof v === 'string' && v.length > 0),
  );
  if (hasAnyChildOutput) return false;

  return e.status === 134 || e.signal === 'SIGABRT';
};

const childProcessLikelyNativeAbort = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const hasNativeAbortSignature = (v: unknown): boolean => {
    const text = (
      Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : ''
    ).toLowerCase();
    if (!text) return false;
    return (
      text.includes('napi::error') ||
      text.includes('libc++abi: terminating') ||
      text.includes('abort trap') ||
      text.includes('native stack') ||
      text.includes('native worker') ||
      text.includes('native binding')
    );
  };

  return [e.message, e.stderr, e.stdout].some((v) => hasNativeAbortSignature(v));
};

const forceHeapOOMForTestIfEnabled = (): void => {
  if (process.env.GITNEXUS_TEST_FORCE_HEAP_OOM !== '1') return;
  // Allocate JS strings (not Buffers) so pressure lands on V8 heap itself.
  // Buffers can allocate off-heap, which makes OOM triggering less reliable.
  const chunks: string[] = [];
  for (;;) chunks.push('x'.repeat(1024 * 1024));
};

// 64 MiB keeps auto-checkpoint enabled but triggers less frequently than
// Ladybug's stock ~16 MiB threshold, reducing rename/remove churn on large
// runs. Also matches the GitNexus default in `lbug-config.ts`.
//
// IMPORTANT: keep README examples (`README.md`, `gitnexus/README.md`) and
// the `DEFAULT_WAL_CHECKPOINT_THRESHOLD` constant in
// `gitnexus/src/core/lbug/lbug-config.ts` in sync with this value.
const RECOMMENDED_WAL_CHECKPOINT_THRESHOLD = 64 * 1024 * 1024;

/** Re-exec the process with the RAM-aware auto heap cap + larger semi-space/stack
 *  if we're currently below that. A user-supplied NODE_OPTIONS heap wins (no re-exec). */
async function ensureHeap(): Promise<boolean> {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  // --stack-size is a V8 flag not allowed in NODE_OPTIONS on Node 24+, so pass it
  // only as a direct CLI argument. --max-semi-space-size IS allowed in NODE_OPTIONS.
  const cliFlags = [HEAP_FLAG, SEMI_FLAG];
  if (!nodeOpts.includes('--stack-size')) cliFlags.push(STACK_FLAG);

  const childArgs = [...cliFlags, ...process.argv.slice(1)];
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG} ${SEMI_FLAG}`.trim(),
  };
  if (shouldBridgeRespawnProgressTty()) childEnv[RESPAWN_PROGRESS_ENV] = '1';
  const childExit = await runRespawnedAnalyze(childArgs, childEnv);
  if (childExit.status !== 0 || childExit.signal) {
    if (childProcessLikelyOom(childExit)) {
      cliError(
        `  Analysis likely ran out of memory (heap cap auto-sized to ${RESPAWN_HEAP_MB}MB ≈ 0.75x RAM).\n` +
          `  This repository's working set exceeds available RAM. Use a machine with more RAM,\n` +
          `  or override the cap (a cap above physical RAM causes swap-thrash — use with care):\n` +
          `    NODE_OPTIONS="--max-old-space-size=<MB>" gitnexus analyze [your-args]\n` +
          `    (Windows: set NODE_OPTIONS=--max-old-space-size=<MB> && gitnexus analyze [your-args])\n` +
          `  If this persists, it may be a native crash unrelated to heap size.\n`,
        { recoveryHint: 'heap-oom-respawn' },
      );
    } else if (childProcessLikelyNativeAbort(childExit)) {
      cliError(
        `  Analysis aborted in a native worker or native binding path.\n` +
          `  Try one of these recovery paths:\n` +
          `    npm uninstall -g gitnexus && npm install -g gitnexus@latest (rebuilds native bindings)\n` +
          `    Use Node 22 LTS if you are on a newer non-LTS runtime.\n`,
        { recoveryHint: 'native-worker-abort' },
      );
    }
    const status =
      typeof childExit.status === 'number' && childExit.status !== 0 ? childExit.status : 1;
    process.exitCode = status;
  }
  return true;
}

/**
 * GITNEXUS_* env vars that `analyzeCommand` writes for backward-compatible
 * downstream consumption. Snapshotted at function entry and restored in the
 * finally block so that programmatic callers (tests, long-running hosts)
 * don't see leaked state across invocations. `GITNEXUS_WORKER_POOL_SIZE` is
 * NOT in this list: that knob is threaded through `runFullAnalysis` options
 * (see `workerPoolSize` plumbing) so the CLI never has to mutate `process.env`
 * for it in the first place.
 */
const ANALYZE_CLI_ENV_KEYS = [
  'GITNEXUS_VERBOSE',
  'GITNEXUS_PROFILE_DEFERRED',
  'GITNEXUS_PROFILE_DEFERRED_SLOW_MS',
  'GITNEXUS_DEBUG_HEAP',
  'GITNEXUS_MAX_FILE_SIZE',
  'GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS',
  'GITNEXUS_WAL_CHECKPOINT_THRESHOLD',
  'GITNEXUS_WAL_MANUAL_CHECKPOINT',
  'GITNEXUS_EMBEDDING_THREADS',
  'GITNEXUS_EMBEDDING_BATCH_SIZE',
  'GITNEXUS_EMBEDDING_SUB_BATCH_SIZE',
  'GITNEXUS_EMBEDDING_DEVICE',
  'GITNEXUS_ANALYZE_PROGRESS_ACTIVE',
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

type AnalyzeEnvSnapshot = Record<(typeof ANALYZE_CLI_ENV_KEYS)[number], string | undefined>;

const snapshotAnalyzeEnv = (): AnalyzeEnvSnapshot => {
  const snap = {} as AnalyzeEnvSnapshot;
  for (const k of ANALYZE_CLI_ENV_KEYS) snap[k] = process.env[k];
  return snap;
};

const restoreAnalyzeEnv = (snap: AnalyzeEnvSnapshot): void => {
  for (const k of ANALYZE_CLI_ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

export interface AnalyzeOptions {
  force?: boolean;
  repairFts?: boolean;
  /**
   * Embedding generation toggle. Commander parses `--embeddings [limit]` as:
   *   - `undefined` when the flag is omitted
   *   - `true` when passed without an argument (use default 50K node cap)
   *   - a string when passed with an argument (`--embeddings 0` disables the
   *     cap, `--embeddings <n>` uses `<n>` as the cap)
   */
  embeddings?: boolean | string;
  /**
   * Explicitly drop existing embeddings on rebuild instead of preserving
   * them. Without this flag, a routine `analyze` keeps any embeddings
   * already present in the index even when `--embeddings` is omitted.
   */
  dropEmbeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /**
   * Build the control-flow-graph / PDG substrate (#2081 M1). Opt-in; off by
   * default. Threaded to both the worker (CFG build) and scope-resolution
   * (BasicBlock/CFG emit).
   */
  pdg?: boolean;
  /**
   * Stats inclusion in AGENTS.md and CLAUDE.md.
   *
   * Commander.js represents `--no-stats` as `stats: boolean` (default
   * `true`; `false` when the user passes `--no-stats`), NOT as
   * `noStats: boolean`. Reading the negated form would always be
   * `undefined` and the flag would silently no-op (#1477). Consumers
   * that want "did the user request --no-stats?" should compare with
   * `=== false` to distinguish the explicit-off case from the
   * default-on case.
   */
  stats?: boolean;
  /** Skip installing standard GitNexus skill files to .claude/skills/gitnexus/. */
  skipSkills?: boolean;
  /**
   * Default branch for the generated regression-compare example (#243). From
   * `--default-branch`; may also be supplied via `.gitnexusrc`. Resolved to a
   * concrete branch (CLI > `.gitnexusrc` > auto-detected origin/HEAD > "main")
   * before being threaded into the generated AGENTS.md / CLAUDE.md content.
   */
  defaultBranch?: string;
  /**
   * Index-branch selector (#2106). From `--branch`. Distinct from
   * `defaultBranch` (cosmetic base_ref): this routes the index to a per-branch
   * slot. NOT sourced from `.gitnexusrc` — the `.gitnexusrc` `branch` key is an
   * alias for `defaultBranch` and must not change index placement. Defaults to
   * the checked-out branch inside `runFullAnalysis` when omitted.
   */
  branch?: string;
  /** Pure index mode: skip all file injection (AGENTS.md, CLAUDE.md, skills). */
  indexOnly?: boolean;
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /**
   * Override the default basename-derived registry `name` with a
   * user-supplied alias (#829). Disambiguates repos whose paths share a
   * basename. Persisted — subsequent re-analyses of the same path without
   * `--name` preserve the alias.
   */
  name?: string;
  /**
   * Allow registration even when another path already uses the same
   * `--name` alias (#829). Intentionally a distinct flag from `--force`
   * because the user may want to coexist under the same name WITHOUT
   * paying the cost of a pipeline re-index. Maps to registerRepo's
   * `allowDuplicateName` option end-to-end.
   */
  allowDuplicateName?: boolean;
  /**
   * Override the walker's large-file skip threshold (#991). Value in KB;
   * clamped downstream to the tree-sitter 32 MB ceiling. Sets
   * `GITNEXUS_MAX_FILE_SIZE` for the rest of the pipeline.
   */
  maxFileSize?: string;
  /** Override worker sub-batch idle timeout in seconds. */
  workerTimeout?: string;
  /** Control LadybugDB WAL auto-checkpoint threshold during analyze. */
  walCheckpointThreshold?: string;
  /** Parse worker pool size (>=1); 0 is rejected (no sequential mode). */
  workers?: string;
  embeddingThreads?: string;
  embeddingBatchSize?: string;
  embeddingSubBatchSize?: string;
  embeddingDevice?: string;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers (#1589/#1852
   * residual). Supplied via `.gitnexusrc` `fetchWrappers: [...]`. Threaded into
   * the routes phase, where the cross-file consumer scan unions them with the
   * auto-detected `fetch()` wrappers so a custom/axios-based wrapper named
   * outside the built-in convention still produces `route_map` consumers.
   */
  fetchWrappers?: string[];
  /** OpenAI-compatible embeddings base URL (incl. /v1). Overrides GITNEXUS_EMBEDDING_URL. */
  embeddingBaseUrl?: string;
  /** Embedding model name. Overrides GITNEXUS_EMBEDDING_MODEL. */
  embeddingModel?: string;
  /** Bearer token for the embeddings endpoint. Overrides GITNEXUS_EMBEDDING_API_KEY. Never logged. */
  embeddingAuthToken?: string;
  /** Embedding vector dimensions (positive integer string). Overrides GITNEXUS_EMBEDDING_DIMS. */
  embeddingDims?: string;
}

/**
 * Whether the post-index skill step should run.
 *
 * The gated block does two things in sequence: (1) generates the community
 * skill files from `--skills`, and (2) re-runs `generateAIContextFiles` so
 * AGENTS.md/CLAUDE.md can reference the freshly written skills. Both are
 * suppressed together — `--index-only` drops the entire step, not just the
 * community-skill write. Name retained for the test contract; see call site
 * in `analyzeCommand` for the AGENTS.md/CLAUDE.md re-generation it also gates.
 *
 * Kept as a pure helper so the `--index-only --skills` contract is unit-tested
 * without booting the full analyze pipeline (#742 review).
 */
export const shouldGenerateCommunitySkillFiles = (
  options: Pick<AnalyzeOptions, 'skills' | 'indexOnly'> | undefined,
  pipelineResult: unknown,
): boolean => Boolean(options?.skills && pipelineResult && !options?.indexOnly);

export const analyzeCommand = async (inputPath?: string, options?: AnalyzeOptions) => {
  if (await ensureHeap()) return;
  forceHeapOOMForTestIfEnabled();

  // Install fatal handlers immediately after re-exec resolution so any
  // async error that escapes the try/catch below (#1169) surfaces with
  // a stack trace and a non-zero exit code instead of a silent exit 0.
  installFatalHandlers();

  // npm-11 npx-crash nudge (#1939). Runs here, after the heap re-exec guard,
  // so it fires once in the working process and never on the lazy-startup path
  // of other commands (e.g. `gitnexus mcp`).
  warnIfNpm11NpxRisk();

  // Snapshot the GITNEXUS_* env vars that the impl writes for downstream
  // consumption, so they don't leak across `analyzeCommand` invocations in
  // programmatic callers (tests, long-running hosts). `process.exit(0)` on
  // the success path bypasses `finally` — intentional: when the process is
  // exiting, restoration is moot. For early-return paths (validation
  // errors) and the alreadyUpToDate fast path the finally restores the
  // pre-call values.
  const envSnap = snapshotAnalyzeEnv();
  try {
    await analyzeCommandImpl(inputPath, options);
  } finally {
    restoreAnalyzeEnv(envSnap);
  }
  // If analyzeCommandImpl returned via a soft `process.exitCode = 1` error path
  // while LadybugDB native handles are still open, the event loop won't drain and
  // the process would HANG (#2264 review P1). The full analyze paths skip-close the
  // DB — handles are left open and reclaimed by process.exit — so a soft return
  // after a real analyze must force the exit. The success path never reaches here
  // (analyzeCommandImpl calls process.exit(0) itself); early-validation errors and
  // unit tests that mock runFullAnalysis never open the DB, so isLbugReady() is
  // false and the soft return is preserved.
  if (isLbugReady()) {
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 1);
  }
};

const analyzeCommandImpl = async (
  inputPath?: string,
  cliOptions?: AnalyzeOptions,
): Promise<void> => {
  console.log('\n  GitNexus Analyzer\n');

  // ── Resolve the target repo root ──────────────────────────────────
  // Resolved FIRST because `.gitnexusrc` is read from the repo root (not the
  // caller's cwd), and config can set defaults that the validation below
  // consumes. `--skip-git` is a CLI-only flag (never a config key), so the raw
  // CLI options are authoritative for repo-root resolution.
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else if (cliOptions?.skipGit) {
    // --skip-git: treat cwd as the index root, do not walk up to a parent git repo.
    repoPath = path.resolve(process.cwd());
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log(
        '  Not inside a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
      );
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  const repoHasGit = hasGitDir(repoPath);
  if (!repoHasGit && !cliOptions?.skipGit) {
    console.log(
      '  Not a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!repoHasGit) {
    console.log(
      '  Warning: no .git directory found — commit-tracking and incremental updates disabled.\n',
    );
  }

  // Validate an explicit `--default-branch` up front so its errors are
  // attributed to the flag (with a CLI-specific recovery hint) rather than to
  // `.gitnexusrc`, which the user may not even have (#1996 tri-review).
  if (cliOptions?.defaultBranch !== undefined) {
    try {
      validateBranchName(cliOptions.defaultBranch, '--default-branch');
    } catch (err) {
      cliError(`  ${err instanceof Error ? err.message : String(err)}\n`, {
        recoveryHint: 'default-branch-invalid',
      });
      process.exitCode = 1;
      return;
    }
  }

  // Validate the index-branch selector (#2106) the same way, so a malformed
  // `--branch` exits before any expensive analysis starts. Capture the TRIMMED
  // return so a whitespace-padded value (e.g. " feature" from shell completion)
  // normalizes before the checked-out-branch mismatch guard and slug — otherwise
  // it would false-reject on-branch or create a ghost index when detached.
  if (cliOptions?.branch !== undefined) {
    try {
      cliOptions.branch = validateBranchName(cliOptions.branch, '--branch');
    } catch (err) {
      cliError(`  ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // ── Load .gitnexusrc and merge: CLI flags override config (#243) ───
  // Parse/validate before the progress bar so a malformed config produces an
  // actionable error and exits before any expensive analysis starts.
  let options: AnalyzeOptions;
  let resolvedDefaultBranch: string;
  try {
    const fileConfig = loadAnalyzeConfig(repoPath);
    options = mergeAnalyzeOptions(cliOptions ?? {}, fileConfig);

    // Resolve the default branch threaded into generated context:
    //   CLI --default-branch > .gitnexusrc defaultBranch/branch
    //     > auto-detected origin/HEAD > "main".
    // Only shell out to git when no branch was configured AND the generated
    // context will actually use it, keeping the common path free of an extra
    // git call. Detection is best-effort and never blocks analyze.
    const cliBranch = cliOptions?.defaultBranch;
    const configBranch = fileConfig?.defaultBranch;
    const willGenerateContext = !options.indexOnly && !options.skipAgentsMd;
    let detectedBranch: string | null = null;
    if (
      cliBranch === undefined &&
      configBranch === undefined &&
      repoHasGit &&
      !cliOptions?.skipGit &&
      willGenerateContext
    ) {
      try {
        detectedBranch = getDefaultBranch(repoPath);
      } catch {
        detectedBranch = null;
      }
    }
    resolvedDefaultBranch = resolveDefaultBranch({ cliBranch, configBranch, detectedBranch });
  } catch (err) {
    const msg =
      err instanceof GitNexusRcError
        ? err.message
        : `Invalid .gitnexusrc: ${err instanceof Error ? err.message : String(err)}`;
    cliError(`  ${msg}\n`, { recoveryHint: 'gitnexusrc-invalid' });
    process.exitCode = 1;
    return;
  }

  if (options.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  if (options.maxFileSize) {
    process.env.GITNEXUS_MAX_FILE_SIZE = options.maxFileSize;
  }

  if (options.workerTimeout) {
    const workerTimeoutSeconds = Number(options.workerTimeout);
    if (!Number.isFinite(workerTimeoutSeconds) || workerTimeoutSeconds < 1) {
      cliError('  --worker-timeout must be at least 1 second.\n');
      process.exitCode = 1;
      return;
    }
    process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = String(
      Math.round(workerTimeoutSeconds * 1000),
    );
  }

  if (options.walCheckpointThreshold !== undefined) {
    const parsed = parseWalCheckpointThreshold(options.walCheckpointThreshold);
    if (parsed === undefined) {
      cliError('  --wal-checkpoint-threshold must be an integer >= -1.\n');
      process.exitCode = 1;
      return;
    }
    process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD = String(parsed);
  }

  // `--workers` is threaded through `runFullAnalysis` options → PipelineOptions
  // → createWorkerPool, intentionally bypassing the GITNEXUS_WORKER_POOL_SIZE
  // env channel so this CLI surface never mutates `process.env` for pool size.
  // Tests can therefore re-invoke analyzeCommand with different --workers
  // values back-to-back and observe the value they passed, not whatever the
  // previous call leaked.
  let workerPoolSize: number | undefined;
  if (options.workers !== undefined) {
    const parsedWorkers = Number(options.workers);
    if (!Number.isInteger(parsedWorkers) || parsedWorkers < 1) {
      cliError(
        '  --workers must be a positive integer (>= 1). ' +
          'GitNexus parses through a worker pool only — there is no sequential ' +
          'mode, so 0 is not allowed. Omit --workers for an auto-sized pool.\n',
      );
      process.exitCode = 1;
      return;
    }
    workerPoolSize = parsedWorkers;
  }

  // Parse `--embeddings [limit]`: `true` → default cap, string → numeric cap
  // (0 disables the cap entirely). Validated up here so failures match the
  // sibling-validation pattern (exit before bar.start() — otherwise
  // process.exit() leaves the progress bar's hidden cursor uncleared).
  let embeddingsNodeLimit: number | undefined;
  if (typeof options.embeddings === 'string') {
    const parsed = Number(options.embeddings);
    if (!Number.isInteger(parsed) || parsed < 0) {
      cliError(
        `  --embeddings expects a non-negative integer (got "${options.embeddings}"). ` +
          `Pass 0 to disable the safety cap, or omit the value to keep the default.\n`,
      );
      process.exitCode = 1;
      return;
    }
    embeddingsNodeLimit = parsed;
  }
  const embeddingsEnabled = !!options.embeddings;

  const setPositiveEnv = (
    optionName: string,
    envName: string,
    value: string | undefined,
  ): boolean => {
    if (value === undefined) return true;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      cliError(`  ${optionName} must be a positive integer.\n`);
      process.exitCode = 1;
      return false;
    }
    process.env[envName] = String(parsed);
    return true;
  };

  if (
    !setPositiveEnv(
      '--embedding-threads',
      'GITNEXUS_EMBEDDING_THREADS',
      options.embeddingThreads,
    ) ||
    !setPositiveEnv(
      '--embedding-batch-size',
      'GITNEXUS_EMBEDDING_BATCH_SIZE',
      options.embeddingBatchSize,
    ) ||
    !setPositiveEnv(
      '--embedding-sub-batch-size',
      'GITNEXUS_EMBEDDING_SUB_BATCH_SIZE',
      options.embeddingSubBatchSize,
    )
  ) {
    return;
  }

  if (options.embeddingDevice) {
    const allowed = new Set(['auto', 'cpu', 'dml', 'cuda', 'wasm']);
    if (!allowed.has(options.embeddingDevice)) {
      cliError('  --embedding-device must be one of: auto, cpu, dml, cuda, wasm.\n');
      process.exitCode = 1;
      return;
    }
    process.env.GITNEXUS_EMBEDDING_DEVICE = options.embeddingDevice;
  }

  // --- Custom HTTP embedding endpoint flags (override GITNEXUS_EMBEDDING_* env vars) ---
  const anyHttpEmbedFlag =
    options.embeddingBaseUrl !== undefined ||
    options.embeddingModel !== undefined ||
    options.embeddingAuthToken !== undefined ||
    options.embeddingDims !== undefined;

  if (options.embeddingBaseUrl !== undefined) {
    const url = options.embeddingBaseUrl.trim();
    if (url.length === 0) {
      cliError('  --embedding-base-url must not be empty.\n');
      process.exitCode = 1;
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      cliError(`  --embedding-base-url is not a valid URL: "${url}".\n`);
      process.exitCode = 1;
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      cliError('  --embedding-base-url must use http:// or https://.\n');
      process.exitCode = 1;
      return;
    }
    // http-client strips trailing slashes; store as given (trimmed).
    process.env.GITNEXUS_EMBEDDING_URL = url;
  }

  if (options.embeddingModel !== undefined) {
    const model = options.embeddingModel.trim();
    if (model.length === 0) {
      cliError('  --embedding-model must not be empty.\n');
      process.exitCode = 1;
      return;
    }
    process.env.GITNEXUS_EMBEDDING_MODEL = model;
  }

  if (options.embeddingAuthToken !== undefined) {
    const token = options.embeddingAuthToken.trim();
    if (token.length === 0) {
      cliError('  --embedding-auth-token must not be empty.\n');
      process.exitCode = 1;
      return;
    }
    // Never log the token value.
    process.env.GITNEXUS_EMBEDDING_API_KEY = token;
  }

  // Validate + normalize dims through the same shared helper the preAction
  // hook uses, so the CLI path, this direct/programmatic-call path, schema.ts
  // (parseInt) and http-client (/^\d+$/) all agree on one canonical value.
  if (options.embeddingDims !== undefined) {
    const dims = normalizeEmbeddingDims(options.embeddingDims);
    if (dims === null) {
      cliError(`  ${EMBEDDING_DIMS_ERROR}\n`);
      process.exitCode = 1;
      return;
    }
    process.env.GITNEXUS_EMBEDDING_DIMS = dims;
  }

  // Custom-endpoint UX, emitting at most ONE message that reflects THIS run's
  // intent (not ambient env). Order matters — the first matching branch wins:
  //   1. flags given but --embeddings absent: the endpoint won't be used, so
  //      say only that (no contradictory "Using…" line).
  //   2. embeddings enabled + a complete endpoint (flags or env): confirm it,
  //      masking the URL via safeUrl() since a base URL may carry credentials
  //      in userinfo (http://user:pass@host) or a query token (?api_key=…)
  //      that must not land in stdout/CI logs. The auth token is never printed.
  //   3. embeddings enabled but only one of URL/MODEL supplied via flags:
  //      http-client.isHttpMode() needs BOTH, so warn about the fallback.
  // Gating on embeddingsEnabled also stops the old behaviour of printing
  // "Using custom embedding endpoint" on every analyze run whenever the env
  // vars happened to be set.
  if (anyHttpEmbedFlag && !embeddingsEnabled) {
    console.log(
      '  Note: --embedding-* flags only apply when --embeddings is also passed; ' +
        'no embeddings will be generated this run.\n',
    );
  } else if (
    embeddingsEnabled &&
    process.env.GITNEXUS_EMBEDDING_URL &&
    process.env.GITNEXUS_EMBEDDING_MODEL
  ) {
    console.log(
      `  Using custom embedding endpoint: ${safeUrl(process.env.GITNEXUS_EMBEDDING_URL)} ` +
        `(model: ${process.env.GITNEXUS_EMBEDDING_MODEL})\n`,
    );
  } else if (
    embeddingsEnabled &&
    anyHttpEmbedFlag &&
    (process.env.GITNEXUS_EMBEDDING_URL || process.env.GITNEXUS_EMBEDDING_MODEL)
  ) {
    console.log(
      '  Note: custom HTTP embeddings require BOTH --embedding-base-url and --embedding-model ' +
        '(or the matching env vars). Falling back to local ONNX embeddings.\n',
    );
  }

  if (options.repairFts && options.force) {
    cliError(
      '  Cannot combine `--repair-fts` with `--force`. ' +
        'Use `--repair-fts` for fast FTS-only repair, or `--force` for a full rebuild.\n',
    );
    process.exitCode = 1;
    return;
  }

  // `--index-only` is the stronger contract — it suppresses every form of file
  // injection, including community skill writes that `--skills` would normally
  // produce. Surface the override explicitly so users don't wonder why a
  // pipeline re-index ran but no skill files appeared. The pipeline still
  // re-runs (see `force: options.force || options.skills` below); the warning
  // is purely about the dropped post-index write step.
  if (options.indexOnly && options.skills) {
    console.log(
      '  Note: --index-only overrides --skills; community skill files will not be written.\n',
    );
  }

  // If the target repo contains files an optional grammar would parse but
  // that grammar's native binding is absent (or disabled via
  // GITNEXUS_SKIP_OPTIONAL_GRAMMARS), warn before analysis so users learn why
  // those files end up unparsed instead of silently getting a degraded index.
  // The extension set is derived from OPTIONAL_GRAMMARS so it can't drift.
  try {
    const optionalGlobs = getOptionalGrammarExtensions().map((e) => `**/*${e}`);
    const matches = await glob(optionalGlobs, {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      dot: false,
      nodir: true,
      absolute: false,
    });
    if (matches.length > 0) {
      const present = new Set<string>();
      for (const m of matches) {
        const ext = path.extname(m).toLowerCase();
        if (ext) present.add(ext);
      }
      warnMissingOptionalGrammars({ context: 'analyze', relevantExtensions: present });
    }
  } catch {
    // Best-effort warning \u2014 never block analyze on the precheck.
  }

  // KuzuDB migration cleanup is handled by runFullAnalysis internally.
  // Note: --skills is handled after runFullAnalysis using the returned pipelineResult.

  if (process.env.GITNEXUS_NO_GITIGNORE) {
    console.log(
      '  GITNEXUS_NO_GITIGNORE is set — skipping .gitignore (still reading .gitnexusignore)\n',
    );
  }

  const maxFileSizeBanner = getMaxFileSizeBannerMessage();
  if (maxFileSizeBanner) {
    console.log(`${maxFileSizeBanner}\n`);
  }

  // ── CLI progress bar setup ─────────────────────────────────────────
  const barOptions: cliProgress.Options & { terminal?: CliProgressTerminal } = {
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  };
  if (process.env[RESPAWN_PROGRESS_ENV] === '1' && process.stderr.isTTY !== true) {
    // Heap respawn pipes stderr so the parent can classify native/OOM crashes.
    // The parent was a real TTY when it opted into this env var, so forward
    // ANSI cursor controls through the pipe instead of cli-progress' non-TTY
    // newline mode. That keeps one-line redraw UX while retaining stderr tail
    // capture for diagnostics.
    barOptions.terminal = createAnsiPipeTerminal(process.stderr);
  }
  const bar = new cliProgress.SingleBar(barOptions, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling. Pino's default destination is `sync: false`
  // (buffered) — flush before exit so in-flight records reach stderr.
  // See `gitnexus/src/core/logger.ts:flushLoggerSync`.
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    // Bounded CHECKPOINT-then-exit (#2264 review P3): skip the native close (the
    // LadybugDB destructor can double-free after --pdg writes), but don't hang
    // behind a long --pdg COPY holding the connection lock — bound it so a single
    // Ctrl-C stays responsive; the WAL replays on the next analyze. A second
    // Ctrl-C (`if (aborted) process.exit(1)` above) remains the escape hatch.
    void boundedCheckpointBeforeExit({
      exitCode: 130,
      beforeExit: async () => {
        const { flushLoggerSync } = await import('../core/logger.js');
        flushLoggerSync();
      },
    });
  };
  process.on('SIGINT', sigintHandler);

  // Route console output through bar.log() to prevent progress bar corruption.
  // This is a deliberate UI pattern (not a logging concern): analyze runs a
  // long-lived progress bar on stdout; any concurrent console.* write would
  // overwrite the bar mid-render. We capture originals, swap to barLog for
  // the lifetime of the run, and restore on completion/error/SIGINT.
  const origLog = console.log.bind(console);
  // eslint-disable-next-line no-console -- intentional console-routing for progress bar UX
  const origWarn = console.warn.bind(console);
  // eslint-disable-next-line no-console -- intentional console-routing for progress bar UX
  const origError = console.error.bind(console);
  let barCurrentValue = 0;
  const barLog = (...args: unknown[]) => {
    process.stdout.write('\x1b[2K\r');
    origLog(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    bar.update(barCurrentValue);
  };
  console.log = barLog;
  // eslint-disable-next-line no-console -- intentional console-routing for progress bar UX
  console.warn = barLog;
  // eslint-disable-next-line no-console -- intentional console-routing for progress bar UX
  console.error = barLog;
  process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE = '1';

  // Track elapsed time per phase
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  const updateBar = (value: number, phaseLabel: string) => {
    barCurrentValue = value;
    if (phaseLabel !== lastPhaseLabel) {
      lastPhaseLabel = phaseLabel;
      phaseStart = Date.now();
    }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${formatElapsed(elapsed)})` : phaseLabel;
    bar.update(value, { phase: display });
  };

  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${formatElapsed(elapsed)})` });
    }
  }, 1000);

  const t0 = Date.now();

  // ── Run shared analysis orchestrator ───────────────────────────────
  try {
    const skipAll = options.indexOnly;
    const skipAgentsMd = skipAll || options.skipAgentsMd;
    const skipSkills = skipAll || options.skipSkills;
    const result = await runFullAnalysis(
      repoPath,
      {
        // Pipeline re-index — OR'd with --skills because skill generation
        // needs a fresh pipelineResult. Has no bearing on the registry
        // collision guard (see allowDuplicateName below).
        force: options.force || options.skills,
        repairFts: options.repairFts,
        embeddings: embeddingsEnabled,
        embeddingsNodeLimit,
        dropEmbeddings: options.dropEmbeddings,
        verbose: options.verbose,
        skipGit: options.skipGit,
        skipAgentsMd,
        skipSkills,
        // CFG/PDG substrate opt-in (#2081 M1) — threaded to both sinks downstream.
        pdg: options.pdg === true,
        // Resolved default branch (CLI > .gitnexusrc > auto-detect > "main")
        // threaded into the generated regression-compare example (#243).
        defaultBranch: resolvedDefaultBranch,
        // Index-branch selector (#2106). Read straight from the CLI flag (not
        // the .gitnexusrc-merged options) so the cosmetic defaultBranch config
        // can never change index placement. Undefined → auto-detect in pipeline.
        branch: cliOptions?.branch,
        // commander.js `.option('--no-stats', …)` registers the flag as
        // `options.stats` (boolean, default true; `false` when the user
        // passed --no-stats). Reading `options.noStats` here returns
        // undefined every time, so the flag was a no-op on the markdown
        // rewrite path before this fix. See #1477.
        noStats: options.stats === false,
        registryName: options.name,
        // Registry-collision bypass — its own CLI flag, intentionally NOT
        // overloading --force. A user who hits the collision guard should
        // be able to accept the duplicate name without also paying the
        // cost of a full pipeline re-index. See #829 review round 2.
        allowDuplicateName: options.allowDuplicateName,
        // Worker pool size threaded from --workers, replacing the previous
        // GITNEXUS_WORKER_POOL_SIZE env mutation. `undefined` defers to the
        // env / auto-formula fallback inside the pipeline.
        workerPoolSize,
        // Extra fetch-wrapper names from `.gitnexusrc` (#1589/#1852 residual);
        // forwarded to the routes phase consumer scan.
        fetchWrappers: options.fetchWrappers,
        // The CLI always process.exit()s after this returns (success path at the
        // end of analyzeCommandImpl, error/interrupt paths via process.exit too),
        // so the finalize close skips the native conn/db close — it can double-free
        // in LadybugDB's ClientContext destructor after --pdg writes (#2264). The
        // CHECKPOINT keeps the index durable; process exit reclaims the handles.
        skipNativeCloseOnExit: true,
      },
      {
        onProgress: (_phase, percent, message) => {
          updateBar(percent, message);
        },
        onLog: barLog,
      },
    );

    if (result.alreadyUpToDate) {
      // Even the fast path must prove the repo is discoverable. A prior
      // run can write meta.json and then fail before registerRepo(); in
      // that half-finalized state, runFullAnalysis returns alreadyUpToDate
      // on the next invocation unless we check the registry here too.
      await assertAnalysisFinalized(repoPath);
      // The fast path skips context regeneration, but a changed `.gitnexusrc`
      // defaultBranch / `--default-branch` must still take effect. Surgically
      // refresh just the `base_ref` line in AGENTS.md/CLAUDE.md in place,
      // preserving the rest of the block (incl. --skills community rows). No-op
      // when the value already matches, so a routine up-to-date run is silent
      // (#1996 tri-review P2).
      // Only refresh the repo-root AGENTS.md/CLAUDE.md base_ref for the
      // PRIMARY/flat index (#2106 R2). A non-primary branch's up-to-date
      // analyze must not churn the committed AGENTS.md — this mirrors the
      // in-pipeline `if (!placement.branch)` gate around generateAIContextFiles.
      let baseRefRefreshed: string[] = [];
      if (result.isPrimaryBranch !== false) {
        try {
          const { refreshBaseRefLine } = await import('./ai-context.js');
          baseRefRefreshed = (
            await refreshBaseRefLine(repoPath, resolvedDefaultBranch, { skipAgentsMd })
          ).files;
        } catch {
          /* best-effort — never fail the fast path over a context refresh */
        }
      }
      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
      console.warn = origWarn;
      // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
      console.error = origError;
      bar.stop();
      console.log('  Already up to date\n');
      if (baseRefRefreshed.length > 0) {
        console.log(
          `  Updated base_ref to "${resolvedDefaultBranch}" in ${baseRefRefreshed.join(', ')}\n`,
        );
      }
      // Safe to return without process.exit(0) — the early-return path in
      // runFullAnalysis never opens LadybugDB, so no native handles prevent exit.
      return;
    }

    if (result.ftsRepairedOnly) {
      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
      console.warn = origWarn;
      // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
      console.error = origError;
      bar.stop();
      console.log('  FTS indexes repaired successfully\n');
      return;
    }

    // Post-finalize invariant (#1169): runFullAnalysis nominally writes
    // meta.json and registers the repo, but on Windows it has been
    // observed to return successfully with neither artifact present
    // (banner-only output, exit 0). Verify both before declaring
    // success so the silent-finalize state surfaces with a non-zero
    // exit code and an actionable error instead of being mistaken for
    // a healthy index.
    await assertAnalysisFinalized(repoPath);

    // Skill generation (CLI-only, uses pipeline result from analysis).
    // Gated so `--index-only --skills` skips community skill writes too
    // (`shouldGenerateCommunitySkillFiles` — see unit test).
    if (shouldGenerateCommunitySkillFiles(options, result.pipelineResult)) {
      updateBar(99, 'Generating skill files...');
      try {
        const { generateSkillFiles } = await import('./skill-gen.js');
        const { generateAIContextFiles } = await import('./ai-context.js');
        const skillResult = await generateSkillFiles(
          repoPath,
          result.repoName,
          result.pipelineResult,
        );
        if (skillResult.skills.length > 0) {
          barLog(`  Generated ${skillResult.skills.length} skill files`);
          // Re-generate AI context files now that we have skill info
          const s = result.stats;
          const communityResult = result.pipelineResult?.communityResult;
          let aggregatedClusterCount = 0;
          if (communityResult?.communities) {
            const groups = new Map<string, number>();
            for (const c of communityResult.communities) {
              const label = c.heuristicLabel || c.label || 'Unknown';
              groups.set(label, (groups.get(label) || 0) + c.symbolCount);
            }
            aggregatedClusterCount = Array.from(groups.values()).filter(
              (count: number) => count >= 5,
            ).length;
          }
          const { storagePath: sp } = getStoragePaths(repoPath);
          await generateAIContextFiles(
            repoPath,
            sp,
            result.repoName,
            {
              files: s.files ?? 0,
              nodes: s.nodes ?? 0,
              edges: s.edges ?? 0,
              communities: s.communities,
              clusters: aggregatedClusterCount,
              processes: s.processes,
            },
            skillResult.skills,
            {
              skipAgentsMd,
              skipSkills,
              // Same resolved branch as the main run (#243) so the --skills
              // re-generation of AGENTS.md/CLAUDE.md does not revert base_ref
              // to "main".
              defaultBranch: resolvedDefaultBranch,
              // Mirror runFullAnalysis `noStats` bridge (#1477) — same expression;
              // exercised on the `--skills` path by analyze-no-stats-bridge.test.ts.
              noStats: options.stats === false,
              hasPdg: options.pdg === true,
            },
          );
        }
      } catch {
        /* best-effort */
      }
    }

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);

    console.log = origLog;
    // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
    console.warn = origWarn;
    // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
    console.error = origError;

    bar.update(100, { phase: 'Done' });
    bar.stop();

    // ── Summary ────────────────────────────────────────────────────
    const s = result.stats;
    console.log(`\n  Repository indexed successfully (${totalTime}s)\n`);
    console.log(
      `  ${(s.nodes ?? 0).toLocaleString()} nodes | ${(s.edges ?? 0).toLocaleString()} edges | ${s.communities ?? 0} clusters | ${s.processes ?? 0} flows`,
    );
    console.log(`  ${repoPath}`);

    // Persistent (non-scrolling) warning when FTS indexing was skipped — the
    // progress-bar log() that fired mid-run has already scrolled away, so the
    // degraded-search state must also appear in the final summary (#1161).
    if (result.ftsSkipped) {
      console.log(
        `\n  Warning: full-text/BM25 search is disabled — the LadybugDB FTS extension was unavailable.\n` +
          `  Install it once with network access (GITNEXUS_LBUG_EXTENSION_INSTALL=auto) then rerun, or\n` +
          `  run \`gitnexus analyze --repair-fts\` when connected. Run \`gitnexus doctor\` for details.`,
      );
    }

    try {
      await fs.access(getGlobalRegistryPath());
    } catch {
      console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
    }

    console.log('');
  } catch (err: unknown) {
    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);
    console.log = origLog;
    // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
    console.warn = origWarn;
    // eslint-disable-next-line no-console -- restoring after intentional progress-bar routing
    console.error = origError;
    bar.stop();

    const msg = err instanceof Error ? err.message : String(err);

    // Registry name-collision from --name (#829) — surface as an
    // actionable error rather than a generic stack-trace.
    if (err instanceof RegistryNameCollisionError) {
      cliError(
        `\n  Registry name collision:\n` +
          `    "${err.registryName}" is already used by "${err.existingPath}".\n\n` +
          `  Options:\n` +
          `    • Pick a different alias:  gitnexus analyze --name <alias>\n` +
          `    • Allow the duplicate:     gitnexus analyze --allow-duplicate-name  (leaves "-r ${err.registryName}" ambiguous)\n`,
        { registryName: err.registryName, existingPath: err.existingPath },
      );
      process.exitCode = 1;
      return;
    }

    // Finalize invariant failure (#1169) — keep the rich actionable
    // message intact and write through realStderrWrite so it can't be
    // erased by a leftover bar refresh on slow terminals.
    if (err instanceof AnalysisNotFinalizedError) {
      writeFatalToStderr('Analysis did not finalize', err);
      realStderrWrite(
        `\n  Diagnostic checklist:\n` +
          `    1. Re-run "gitnexus analyze" - transient native errors often clear on retry.\n` +
          `    2. Inspect ${err.storagePath} - a leftover lbug.wal indicates an aborted write.\n` +
          `    3. If the failure persists, run with NODE_OPTIONS="--max-old-space-size=8192 --trace-exit"\n` +
          `       and attach the trace to the GitNexus issue tracker.\n\n`,
      );
      process.exitCode = 1;
      return;
    }

    // WAL corruption — the index file is unreadable. Give a clear recovery
    // path without a confusing stack trace (the native error message alone
    // is enough signal).
    if (isWalCorruptionError(err) || msg.includes('LadybugDB WAL corruption')) {
      cliError(
        `  The GitNexus index has a corrupted WAL file.\n` +
          `  This usually happens when a previous analysis was interrupted mid-write.\n` +
          `  ${WAL_RECOVERY_SUGGESTION}\n`,
        { recoveryHint: 'wal-corruption' },
      );
      process.exitCode = 1;
      return;
    }

    if (isLbugCheckpointIoError(err)) {
      cliError(
        `  LadybugDB failed while rotating/removing WAL checkpoint files.\n` +
          `  This can happen when auto-checkpoint runs at the default threshold (~16MB).\n` +
          `  Retry with a larger checkpoint threshold to reduce checkpoint frequency:\n` +
          `    gitnexus analyze --wal-checkpoint-threshold ${RECOMMENDED_WAL_CHECKPOINT_THRESHOLD}\n` +
          `    (or set GITNEXUS_WAL_CHECKPOINT_THRESHOLD=${RECOMMENDED_WAL_CHECKPOINT_THRESHOLD})\n` +
          `    (Try 33554432 = 32 MiB on small-disk / CI runners.)\n`,
        { recoveryHint: 'wal-checkpoint-threshold' },
      );
      process.exitCode = 1;
      return;
    }

    // Local embedding runtime unsupported on this platform (macOS Intel ships no
    // darwin/x64 ONNX native binding, #1515). The guard threw before importing
    // transformers.js, so this is a clean, actionable GitNexus message. Checked
    // before the network-heuristic isHfDownloadFailure branch below (and before
    // the generic module-not-found "installation may be corrupt" hint) so the
    // explicit platform message always takes priority.
    if (isLocalEmbeddingRuntimeBlockerMessage(msg)) {
      cliError(`  ${msg.replace(/\n/g, '\n  ')}\n`, {
        recoveryHint: 'local-embedding-unsupported',
      });
      process.exitCode = 1;
      return;
    }

    // HF download failure — show clean guidance without the raw stack trace.
    // Checked before writeFatalToStderr so the user sees one focused message
    // rather than a stack-trace dump followed by a second remediation block.
    if (isHfDownloadFailure(msg) || msg.includes('Failed to download embedding model')) {
      cliError(
        `  The embedding model could not be downloaded.\n` +
          `  huggingface.co may be unreachable from your network\n` +
          `  (e.g. behind a corporate proxy or a regional firewall).\n` +
          `  Suggestions:\n` +
          `    1. Set HF_ENDPOINT to a mirror and retry:\n` +
          `         HF_ENDPOINT=https://hf-mirror.com npx gitnexus analyze --embeddings\n` +
          `         (Windows: set HF_ENDPOINT=https://hf-mirror.com && npx gitnexus analyze --embeddings)\n` +
          `    2. Check your proxy / VPN settings.\n` +
          `    3. Once downloaded the model is cached — future runs work offline.\n`,
        { recoveryHint: 'hf-endpoint-unreachable' },
      );
      process.exitCode = 1;
      return;
    }

    // Bypass the redirected console.error and write the full stack to
    // the real stderr captured at module load. The redirected
    // console.error wraps every line with `\\x1b[2K\\r` (ANSI clear-line)
    // and forces a bar.update() afterwards, which on some Windows
    // terminals visually erases the failure message — the canonical
    // shape of the silent-exit symptom in #1169.
    writeFatalToStderr('Analysis failed', err);

    // Provide helpful guidance for known failure modes
    if (
      msg.includes('Maximum call stack size exceeded') ||
      msg.includes('call stack') ||
      msg.includes('Map maximum size') ||
      msg.includes('Invalid array length') ||
      msg.includes('Invalid string length') ||
      msg.includes('allocation failed') ||
      msg.includes('heap out of memory') ||
      msg.includes('JavaScript heap')
    ) {
      cliError(
        `  This error typically occurs on very large repositories.\n` +
          `  Suggestions:\n` +
          `    1. Add large vendored/generated directories to .gitnexusignore\n` +
          `    2. Increase Node.js heap: NODE_OPTIONS="--max-old-space-size=16384"\n` +
          `    3. Increase stack size: NODE_OPTIONS="--stack-size=4096"\n`,
        { recoveryHint: 'large-repo' },
      );
    } else if (msg.includes('ERESOLVE') || msg.includes('Could not resolve dependency')) {
      // Note: the original arborist "Cannot destructure property 'package' of
      // 'node.target'" crash happens inside npm *before* gitnexus code runs,
      // so it can't be caught here.  This branch handles dependency-resolution
      // errors that surface at runtime (e.g. dynamic require failures).
      cliError(
        `  This looks like an npm dependency resolution issue.\n` +
          `  Suggestions:\n` +
          `    1. Clear the npm cache:    npm cache clean --force\n` +
          `    2. Update npm:             npm install -g npm@latest\n` +
          `    3. Reinstall gitnexus:     npm install -g gitnexus@latest\n` +
          `    4. Or try npx directly:    npx gitnexus@latest analyze\n`,
        { recoveryHint: 'npm-resolution' },
      );
    } else if (
      msg.includes('MODULE_NOT_FOUND') ||
      msg.includes('Cannot find module') ||
      msg.includes('ERR_MODULE_NOT_FOUND')
    ) {
      cliError(
        `  A required module could not be loaded. The installation may be corrupt.\n` +
          `  Suggestions:\n` +
          `    1. Reinstall:   npm install -g gitnexus@latest\n` +
          `    2. Clear cache: npm cache clean --force && npx gitnexus@latest analyze\n`,
        { recoveryHint: 'module-not-found' },
      );
    }

    process.exitCode = 1;
    return;
  }

  // LadybugDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that segfault on some
  // platforms (#38, #40). Force-exit to ensure clean termination.
  process.exit(0);
};
