/**
 * The per-language guessed/refused census persisted as
 * `RepoMeta.nameFallbackEdges` and printed in the analyze summary.
 *
 * The pair of counts is the point. A guess count alone cannot distinguish a
 * language with few impossible candidates from one whose visibility hook is
 * missing, and a refusal count alone cannot distinguish a working guard from
 * one that rejects everything — so both are asserted to survive per language
 * rather than being folded into a repo-wide total.
 */

import { describe, it, expect } from 'vitest';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import {
  countCallsByLanguage,
  formatNameFallbackSummary,
  MAX_AMBIGUOUS_NAMES,
  summarizeNameFallback,
} from '../../../src/core/ingestion/scope-resolution/name-fallback-summary.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 5 };

const guessed = (language: string | undefined, name = 'helper'): ResolutionOutcome => ({
  kind: 'fallback-guessed',
  targetId: `def:${name}`,
  language,
  phase: 'free-call-fallback',
  filePath: 'a',
  name,
  range,
});

const refused = (language: string | undefined, name = 'helper'): ResolutionOutcome => ({
  kind: 'fallback-refused',
  candidateId: `def:${name}`,
  language,
  phase: 'free-call-fallback',
  filePath: 'a',
  name,
  range,
});

describe('summarizeNameFallback', () => {
  it('returns undefined when a run neither guessed nor refused', () => {
    // A repository with no opt-in language must store no key at all, rather
    // than a row of zeroes that reads as a measured result.
    expect(summarizeNameFallback([])).toBeUndefined();
  });

  it('ignores unrelated outcomes', () => {
    const unrelated: ResolutionOutcome = {
      kind: 'resolved',
      targetId: 'def:x',
      phase: 'free-call-fallback',
      filePath: 'a',
      name: 'x',
      range,
    };
    expect(summarizeNameFallback([unrelated])).toBeUndefined();
  });

  it('keeps guesses and refusals separated per language', () => {
    const summary = summarizeNameFallback([
      guessed('go'),
      guessed('go', 'other'),
      refused('go'),
      refused('rust'),
      refused('rust'),
      refused('rust'),
    ]);
    expect(summary).toEqual({
      byLanguage: {
        go: { guessed: 2, guessedPairs: 2, refused: 1 },
        rust: { guessed: 0, guessedPairs: 0, refused: 3 },
      },
      totalGuessed: 2,
      distinctGuessedPairs: 2,
      totalRefused: 4,
      totalAmbiguousReexports: 0,
    });
  });

  it('keeps call SITES in `guessed` and distinct (caller file, callee name) pairs in `guessedPairs`', () => {
    // Three guessed `helper()` sites plus one `other()` in one file: 4 sites,
    // 2 distinct pairs. `callsByLanguage` counts distinct callee names, so the
    // guessy RATIO is pairs/calls and stays bounded by 1 (M5); the site count
    // keeps its historical unit so persisted summaries stay comparable (M13).
    const summary = summarizeNameFallback(
      [guessed('go'), guessed('go'), guessed('go'), guessed('go', 'other')],
      { go: 2 },
    );
    expect(summary?.byLanguage.go).toEqual({ guessed: 4, guessedPairs: 2, refused: 0 });
    expect(summary?.totalGuessed).toBe(4);
    expect(summary?.distinctGuessedPairs).toBe(2);
    expect(
      summary!.byLanguage.go!.guessedPairs! / summary!.callsByLanguage!.go!,
    ).toBeLessThanOrEqual(1);
  });

  it('counts refused `export *` collisions in the same census, outside the language table', () => {
    const summary = summarizeNameFallback([
      {
        kind: 'reexport-ambiguous',
        candidateIds: ['def:a', 'def:b'],
        phase: 'finalize',
        filePath: 'packages/ui/src/index.ts',
        name: 'collide',
      },
    ]);
    expect(summary).toEqual({
      byLanguage: {},
      totalGuessed: 0,
      distinctGuessedPairs: 0,
      totalRefused: 0,
      totalAmbiguousReexports: 1,
      ambiguousReexportNames: ['packages/ui/src/index.ts:collide'],
    });
    expect(formatNameFallbackSummary(summary)).toContain('1 barrel name(s) refused as ambiguous');
  });

  it('buckets an unattributed pass rather than dropping it', () => {
    const summary = summarizeNameFallback([guessed(undefined)]);
    expect(summary?.byLanguage).toEqual({ unknown: { guessed: 1, guessedPairs: 1, refused: 0 } });
    expect(summary?.totalGuessed).toBe(1);
  });

  it('caps the persisted ambiguous-name list at MAX_AMBIGUOUS_NAMES while keeping the total exact', () => {
    const ambiguous = (name: string): ResolutionOutcome => ({
      kind: 'reexport-ambiguous',
      candidateIds: ['def:a', 'def:b'],
      phase: 'finalize',
      filePath: 'x.ts',
      name,
    });
    // 250 distinct fixed-width names, well over the 200 cap, generated in
    // DESCENDING order so a bug that capped BEFORE sorting (first 200 seen,
    // not first 200 alphabetically) would be caught.
    const names = Array.from({ length: 250 }, (_, i) => `n${String(249 - i).padStart(3, '0')}`);
    const summary = summarizeNameFallback(names.map(ambiguous));
    expect(summary?.totalAmbiguousReexports).toBe(250);
    expect(summary?.ambiguousReexportNames).toHaveLength(MAX_AMBIGUOUS_NAMES);
    const expectedSorted = [...new Set(names.map((n) => `x.ts:${n}`))].sort().slice(0, 200);
    expect(summary?.ambiguousReexportNames).toEqual(expectedSorted);
  });

  it('does not cap when the list is at or under the bound', () => {
    const ambiguous = (name: string): ResolutionOutcome => ({
      kind: 'reexport-ambiguous',
      candidateIds: ['def:a', 'def:b'],
      phase: 'finalize',
      filePath: 'x.ts',
      name,
    });
    const names = Array.from({ length: MAX_AMBIGUOUS_NAMES }, (_, i) => `n${i}`);
    const summary = summarizeNameFallback(names.map(ambiguous));
    expect(summary?.ambiguousReexportNames).toHaveLength(MAX_AMBIGUOUS_NAMES);
  });
});

describe('countCallsByLanguage', () => {
  const nodesOf = (byId: Record<string, string>) => ({
    getNode: (id: string) =>
      byId[id] === undefined ? undefined : { properties: { filePath: byId[id] } },
  });

  it('buckets CALLS totals by the CALLER file language, summed across callers', () => {
    const index = new Map<string, ReadonlySet<string>>([
      ['caller-go-1', new Set(['A', 'B'])],
      ['caller-go-2', new Set(['C'])],
      ['caller-ts-1', new Set(['D', 'E', 'F'])],
    ]);
    const nodes = nodesOf({
      'caller-go-1': 'pkg/a.go',
      'caller-go-2': 'pkg/b.go',
      'caller-ts-1': 'src/x.ts',
    });
    expect(countCallsByLanguage(index, nodes)).toEqual({ go: 3, typescript: 3 });
  });

  it('falls back to "unknown" for a caller whose language cannot be detected', () => {
    const index = new Map<string, ReadonlySet<string>>([['caller-1', new Set(['A'])]]);
    const nodes = nodesOf({ 'caller-1': 'README' });
    expect(countCallsByLanguage(index, nodes)).toEqual({ unknown: 1 });
  });

  it('skips a caller id absent from the node table rather than throwing', () => {
    const index = new Map<string, ReadonlySet<string>>([
      ['missing', new Set(['A'])],
      ['present', new Set(['B', 'C'])],
    ]);
    const nodes = nodesOf({ present: 'a.py' });
    expect(countCallsByLanguage(index, nodes)).toEqual({ python: 2 });
  });

  it('returns undefined when either input is missing (no denominator available)', () => {
    const nodes = nodesOf({ a: 'a.go' });
    expect(countCallsByLanguage(undefined, nodes)).toBeUndefined();
    expect(countCallsByLanguage(new Map(), undefined)).toBeUndefined();
  });

  it('returns undefined rather than an empty object when the index has entries but nothing attributes', () => {
    const index = new Map<string, ReadonlySet<string>>([['caller-1', new Set(['A'])]]);
    const nodes = nodesOf({}); // caller-1 not in the node table
    expect(countCallsByLanguage(index, nodes)).toBeUndefined();
  });
});

describe('formatNameFallbackSummary', () => {
  it('prints nothing when there is nothing to report', () => {
    expect(formatNameFallbackSummary(undefined)).toBeUndefined();
  });

  it('reports both totals and the per-language split, busiest first', () => {
    const line = formatNameFallbackSummary(
      summarizeNameFallback([guessed('ruby'), refused('go'), refused('go'), refused('go')]),
    );
    expect(line).toContain('1 call sites (1 distinct caller-file/name pairs)');
    expect(line).toContain('3 refused as impossible');
    // `go` has more total activity, so it leads.
    expect(line).toMatch(/go 0\/3.*ruby 1\/0/);
  });
});
