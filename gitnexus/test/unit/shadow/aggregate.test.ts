/**
 * Unit tests for `aggregateDiffs` (RFC #909 Ring 2 SHARED #918).
 *
 * Covers bucketing by language, parity math (incl. zero-resolved edge),
 * evidence-kind breakdown, and stable sort order on the output rows.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateDiffs,
  SupportedLanguages,
  type LanguageParityRow,
  type ResolutionEvidence,
  type ShadowAgreement,
  type ShadowDiff,
} from 'gitnexus-shared';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-04-18T12:00:00.000Z');

const makeDiff = (
  agreement: ShadowAgreement,
  evidenceKinds: readonly ResolutionEvidence['kind'][] = [],
): ShadowDiff => ({
  callsite: { filePath: 'src/x.ts', line: 1, col: 0, calledName: 'foo' },
  legacy: null,
  newResult: null,
  agreement,
  evidenceDelta: evidenceKinds.map((kind) => ({ kind, weight: 0.3 })),
});

const entry = (language: SupportedLanguages, diff: ShadowDiff) => ({ language, diff });

const findRow = (
  rows: readonly LanguageParityRow[],
  language: SupportedLanguages,
): LanguageParityRow => {
  const row = rows.find((r) => r.language === language);
  if (!row) throw new Error(`no row for ${language}`);
  return row;
};

// ─── Empty input ────────────────────────────────────────────────────────────

describe('aggregateDiffs — empty input', () => {
  it('returns empty perLanguage, zeroed overall, generatedAt populated', () => {
    const report = aggregateDiffs([], FIXED_NOW);
    expect(report.perLanguage).toEqual([]);
    expect(report.overall).toEqual({
      totalCalls: 0,
      bothAgree: 0,
      onlyLegacy: 0,
      onlyNew: 0,
      bothDisagree: 0,
      bothEmpty: 0,
      parity: 0,
    });
    expect(report.generatedAt).toBe('2026-04-18T12:00:00.000Z');
  });
});

// ─── Single language, single outcome ────────────────────────────────────────

describe('aggregateDiffs — single language', () => {
  it('all both-agree → parity = 1.0', () => {
    const diffs = [
      entry(SupportedLanguages.Python, makeDiff('both-agree')),
      entry(SupportedLanguages.Python, makeDiff('both-agree')),
      entry(SupportedLanguages.Python, makeDiff('both-agree')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    expect(report.perLanguage).toHaveLength(1);
    const row = findRow(report.perLanguage, SupportedLanguages.Python);
    expect(row).toMatchObject({
      language: SupportedLanguages.Python,
      totalCalls: 3,
      bothAgree: 3,
      onlyLegacy: 0,
      onlyNew: 0,
      bothDisagree: 0,
      bothEmpty: 0,
      parity: 1,
    });
  });

  it('mixed outcomes → parity excludes both-empty from denominator', () => {
    const diffs = [
      entry(SupportedLanguages.TypeScript, makeDiff('both-agree')),
      entry(SupportedLanguages.TypeScript, makeDiff('both-agree')),
      entry(SupportedLanguages.TypeScript, makeDiff('only-legacy', ['global-name'])),
      entry(SupportedLanguages.TypeScript, makeDiff('only-new', ['local'])),
      entry(SupportedLanguages.TypeScript, makeDiff('both-disagree', ['import'])),
      entry(SupportedLanguages.TypeScript, makeDiff('both-empty')),
      entry(SupportedLanguages.TypeScript, makeDiff('both-empty')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    const row = findRow(report.perLanguage, SupportedLanguages.TypeScript);
    expect(row.totalCalls).toBe(7);
    expect(row.bothAgree).toBe(2);
    expect(row.onlyLegacy).toBe(1);
    expect(row.onlyNew).toBe(1);
    expect(row.bothDisagree).toBe(1);
    expect(row.bothEmpty).toBe(2);
    // parity = bothAgree / (totalCalls - bothEmpty) = 2 / (7 - 2) = 0.4
    expect(row.parity).toBeCloseTo(0.4, 10);
  });

  it('all both-empty → parity = 0 (not NaN)', () => {
    const diffs = [
      entry(SupportedLanguages.Java, makeDiff('both-empty')),
      entry(SupportedLanguages.Java, makeDiff('both-empty')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    const row = findRow(report.perLanguage, SupportedLanguages.Java);
    expect(row.totalCalls).toBe(2);
    expect(row.bothEmpty).toBe(2);
    expect(row.parity).toBe(0);
    expect(Number.isNaN(row.parity)).toBe(false);
  });
});

// ─── Multi-language ─────────────────────────────────────────────────────────

describe('aggregateDiffs — multiple languages', () => {
  it('buckets rows by language and sums overall column-wise', () => {
    const diffs = [
      entry(SupportedLanguages.Python, makeDiff('both-agree')),
      entry(SupportedLanguages.Python, makeDiff('both-disagree', ['local'])),
      entry(SupportedLanguages.Ruby, makeDiff('both-agree')),
      entry(SupportedLanguages.Ruby, makeDiff('both-agree')),
      entry(SupportedLanguages.Ruby, makeDiff('only-new', ['type-binding'])),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    expect(report.perLanguage).toHaveLength(2);

    const python = findRow(report.perLanguage, SupportedLanguages.Python);
    expect(python.totalCalls).toBe(2);
    expect(python.bothAgree).toBe(1);
    expect(python.bothDisagree).toBe(1);
    expect(python.parity).toBe(0.5);

    const ruby = findRow(report.perLanguage, SupportedLanguages.Ruby);
    expect(ruby.totalCalls).toBe(3);
    expect(ruby.bothAgree).toBe(2);
    expect(ruby.onlyNew).toBe(1);
    expect(ruby.parity).toBeCloseTo(2 / 3, 10);

    expect(report.overall).toEqual({
      totalCalls: 5,
      bothAgree: 3,
      onlyLegacy: 0,
      onlyNew: 1,
      bothDisagree: 1,
      bothEmpty: 0,
      parity: 3 / 5,
    });
  });

  it('perLanguage rows are sorted alphabetically by language value for stable output', () => {
    const diffs = [
      entry(SupportedLanguages.TypeScript, makeDiff('both-agree')),
      entry(SupportedLanguages.C, makeDiff('both-agree')),
      entry(SupportedLanguages.Python, makeDiff('both-agree')),
      entry(SupportedLanguages.Java, makeDiff('both-agree')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    const ordered = report.perLanguage.map((r) => r.language);
    // Alphabetical by enum VALUE: 'c' < 'java' < 'python' < 'typescript'
    expect(ordered).toEqual([
      SupportedLanguages.C,
      SupportedLanguages.Java,
      SupportedLanguages.Python,
      SupportedLanguages.TypeScript,
    ]);
  });
});

// ─── Evidence breakdown ─────────────────────────────────────────────────────

describe('aggregateDiffs — evidence breakdown', () => {
  it('counts divergence evidence kinds across non-agreeing rows only', () => {
    const diffs = [
      entry(SupportedLanguages.Go, makeDiff('both-disagree', ['import', 'owner-match'])),
      entry(SupportedLanguages.Go, makeDiff('only-legacy', ['import', 'global-name'])),
      entry(SupportedLanguages.Go, makeDiff('only-new', ['local'])),
      // both-agree contributes 0 to evidence breakdown regardless of any attached evidence
      entry(SupportedLanguages.Go, makeDiff('both-agree', ['import'])),
      // both-empty also contributes 0
      entry(SupportedLanguages.Go, makeDiff('both-empty')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    const row = findRow(report.perLanguage, SupportedLanguages.Go);
    expect(Array.from(row.evidenceBreakdown.entries())).toEqual([
      ['global-name', 1],
      ['import', 2],
      ['local', 1],
      ['owner-match', 1],
    ]);
  });

  it('emits empty evidenceBreakdown when all calls agree or are empty', () => {
    const diffs = [
      entry(SupportedLanguages.Rust, makeDiff('both-agree')),
      entry(SupportedLanguages.Rust, makeDiff('both-empty')),
    ];
    const report = aggregateDiffs(diffs, FIXED_NOW);
    const row = findRow(report.perLanguage, SupportedLanguages.Rust);
    expect(row.evidenceBreakdown.size).toBe(0);
  });
});

// ─── Determinism ────────────────────────────────────────────────────────────

describe('aggregateDiffs — determinism', () => {
  it('injected `now` is used verbatim for generatedAt', () => {
    const t = new Date('2030-01-01T00:00:00.000Z');
    const report = aggregateDiffs([], t);
    expect(report.generatedAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('same input produces byte-identical JSON (stable keys + sort)', () => {
    const diffs = [
      entry(SupportedLanguages.Python, makeDiff('both-disagree', ['local', 'import'])),
      entry(SupportedLanguages.Java, makeDiff('both-agree')),
    ];
    const a = aggregateDiffs(diffs, FIXED_NOW);
    const b = aggregateDiffs(diffs, FIXED_NOW);
    // Round-trip through JSON to drop Map identity and force structural comparison.
    const toJson = (r: typeof a): string =>
      JSON.stringify(r, (_key, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v));
    expect(toJson(a)).toBe(toJson(b));
  });
});
