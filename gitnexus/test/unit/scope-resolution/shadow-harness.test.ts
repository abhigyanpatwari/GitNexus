/**
 * Unit tests for `shadow-harness` (RFC #909 Ring 2 PKG #923).
 *
 * Covers flag detection, record accumulation, aggregation, and JSON
 * persistence (real fs in a per-test tmpdir).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EvidenceWeights,
  SupportedLanguages,
  type Resolution,
  type ShadowCallsite,
  type SymbolDefinition,
} from 'gitnexus-shared';
import {
  createShadowHarness,
  type PersistedShadowReport,
  type ShadowHarness,
} from '../../../src/core/ingestion/shadow-harness.js';

// ─── Env isolation — GITNEXUS_SHADOW_MODE bleeds between tests otherwise ──

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env['GITNEXUS_SHADOW_MODE'];
  delete process.env['GITNEXUS_SHADOW_MODE'];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env['GITNEXUS_SHADOW_MODE'];
  else process.env['GITNEXUS_SHADOW_MODE'] = savedEnv;
});

// ─── Fixture helpers ──────────────────────────────────────────────────────

const callsite = (filePath = 'a.ts', line = 1): ShadowCallsite => ({
  filePath,
  range: { startLine: line, startCol: 0, endLine: line, endCol: 10 },
});

const def = (nodeId: string): SymbolDefinition => ({
  nodeId,
  filePath: 'x.ts',
  type: 'Class',
});

const resolution = (nodeId: string): Resolution => ({
  def: def(nodeId),
  confidence: EvidenceWeights.local,
  evidence: [{ kind: 'local', weight: EvidenceWeights.local }],
});

function enable(): void {
  process.env['GITNEXUS_SHADOW_MODE'] = 'true';
}

function freshHarness(): ShadowHarness {
  return createShadowHarness();
}

// ─── Flag detection ───────────────────────────────────────────────────────

describe('createShadowHarness: enabled flag', () => {
  it('is disabled by default (no env var set)', () => {
    expect(freshHarness().enabled).toBe(false);
  });

  it("is enabled when GITNEXUS_SHADOW_MODE is 'true' / '1' / 'yes' / case-insensitive", () => {
    for (const value of ['true', '1', 'yes', 'TRUE', '  Yes  ']) {
      process.env['GITNEXUS_SHADOW_MODE'] = value;
      expect(freshHarness().enabled).toBe(true);
    }
  });

  it('stays disabled for falsy-looking or typo values', () => {
    for (const value of ['', 'false', '0', 'off', 'tru']) {
      process.env['GITNEXUS_SHADOW_MODE'] = value;
      expect(freshHarness().enabled).toBe(false);
    }
  });

  it('record() is a no-op when disabled', () => {
    const h = freshHarness(); // disabled
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    expect(h.size()).toBe(0);
  });

  it('does NOT re-check the env var per call (constructed-once semantics)', () => {
    const h = freshHarness(); // disabled at construction
    process.env['GITNEXUS_SHADOW_MODE'] = 'true'; // flip AFTER construction
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    // Still disabled — the harness captured its `enabled` at construction.
    expect(h.size()).toBe(0);
  });
});

// ─── Record + snapshot ────────────────────────────────────────────────────

describe('record + snapshot', () => {
  it('accumulates records across languages', () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    h.record({
      language: SupportedLanguages.TypeScript,
      callsite: callsite('b.ts'),
      legacy: [resolution('def:b')],
      newResult: [],
      primary: 'registry',
    });
    expect(h.size()).toBe(2);
  });

  it('snapshot reports per-language rows with correct outcomes', () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite('a.py', 2),
      legacy: [resolution('def:b')],
      newResult: [],
      primary: 'legacy',
    });
    const report = h.snapshot(new Date('2026-04-18T00:00:00Z'));
    expect(report.perLanguage).toHaveLength(1);
    const py = report.perLanguage[0]!;
    expect(py.language).toBe(SupportedLanguages.Python);
    expect(py.totalCalls).toBe(2);
    expect(py.bothAgree).toBe(1);
    expect(py.onlyLegacy).toBe(1);
  });

  it('snapshot is deterministic across repeated calls', () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    const now = new Date('2026-04-18T12:00:00Z');
    const a = h.snapshot(now);
    const b = h.snapshot(now);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('clear() resets the accumulator and primaryByLanguage', async () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'registry',
    });
    expect(h.size()).toBe(1);
    h.clear();
    expect(h.size()).toBe(0);
    // Verify primary is also cleared: persist after a fresh record with a
    // different primary should reflect the new value only.
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite('a.py'),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gn-sh-clear-'));
    try {
      await h.persist(dir);
      const payload = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
      expect(payload.primaryByLanguage.python).toBe('legacy');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Persistence ──────────────────────────────────────────────────────────

describe('persist', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gn-shadow-harness-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates outputDir if it does not exist', async () => {
    enable();
    const h = freshHarness();
    const nested = path.join(tmpDir, 'nested', 'a', 'b');
    await h.persist(nested);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(path.join(nested, 'latest.json'))).toBe(true);
  });

  it('writes BOTH a timestamped file and latest.json with the same payload', async () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.Python,
      callsite: callsite(),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'legacy',
    });
    const perRunPath = await h.persist(tmpDir, new Date('2026-04-18T12:34:56Z'));
    const latestPath = path.join(tmpDir, 'latest.json');

    expect(fs.existsSync(perRunPath)).toBe(true);
    expect(fs.existsSync(latestPath)).toBe(true);
    expect(fs.readFileSync(perRunPath, 'utf8')).toBe(fs.readFileSync(latestPath, 'utf8'));
  });

  it('persisted payload matches the schema v1 shape', async () => {
    enable();
    const h = freshHarness();
    h.record({
      language: SupportedLanguages.TypeScript,
      callsite: callsite('a.ts'),
      legacy: [resolution('def:a')],
      newResult: [resolution('def:a')],
      primary: 'registry',
    });
    const now = new Date('2026-04-18T00:00:00Z');
    await h.persist(tmpDir, now);
    const payload: PersistedShadowReport = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'latest.json'), 'utf8'),
    );
    expect(payload.schemaVersion).toBe(1);
    expect(payload.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(payload.generatedAt).toBe('2026-04-18T00:00:00.000Z');
    expect(payload.primaryByLanguage.typescript).toBe('registry');
    expect(payload.report.overall.totalCalls).toBe(1);
    expect(payload.report.overall.bothAgree).toBe(1);
  });

  it('runId embeds the run timestamp for chronological sorting', async () => {
    enable();
    const h1 = freshHarness();
    const h2 = freshHarness();
    const p1 = await h1.persist(tmpDir, new Date('2026-04-18T00:00:00Z'));
    const p2 = await h2.persist(tmpDir, new Date('2026-04-18T01:00:00Z'));
    // Timestamp prefix means the second file sorts after the first.
    expect(path.basename(p2) > path.basename(p1)).toBe(true);
  });

  it('persists an empty report gracefully (no records, no error)', async () => {
    enable();
    const h = freshHarness();
    await h.persist(tmpDir);
    const payload = JSON.parse(fs.readFileSync(path.join(tmpDir, 'latest.json'), 'utf8'));
    expect(payload.report.overall.totalCalls).toBe(0);
    expect(payload.report.perLanguage).toEqual([]);
  });
});
