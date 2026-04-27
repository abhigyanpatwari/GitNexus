import { describe, it, expect } from 'vitest';
import {
  detectCoverageGaps,
  formatCoverageGapWarning,
} from '../../src/core/coverage-gaps.js';

describe('detectCoverageGaps', () => {
  it('returns empty when there are no unsupported source files', () => {
    const paths = [
      'src/main.ts',
      'src/util.ts',
      'src/lib.py',
      'README.md',
      'package.json',
    ];
    expect(detectCoverageGaps(paths)).toEqual([]);
  });

  it('flags an unsupported language present above the default threshold', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/ns/${i}.cljs`);
    const gaps = detectCoverageGaps(paths);
    expect(gaps).toEqual([
      { extension: '.cljs', language: 'ClojureScript', fileCount: 25 },
    ]);
  });

  it('does not flag an unsupported language below the threshold', () => {
    const paths = ['a.clj', 'b.clj', 'c.clj'];
    expect(detectCoverageGaps(paths)).toEqual([]);
  });

  it('respects a custom minFiles threshold', () => {
    const paths = ['a.clj', 'b.clj', 'c.clj'];
    expect(detectCoverageGaps(paths, { minFiles: 3 })).toEqual([
      { extension: '.clj', language: 'Clojure', fileCount: 3 },
    ]);
  });

  it('aggregates multiple unsupported languages and sorts by count desc', () => {
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `frontend/${i}.cljs`),
      ...Array.from({ length: 15 }, (_, i) => `backend/${i}.clj`),
      ...Array.from({ length: 12 }, (_, i) => `common/${i}.cljc`),
      ...Array.from({ length: 50 }, (_, i) => `core/${i}.ts`), // supported, ignored
    ];
    const gaps = detectCoverageGaps(paths);
    expect(gaps).toEqual([
      { extension: '.cljs', language: 'ClojureScript', fileCount: 30 },
      { extension: '.clj', language: 'Clojure', fileCount: 15 },
      { extension: '.cljc', language: 'Clojure (cross-platform)', fileCount: 12 },
    ]);
  });

  it('treats extensions case-insensitively', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/${i}.HS`);
    const gaps = detectCoverageGaps(paths);
    expect(gaps).toEqual([
      { extension: '.hs', language: 'Haskell', fileCount: 12 },
    ]);
  });

  it('ignores files without an extension', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `bin/exe-${i}`);
    expect(detectCoverageGaps(paths)).toEqual([]);
  });

  it('ignores supported languages even when present in large numbers', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `src/${i}.ts`);
    expect(detectCoverageGaps(paths)).toEqual([]);
  });
});

describe('formatCoverageGapWarning', () => {
  it('returns null for empty gaps', () => {
    expect(formatCoverageGapWarning([])).toBeNull();
  });

  it('formats a single gap with file count and language', () => {
    const out = formatCoverageGapWarning([
      { extension: '.cljs', language: 'ClojureScript', fileCount: 1865 },
    ]);
    expect(out).toContain('Coverage gaps detected');
    expect(out).toContain('1,865 .cljs files');
    expect(out).toContain('ClojureScript not supported');
  });

  it('formats multiple gaps on separate lines', () => {
    const out = formatCoverageGapWarning([
      { extension: '.cljs', language: 'ClojureScript', fileCount: 1146 },
      { extension: '.clj', language: 'Clojure', fileCount: 719 },
    ]);
    expect(out).toContain('1,146 .cljs');
    expect(out).toContain('719 .clj');
    expect(out!.split('\n').length).toBeGreaterThanOrEqual(4);
  });
});
