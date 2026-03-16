/**
 * P1 Unit Tests: Eval Server Formatters
 *
 * Tests: formatQueryResult, formatContextResult, formatImpactResult,
 * formatCypherResult, formatDetectChangesResult, formatListReposResult, MAX_BODY_SIZE
 */
import { describe, it, expect } from 'vitest';
import {
  formatQueryResult,
  formatContextResult,
  formatImpactResult,
  formatCypherResult,
  formatDetectChangesResult,
  formatListReposResult,
  MAX_BODY_SIZE,
} from '../../src/cli/eval-server.js';

// ─── MAX_BODY_SIZE ───────────────────────────────────────────────────

describe('MAX_BODY_SIZE', () => {
  it('is 1MB', () => {
    expect(MAX_BODY_SIZE).toBe(1024 * 1024);
  });
});

// ─── formatQueryResult ───────────────────────────────────────────────

describe('formatQueryResult', () => {
  it('returns error message for error input', () => {
    expect(formatQueryResult({ error: 'something failed' })).toBe('Error: something failed');
  });

  it('returns no-match message for empty results', () => {
    const result = formatQueryResult({ processes: [], definitions: [] });
    expect(result).toContain('No matching execution flows');
  });

  it('formats processes with symbols', () => {
    const result = formatQueryResult({
      processes: [
        { id: 'p1', summary: 'User Login Flow', step_count: 3, symbol_count: 2 },
      ],
      process_symbols: [
        { process_id: 'p1', type: 'Function', name: 'login', filePath: 'src/auth.ts', startLine: 10 },
        { process_id: 'p1', type: 'Function', name: 'validate', filePath: 'src/auth.ts', startLine: 20 },
      ],
      definitions: [],
    });
    expect(result).toContain('1 execution flow');
    expect(result).toContain('User Login Flow');
    expect(result).toContain('login');
    expect(result).toContain(':10');
  });

  it('truncates symbols per process at 6', () => {
    const symbols = Array.from({ length: 10 }, (_, i) => ({
      process_id: 'p1',
      type: 'Function',
      name: `fn${i}`,
      filePath: 'src/test.ts',
    }));
    const result = formatQueryResult({
      processes: [{ id: 'p1', summary: 'Flow', step_count: 10, symbol_count: 10 }],
      process_symbols: symbols,
      definitions: [],
    });
    expect(result).toContain('and 4 more');
  });

  it('formats standalone definitions', () => {
    const result = formatQueryResult({
      processes: [],
      definitions: [
        { type: 'Interface', name: 'Config', filePath: 'src/types.ts' },
      ],
    });
    expect(result).toContain('Standalone definitions');
    expect(result).toContain('Config');
  });

  it('truncates definitions at 8', () => {
    const defs = Array.from({ length: 12 }, (_, i) => ({
      type: 'Interface',
      name: `Type${i}`,
      filePath: 'src/types.ts',
    }));
    const result = formatQueryResult({ processes: [], definitions: defs });
    expect(result).toContain('and 4 more');
  });
});

// ─── formatContextResult ─────────────────────────────────────────────

describe('formatContextResult', () => {
  it('returns error message for error input', () => {
    expect(formatContextResult({ error: 'not found' })).toBe('Error: not found');
  });

  it('handles ambiguous results', () => {
    const result = formatContextResult({
      status: 'ambiguous',
      candidates: [
        { name: 'foo', kind: 'Function', filePath: 'src/a.ts', line: 10, uid: 'uid1' },
        { name: 'foo', kind: 'Function', filePath: 'src/b.ts', line: 5, uid: 'uid2' },
      ],
    });
    expect(result).toContain('Multiple symbols');
    expect(result).toContain('uid1');
    expect(result).toContain('uid2');
  });

  it('returns "Symbol not found" when no symbol', () => {
    expect(formatContextResult({})).toBe('Symbol not found.');
  });

  it('formats symbol with incoming/outgoing refs', () => {
    const result = formatContextResult({
      symbol: { kind: 'Function', name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
      incoming: {
        CALLS: [{ kind: 'Function', name: 'bar', filePath: 'src/b.ts' }],
      },
      outgoing: {
        IMPORTS: [{ kind: 'Module', name: 'utils', filePath: 'src/utils.ts' }],
      },
      processes: [],
    });
    expect(result).toContain('Function foo');
    expect(result).toContain('Called/imported by (1)');
    expect(result).toContain('Calls/imports (1)');
  });

  it('formats process participation', () => {
    const result = formatContextResult({
      symbol: { kind: 'Function', name: 'foo', filePath: 'src/a.ts' },
      incoming: {},
      outgoing: {},
      processes: [
        { name: 'Auth Flow', step_index: 2, step_count: 5 },
      ],
    });
    expect(result).toContain('1 execution flow');
    expect(result).toContain('Auth Flow');
  });
});

// ─── formatImpactResult ──────────────────────────────────────────────

describe('formatImpactResult', () => {
  it('returns error message for error input', () => {
    expect(formatImpactResult({ error: 'bad request' })).toBe('Error: bad request');
  });

  it('handles zero impact', () => {
    const result = formatImpactResult({
      target: { name: 'foo' },
      direction: 'upstream',
      impactedCount: 0,
      byDepth: {},
    });
    expect(result).toContain('No upstream dependencies');
  });

  it('formats impact by depth', () => {
    const result = formatImpactResult({
      target: { kind: 'Function', name: 'foo' },
      direction: 'upstream',
      impactedCount: 3,
      byDepth: {
        1: [
          { type: 'Function', name: 'caller1', filePath: 'src/a.ts', relationType: 'CALLS', confidence: 1 },
          { type: 'Function', name: 'caller2', filePath: 'src/b.ts', relationType: 'CALLS', confidence: 0.8 },
        ],
        2: [
          { type: 'Class', name: 'App', filePath: 'src/app.ts', relationType: 'IMPORTS', confidence: 1 },
        ],
      },
    });
    expect(result).toContain('Blast radius');
    expect(result).toContain('WILL BREAK');
    expect(result).toContain('caller1');
    expect(result).toContain('conf: 0.8');
    expect(result).toContain('LIKELY AFFECTED');
  });

  it('truncates items per depth at 12', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      type: 'Function',
      name: `fn${i}`,
      filePath: 'src/test.ts',
      relationType: 'CALLS',
      confidence: 1,
    }));
    const result = formatImpactResult({
      target: { kind: 'Function', name: 'foo' },
      direction: 'upstream',
      impactedCount: 15,
      byDepth: { 1: items },
    });
    expect(result).toContain('and 3 more');
  });
});

// ─── formatCypherResult ──────────────────────────────────────────────

describe('formatCypherResult', () => {
  it('returns error message for error input', () => {
    expect(formatCypherResult({ error: 'syntax error' })).toBe('Error: syntax error');
  });

  it('handles empty array', () => {
    expect(formatCypherResult([])).toBe('Query returned 0 rows.');
  });

  it('formats array of objects as table', () => {
    const result = formatCypherResult([
      { name: 'foo', filePath: 'src/a.ts' },
      { name: 'bar', filePath: 'src/b.ts' },
    ]);
    expect(result).toContain('2 row(s)');
    expect(result).toContain('name: foo');
    expect(result).toContain('name: bar');
  });

  it('truncates at 30 rows', () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ id: i }));
    const result = formatCypherResult(rows);
    expect(result).toContain('5 more rows');
  });

  it('handles string result', () => {
    expect(formatCypherResult('some text')).toBe('some text');
  });
});

// ─── formatDetectChangesResult ───────────────────────────────────────

describe('formatDetectChangesResult', () => {
  it('returns error message for error input', () => {
    expect(formatDetectChangesResult({ error: 'git error' })).toBe('Error: git error');
  });

  it('handles no changes', () => {
    const result = formatDetectChangesResult({ summary: { changed_count: 0 } });
    expect(result).toBe('No changes detected.');
  });

  it('formats changes with affected processes', () => {
    const result = formatDetectChangesResult({
      summary: { changed_files: 2, changed_count: 3, affected_count: 1, risk_level: 'MEDIUM' },
      changed_symbols: [
        { type: 'Function', name: 'foo', filePath: 'src/a.ts' },
      ],
      affected_processes: [
        { name: 'Auth Flow', step_count: 5, changed_steps: [{ symbol: 'foo' }] },
      ],
    });
    expect(result).toContain('2 files');
    expect(result).toContain('MEDIUM');
    expect(result).toContain('Auth Flow');
  });

  it('truncates changed symbols at 15', () => {
    const symbols = Array.from({ length: 20 }, (_, i) => ({
      type: 'Function',
      name: `fn${i}`,
      filePath: 'src/test.ts',
    }));
    const result = formatDetectChangesResult({
      summary: { changed_files: 1, changed_count: 20, affected_count: 0, risk_level: 'HIGH' },
      changed_symbols: symbols,
      affected_processes: [],
    });
    expect(result).toContain('and 5 more');
  });
});

// ─── formatListReposResult ───────────────────────────────────────────

describe('formatListReposResult', () => {
  it('handles empty/null input', () => {
    expect(formatListReposResult([])).toBe('No indexed repositories.');
    expect(formatListReposResult(null)).toBe('No indexed repositories.');
  });

  it('formats repo list', () => {
    const result = formatListReposResult([
      {
        name: 'my-project',
        path: '/home/user/my-project',
        indexedAt: '2024-01-01',
        stats: { nodes: 100, edges: 200, processes: 10 },
      },
    ]);
    expect(result).toContain('Indexed repositories');
    expect(result).toContain('my-project');
    expect(result).toContain('100 symbols');
  });
});
