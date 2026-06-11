/**
 * P1 Unit Tests: Eval Server Formatters
 *
 * Tests: formatQueryResult, formatContextResult, formatImpactResult,
 * formatCypherResult, formatDetectChangesResult, formatListReposResult, MAX_BODY_SIZE
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatQueryResult,
  formatContextResult,
  formatImpactResult,
  formatCypherResult,
  formatDetectChangesResult,
  formatListReposResult,
  MAX_BODY_SIZE,
  validateHost,
} from '../../src/cli/eval-server.js';

// ─── validateHost ────────────────────────────────────────────────────

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('GITNEXUS_LANG', 'en');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateHost', () => {
  it('passes "localhost" through unchanged', () => {
    expect(validateHost('localhost')).toBe('localhost');
  });

  it('accepts valid IPv4 addresses', () => {
    expect(validateHost('127.0.0.1')).toBe('127.0.0.1');
    expect(validateHost('0.0.0.0')).toBe('0.0.0.0');
    expect(validateHost('192.168.1.5')).toBe('192.168.1.5');
    expect(validateHost('10.0.0.1')).toBe('10.0.0.1');
  });

  it('accepts valid IPv6 addresses', () => {
    expect(validateHost('::1')).toBe('::1');
    expect(validateHost('::')).toBe('::');
    expect(validateHost('2001:db8::1')).toBe('2001:db8::1');
  });

  it('returns null for a non-IP hostname', () => {
    expect(validateHost('foo.bar')).toBeNull();
    expect(validateHost('myhost.local')).toBeNull();
    expect(validateHost('example.com')).toBeNull();
  });

  it('returns null for out-of-range IPv4 octets', () => {
    expect(validateHost('999.999.999.999')).toBeNull();
    expect(validateHost('192.168.1.256')).toBeNull();
  });

  it('returns null for incomplete IPv4 addresses', () => {
    expect(validateHost('192.168.1')).toBeNull();
    expect(validateHost('192.168')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(validateHost('')).toBeNull();
  });

  it('returns null for whitespace or padded IPs', () => {
    expect(validateHost(' ')).toBeNull();
    expect(validateHost(' 127.0.0.1')).toBeNull();
    expect(validateHost('127.0.0.1 ')).toBeNull();
  });
});

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
      processes: [{ id: 'p1', summary: 'User Login Flow', step_count: 3, symbol_count: 2 }],
      process_symbols: [
        {
          process_id: 'p1',
          type: 'Function',
          name: 'login',
          filePath: 'src/auth.ts',
          startLine: 10,
        },
        {
          process_id: 'p1',
          type: 'Function',
          name: 'validate',
          filePath: 'src/auth.ts',
          startLine: 20,
        },
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
      definitions: [{ type: 'Interface', name: 'Config', filePath: 'src/types.ts' }],
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
      processes: [{ name: 'Auth Flow', step_index: 2, step_count: 5 }],
    });
    expect(result).toContain('1 execution flow');
    expect(result).toContain('Auth Flow');
  });
});

// ─── formatImpactResult ──────────────────────────────────────────────

describe('formatImpactResult', () => {
  it('returns error message for error input', () => {
    expect(formatImpactResult({ error: 'bad request' })).toContain('Error: bad request');
  });

  it('surfaces per-candidate blast radius for an ambiguous result, never the "isolated" headline (#2129)', () => {
    const result = formatImpactResult({
      status: 'ambiguous',
      target: { name: 'classifyCard' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      maxImpactedCount: 3,
      maxRisk: 'MEDIUM',
      candidates: [
        {
          uid: 'Function:src/sync-logic.ts:classifyCard',
          name: 'classifyCard',
          kind: 'Function',
          filePath: 'src/sync-logic.ts',
          line: 1,
          impactedCount: 3,
          risk: 'MEDIUM',
        },
        {
          uid: 'Function:src/ui-helpers.ts:classifyCard',
          name: 'classifyCard',
          kind: 'Function',
          filePath: 'src/ui-helpers.ts',
          line: 1,
          impactedCount: 1,
          risk: 'LOW',
        },
      ],
    });
    // Must NOT print the false-safe "isolated" headline.
    expect(result).not.toContain('isolated');
    expect(result).toContain('AMBIGUOUS');
    expect(result).toContain('Max blast radius 3');
    // Both candidates + their real counts are visible.
    expect(result).toContain('src/sync-logic.ts');
    expect(result).toContain('[3 upstream');
    expect(result).toContain('--uid');
    // No probe failed here → no lower-bound warning.
    expect(result).not.toContain('candidate probes failed');
  });

  it('warns that the max is a lower bound when a candidate probe failed (#2129 review F1)', () => {
    const result = formatImpactResult({
      status: 'ambiguous',
      target: { name: 'classifyCard' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      maxImpactedCount: 2,
      maxRisk: 'LOW',
      partialProbe: true,
      candidates: [
        {
          uid: 'A',
          name: 'classifyCard',
          kind: 'Function',
          filePath: 'src/a.ts',
          line: 1,
          impactedCount: 2,
          risk: 'LOW',
        },
        {
          uid: 'B',
          name: 'classifyCard',
          kind: 'Function',
          filePath: 'src/b.ts',
          line: 1,
          impactedCount: 0,
          risk: 'UNKNOWN',
        },
      ],
    });
    expect(result).not.toContain('isolated');
    expect(result).toContain('candidate probes failed');
    expect(result).toContain('lower bound');
    // The honest max is still shown.
    expect(result).toContain('Max blast radius 2');
  });

  it('reports the full match count when the candidate list is truncated (#2129 review F11)', () => {
    const result = formatImpactResult({
      status: 'ambiguous',
      target: { name: 'handle' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      maxImpactedCount: 5,
      maxRisk: 'HIGH',
      totalCandidates: 9,
      candidatesTruncated: true,
      candidates: Array.from({ length: 6 }, (_, i) => ({
        uid: `U${i}`,
        name: 'handle',
        kind: 'Function',
        filePath: `src/h${i}.ts`,
        line: 1,
        impactedCount: i,
        risk: 'LOW',
      })),
    });
    // Full count (9), not the truncated array length (6).
    expect(result).toContain('9 symbols');
    expect(result).toContain('showing 6');
  });

  it('shows a plain count when the candidate list is not truncated', () => {
    const result = formatImpactResult({
      status: 'ambiguous',
      target: { name: 'foo' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      maxImpactedCount: 1,
      maxRisk: 'LOW',
      totalCandidates: 2,
      candidates: [
        {
          uid: 'A',
          name: 'foo',
          kind: 'Function',
          filePath: 'src/a.ts',
          line: 1,
          impactedCount: 1,
          risk: 'LOW',
        },
        {
          uid: 'B',
          name: 'foo',
          kind: 'Function',
          filePath: 'src/b.ts',
          line: 1,
          impactedCount: 0,
          risk: 'LOW',
        },
      ],
    });
    expect(result).toContain('2 symbols');
    expect(result).not.toContain('showing');
  });

  it('surfaces the lower-bound boundary note when epistemic is lower-bound (#1858)', () => {
    const result = formatImpactResult({
      target: { kind: 'Class', name: 'EmailLogger' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'LOW',
      epistemic: 'lower-bound',
      boundaries: ['Logger is an interface with 2 implementations; callers bind via DI.'],
      byDepth: {},
    });
    expect(result).not.toContain('isolated');
    expect(result.toLowerCase()).toContain('lower bound');
    expect(result).toContain('Logger is an interface');
  });

  it('returns error with suggestion when provided', () => {
    const result = formatImpactResult({
      error: 'Impact analysis failed',
      suggestion: 'Try gitnexus context <symbol> as a fallback',
    });
    expect(result).toContain('Error: Impact analysis failed');
    expect(result).toContain('Suggestion: Try gitnexus context');
  });

  it('shows partial warning when traversal was interrupted', () => {
    const result = formatImpactResult({
      target: { kind: 'Function', name: 'foo' },
      direction: 'upstream',
      impactedCount: 2,
      partial: true,
      byDepth: {
        1: [
          {
            type: 'Function',
            name: 'caller1',
            filePath: 'src/a.ts',
            relationType: 'CALLS',
            confidence: 1,
          },
          {
            type: 'Function',
            name: 'caller2',
            filePath: 'src/b.ts',
            relationType: 'CALLS',
            confidence: 1,
          },
        ],
      },
    });
    expect(result).toContain('Partial results');
    expect(result).toContain('caller1');
    expect(result).toContain('caller2');
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
          {
            type: 'Function',
            name: 'caller1',
            filePath: 'src/a.ts',
            relationType: 'CALLS',
            confidence: 1,
          },
          {
            type: 'Function',
            name: 'caller2',
            filePath: 'src/b.ts',
            relationType: 'CALLS',
            confidence: 0.8,
          },
        ],
        2: [
          {
            type: 'Class',
            name: 'App',
            filePath: 'src/app.ts',
            relationType: 'IMPORTS',
            confidence: 1,
          },
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
      changed_symbols: [{ type: 'Function', name: 'foo', filePath: 'src/a.ts' }],
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

  it('localizes detect_changes labels for Simplified Chinese', () => {
    vi.stubEnv('GITNEXUS_LANG', 'zh-CN');

    const result = formatDetectChangesResult({
      summary: { changed_files: 2, changed_count: 3, affected_count: 1, risk_level: 'MEDIUM' },
      changed_symbols: [{ type: 'Function', name: 'foo', filePath: 'src/a.ts' }],
      affected_processes: [
        { name: 'Auth Flow', step_count: 5, changed_steps: [{ symbol: 'foo' }] },
      ],
    });

    expect(result).toContain('变更：2 个文件，3 个符号');
    expect(result).toContain('受影响流程：1');
    expect(result).toContain('风险等级：MEDIUM');
    expect(result).toContain('已变更符号：');
    expect(result).toContain('受影响执行流程：');
    expect(result).toContain('Auth Flow (5 步) — 已变更：foo');
  });
});

// ─── formatListReposResult ───────────────────────────────────────────

describe('formatListReposResult', () => {
  it('handles an empty page (no pagination)', () => {
    expect(formatListReposResult({ repositories: [] })).toBe('No indexed repositories.');
  });

  it('formats a repo list (no pagination → no footer)', () => {
    const result = formatListReposResult({
      repositories: [
        {
          name: 'my-project',
          path: '/home/user/my-project',
          indexedAt: '2024-01-01',
          lastCommit: 'abc1234',
          stats: { nodes: 100, edges: 200, processes: 10 },
        },
      ],
    });
    expect(result).toContain('Indexed repositories');
    expect(result).toContain('my-project');
    expect(result).toContain('100 symbols');
    expect(result).not.toContain('Showing'); // no pagination → no footer
  });

  it('formats a paginated { repositories, pagination } result with a continuation footer', () => {
    const result = formatListReposResult({
      repositories: [
        {
          name: 'my-project',
          path: '/home/user/my-project',
          indexedAt: '2024-01-01',
          lastCommit: 'abc1234',
          stats: { nodes: 100, edges: 200, processes: 10 },
        },
      ],
      pagination: { total: 437, limit: 50, offset: 0, returned: 1, hasMore: true, nextOffset: 50 },
    });
    expect(result).toContain('Indexed repositories');
    expect(result).toContain('my-project');
    expect(result).toContain('Showing 1 of 437');
    expect(result).toContain('offset 50'); // continuation hint
  });

  it('formats the final page (hasMore false) without a continuation hint', () => {
    const result = formatListReposResult({
      repositories: [
        {
          name: 'only',
          path: '/p/only',
          indexedAt: '2024-01-01',
          lastCommit: 'abc1234',
          stats: {},
        },
      ],
      pagination: { total: 1, limit: 50, offset: 0, returned: 1, hasMore: false },
    });
    expect(result).toContain('Showing 1 of 1');
    expect(result).not.toContain('More available');
  });

  it('reports an empty page using pagination metadata', () => {
    const result = formatListReposResult({
      repositories: [],
      pagination: { total: 437, limit: 50, offset: 1000, returned: 0, hasMore: false },
    });
    expect(result).toContain('No repositories on this page');
    expect(result).toContain('437');
  });
});
