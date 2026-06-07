/**
 * Native-parser-unavailable handling.
 *
 * When a file's language has no loadable native parser (e.g. a Swift grammar
 * that didn't build), the parse phase must SKIP the file with a warning — never
 * crash. The sequential parser used to enforce this in-process; with it removed,
 * the guarantee lives in the parse phase's pre-dispatch availability filter
 * (`runChunkedParseAndResolve` → `isLanguageAvailable`), which runs on the MAIN
 * thread before any worker is spawned. Mocking `parser-loader` exercises that
 * filter; because the only file is filtered out, no worker pool is created — so
 * this stays a fast unit test with no dist dependency.
 *
 * (Replaces `sequential-language-availability.test.ts`, which drove the deleted
 * in-process parser and asserted its now-removed log message. `vi.mock` cannot
 * cross the worker_threads isolate boundary, so the worker's own skip path can't
 * be exercised this way — the main-thread filter is the testable seam.)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/tree-sitter/parser-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/tree-sitter/parser-loader.js')>();
  return { ...actual, isLanguageAvailable: vi.fn(() => true) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import * as parserLoader from '../../src/core/tree-sitter/parser-loader.js';
import { _captureLogger } from '../../src/core/logger.js';
import type { LoggerCapture } from '../../src/core/logger.js';

describe('native parser availability — unavailable language is skipped, not crashed', () => {
  let cap: LoggerCapture | undefined;
  let repoDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-availability-'));
  });

  afterEach(() => {
    cap?.restore();
    cap = undefined;
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  /** Run the parse phase over a single Swift file in the temp repo. */
  const runWithSwift = () => {
    const rel = 'App.swift';
    fs.writeFileSync(path.join(repoDir, rel), 'class AppViewController: UIViewController {}\n');
    const scanned = [{ path: rel, size: fs.statSync(path.join(repoDir, rel)).size }];
    return runChunkedParseAndResolve(
      createKnowledgeGraph(),
      scanned,
      [rel],
      1,
      repoDir,
      Date.now(),
      () => {},
    );
  };

  it('skips the Swift file without crashing (and without spawning a pool) when its parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);
    // The only file is filtered out before dispatch, so the parse phase
    // completes (returns its result) instead of throwing, and never needs a
    // worker pool — `usedWorkerPool` stays false.
    const result = await runWithSwift();
    expect(result.usedWorkerPool).toBe(false);
  });

  it('warns that the unavailable-parser file was skipped', async () => {
    cap = _captureLogger();
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);
    await runWithSwift();
    const warned = cap
      .records()
      .some(
        (r) =>
          typeof r.msg === 'string' &&
          r.msg.includes('Skipping 1 swift file(s)') &&
          r.msg.includes('swift parser not available'),
      );
    expect(warned).toBe(true);
  });
});
