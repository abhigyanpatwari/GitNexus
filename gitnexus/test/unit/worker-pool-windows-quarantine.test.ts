/**
 * U9 (M5 from PR #1693 review) — Quarantine path round-trip pinning.
 *
 * `worker-pool.ts` quarantines paths via a `Set<string>` keyed by exact
 * string equality with no normalization. That's the right call as long
 * as callers + workers agree on a single separator style for the same
 * file — but it's also a sharp edge the existing suite never asserted,
 * which lets a future refactor that "helpfully" normalizes one side of
 * the pipeline silently break quarantine filtering on Windows.
 *
 * This test pins the current contract from both directions:
 *   1. A path the caller dispatches with backslashes round-trips through
 *      starting-file → death → quarantine → next-dispatch filter.
 *   2. The set is NOT separator-normalized — quarantining `src\bad.ts`
 *      does not filter `src/bad.ts`, and vice versa. Whoever changes
 *      that contract has to update this test alongside.
 *
 * Runs on every platform (no `runIf` guard) — the path strings are
 * test-injected, so the test exercises the same code path regardless
 * of the host's actual `path.sep`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
const __sharedDecoder = new TextDecoder('utf-8');
function decodeDispatchedMessage(rawMsg: unknown): unknown {
  if (
    rawMsg !== null &&
    typeof rawMsg === 'object' &&
    (rawMsg as { type?: unknown }).type === 'sub-batch' &&
    Array.isArray((rawMsg as { files?: unknown }).files)
  ) {
    const files = (rawMsg as { files: Array<{ path: string; content: Uint8Array | string }> })
      .files;
    return {
      type: 'sub-batch',
      files: files.map((f) => ({
        path: f.path,
        content: typeof f.content === 'string' ? f.content : __sharedDecoder.decode(f.content),
      })),
    };
  }
  return rawMsg;
}

/**
 * Minimal FakeWorker for this test: emit `starting-file` for the script's
 * configured path, then either exit (death → quarantine the in-flight
 * file) or respond with a parse-ok result (proves filtered dispatch
 * succeeds). One action per `postMessage('sub-batch')`.
 */
type FakeAction =
  | { kind: 'crash-after-starting'; startingPath: string; code: number }
  | { kind: 'parse-ok'; files: { path: string }[] };

let nextActions: FakeAction[] = [];

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    // online + ready handshake — pool's waitForWorkerReady listens for both.
    queueMicrotask(() => {
      this.emit('online');
      this.emit('message', { type: 'ready' });
    });
  }
  postMessage(rawMsg: unknown): void {
    // U17: decode Buffer-encoded dispatches; pool is now strict-encoded.
    const msg = decodeDispatchedMessage(rawMsg);
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string };
    if (m.type !== 'sub-batch') return;
    const action = nextActions.shift();
    if (!action) return;
    queueMicrotask(() => this.run(action));
  }
  private async run(action: FakeAction): Promise<void> {
    if (action.kind === 'crash-after-starting') {
      this.emit('message', { type: 'starting-file', path: action.startingPath });
      this.emit('exit', action.code);
      return;
    }
    if (action.kind === 'parse-ok') {
      for (const f of action.files) {
        this.emit('message', { type: 'starting-file', path: f.path });
      }
      this.emit('message', { type: 'progress', filesProcessed: action.files.length });
      this.emit('message', { type: 'sub-batch-done' });
      await Promise.resolve();
      this.emit('message', {
        type: 'result',
        data: { fileCount: action.files.length, paths: action.files.map((f) => f.path) },
      });
    }
  }
  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  nextActions = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-quarantine-paths-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('worker pool quarantine path round-trip (U9 M5)', () => {
  it('quarantines a backslash-separator path verbatim and filters it on the next dispatch', async () => {
    const bs = 'src\\bad.ts';
    const good = 'src\\good.ts';
    // Script: first dispatch crashes on bs (death → bs goes to quarantine).
    // Pool respawns the slot; the requeued remainder will not contain bs
    // (the pool filters it out before re-dispatching), so the replacement
    // worker only sees `good`.
    nextActions.push({ kind: 'crash-after-starting', startingPath: bs, code: 134 });
    nextActions.push({ kind: 'parse-ok', files: [{ path: good }] });

    const pool = createWorkerPool(workerUrl, 1, {
      // Keep retry budgets generous; the test only needs ONE death to
      // observe the quarantine entry.
      maxRespawnsPerSlot: 5,
      consecutiveFailureThreshold: 10,
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: bs, content: '' },
        { path: good, content: '' },
      ]);
      // The crash on `bs` quarantines it; verify the exact string is in
      // the snapshot (no normalization, no separator munging).
      const snap = pool.getQuarantinedPaths?.() ?? [];
      expect(snap.includes(bs)).toBe(true);

      // Subsequent dispatch attempting `bs` again must be silently
      // filtered before any worker sees it. Easiest way to assert this:
      // dispatch only `bs` and confirm there are no results (filtered to
      // empty before any worker action runs, so no FakeAction is consumed).
      const beforeActions = nextActions.length;
      const results = await pool.dispatch<{ path: string; content: string }, unknown>([
        { path: bs, content: '' },
      ]);
      expect(results.length).toBe(0);
      // No action was popped from nextActions because the filter
      // emptied the dispatch list before any worker postMessage.
      expect(nextActions.length).toBe(beforeActions);
    } finally {
      await pool.terminate();
    }
  });

  it('does NOT normalize separators — a path quarantined with backslashes does not match the forward-slash variant', async () => {
    const bs = 'src\\poison.ts';
    const fs_ = 'src/poison.ts';
    nextActions.push({ kind: 'crash-after-starting', startingPath: bs, code: 134 });
    // The replacement worker will be asked to parse fs_ (which the pool
    // sees as a DIFFERENT path because there's no normalization). Script
    // a successful parse for it.
    nextActions.push({ kind: 'parse-ok', files: [{ path: fs_ }] });

    const pool = createWorkerPool(workerUrl, 1, {
      maxRespawnsPerSlot: 5,
      consecutiveFailureThreshold: 10,
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      // First dispatch: backslash path crashes the worker → quarantined as `bs`.
      // Second item: forward-slash variant should NOT be filtered because
      // the quarantine is string-equality. The replacement worker handles
      // it via the parse-ok action above.
      const results = await pool.dispatch<{ path: string; content: string }, unknown>([
        { path: bs, content: '' },
        { path: fs_, content: '' },
      ]);
      // The forward-slash dispatch must NOT have been filtered: at least
      // one result came back, AND its path is the forward-slash variant
      // (which our parse-ok action mirrors). This is the load-bearing
      // assertion — if a future change adds path.normalize() to the
      // quarantine Set, this test fails and the implementer must update
      // both directions of the contract together.
      expect(results.length).toBe(1);
      const snap = pool.getQuarantinedPaths?.() ?? [];
      expect(snap.includes(bs)).toBe(true);
      expect(snap.includes(fs_)).toBe(false);
    } finally {
      await pool.terminate();
    }
  });
});
