/**
 * Pipeline-level regression for the optional-grammar exclusion (#2091, #2093).
 *
 * Locks the scope-resolution phase guard added alongside the lazy query.ts
 * load: `scopeResolutionPhase` filters its `filesByLang` partition by
 * `isLanguageAvailable`, so a file of an unavailable optional grammar never
 * falls through to the main-thread re-extract in `run.ts` (which would throw
 * "Unsupported language" — caught, but noisy, and it needlessly loads the
 * grammar on the main thread).
 *
 * Drives the REAL pipeline over a mixed Python+Swift repo with the runtime
 * `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` opt-out set (so Swift is treated as
 * unavailable even though its binding is installed). This is the automated
 * analog of the manual end-to-end verification: Python indexes, Swift is
 * cleanly skipped, and the "scope extraction failed for …swift" noise never
 * appears. The env is set BEFORE the run so the first `isLanguageAvailable`
 * call inside the pipeline observes it (parser-loader memoizes per process).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, getNodesByLabel, type PipelineResult } from '../resolvers/helpers.js';
import { _captureLogger, type LoggerCapture } from '../../../src/core/logger.js';

const ENV = 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS';

describe('optional-grammar pipeline exclusion (#2091/#2093)', () => {
  let repoDir = '';
  let result: PipelineResult;
  let messages: string[] = [];
  let cap: LoggerCapture | undefined;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    prevEnv = process.env[ENV];
    process.env[ENV] = 'swift';
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-skip-pipeline-'));
    fs.writeFileSync(
      path.join(repoDir, 'app.py'),
      'def greet(name):\n    return f"hi {name}"\n\n\nclass Service:\n    def run(self):\n        return greet("world")\n',
    );
    fs.writeFileSync(
      path.join(repoDir, 'Foo.swift'),
      'struct Foo {\n  func bar() -> Int { return 42 }\n}\n',
    );

    cap = _captureLogger();
    try {
      result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
      messages = cap
        .records()
        .map((r) => (typeof r.msg === 'string' ? r.msg : ''))
        .filter(Boolean);
    } finally {
      cap.restore();
      cap = undefined;
    }
  }, 60_000);

  afterAll(() => {
    if (prevEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = prevEnv;
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('completes without crashing when an optional grammar is opted out', () => {
    expect(result).toBeDefined();
  });

  it('skips the Swift file at the parse phase (non-vacuity: Swift was present)', () => {
    expect(messages.some((m) => /Skipping 1 swift file\(s\)/.test(m))).toBe(true);
  });

  it('never falls through to the main-thread re-extract (no "scope extraction failed")', () => {
    // This is the precise signal the scope-resolution phase guard eliminates.
    // Without the `if (!isLanguageAvailable(fileLang)) continue;` in phase.ts
    // the Swift file would reach run.ts's extractParsedFile and log this.
    const offending = messages.filter((m) => /scope extraction failed/i.test(m));
    expect(offending, offending.join('\n')).toEqual([]);
  });

  it('indexes the available Python language and excludes Swift symbols', () => {
    // Python indexed (proves the pipeline actually ran end-to-end).
    expect(getNodesByLabel(result, 'Class')).toContain('Service');
    // Swift's struct must not be in the graph — it was excluded, not parsed.
    expect(getNodesByLabel(result, 'Struct')).not.toContain('Foo');
  });
});
