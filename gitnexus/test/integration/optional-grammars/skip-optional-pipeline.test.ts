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
 * appears.
 *
 * `parser-loader` memoizes availability per process, so we `vi.resetModules()`
 * BEFORE setting the env and dynamically import the pipeline + logger from the
 * same fresh registry. That makes the first `isLanguageAvailable` call observe
 * our env regardless of import order, and keeps the logger capture wired to the
 * loader's logger instance (a static import would not survive resetModules).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineResult } from '../resolvers/helpers.js';

const ENV = 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS';

describe('optional-grammar pipeline exclusion (#2091/#2093)', () => {
  let repoDir = '';
  let result: PipelineResult;
  let messages: string[] = [];
  let prevEnv: string | undefined;
  let getNodesByLabel: (r: PipelineResult, label: string) => string[];

  beforeAll(async () => {
    prevEnv = process.env[ENV];
    vi.resetModules();
    process.env[ENV] = 'swift';
    const helpers = await import('../resolvers/helpers.js');
    const loggerMod = await import('../../../src/core/logger.js');
    getNodesByLabel = helpers.getNodesByLabel;

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-skip-pipeline-'));
    fs.writeFileSync(
      path.join(repoDir, 'app.py'),
      'def greet(name):\n    return f"hi {name}"\n\n\nclass Service:\n    def run(self):\n        return greet("world")\n',
    );
    fs.writeFileSync(
      path.join(repoDir, 'Foo.swift'),
      'struct Foo {\n  func bar() -> Int { return 42 }\n}\n',
    );

    const cap = loggerMod._captureLogger();
    try {
      result = await helpers.runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
      messages = cap
        .records()
        .map((r) => (typeof r.msg === 'string' ? r.msg : ''))
        .filter(Boolean);
    } finally {
      cap.restore();
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

  it('routes the opt-out message, not the missing-binding "npm rebuild" hint', () => {
    // The "Skipping N swift file(s)" prefix is shared by BOTH the opt-out and
    // the missing-binding branches — so assert the opt-out branch specifically:
    // a message naming the env var, and NO "npm rebuild" hint anywhere. This is
    // what proves the isGrammarRuntimeSkipped routing in parse-impl.ts fired.
    expect(messages.some((m) => /GITNEXUS_SKIP_OPTIONAL_GRAMMARS/.test(m))).toBe(true);
    expect(
      messages.every((m) => !/npm rebuild/i.test(m)),
      messages.join('\n'),
    ).toBe(true);
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
