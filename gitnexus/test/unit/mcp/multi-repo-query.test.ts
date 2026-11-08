import { describe, expect, it } from 'vitest';
import {
  mergeRepositoryQueries,
  parseQueryRepositories,
  type RepositoryQueryResult,
} from '../../../src/mcp/local/multi-repo-query.js';
import { SYMBOL_IDENTITY_RECOVERY_SUGGESTION } from '../../../src/mcp/local/query-result-integrity.js';

const options = { limit: 10, maxSymbols: 25, includeContent: true };
function member(
  repo: string,
  overrides: RepositoryQueryResult['result'] = {},
): RepositoryQueryResult {
  return {
    repo,
    name: repo,
    result: {
      processes: [{ id: 'process', priority: 1, symbol_count: 1 }],
      process_symbols: [{ id: 'symbol', process_id: 'process', content: `source:${repo}` }],
      definitions: [{ id: 'type' }],
      ...overrides,
    },
  };
}
function merged(members: RepositoryQueryResult[], overrides = {}) {
  const result = mergeRepositoryQueries(members, { ...options, ...overrides });
  if (!('processes' in result)) throw new Error(result.error);
  return result;
}

describe('query repository list validation', () => {
  it('trims names and paths without deduplicating unresolved selectors', () => {
    expect(parseQueryRepositories([' alpha ', '/repos/alpha', 'alpha'])).toEqual([
      'alpha',
      '/repos/alpha',
      'alpha',
    ]);
  });
  it.each([
    { name: 'empty list', value: [] },
    { name: 'empty selector', value: [''] },
    { name: 'blank selector', value: ['   '] },
    { name: 'numeric selector', value: [1] },
    { name: 'nested list', value: [['a']] },
    { name: 'mixed selector types', value: ['a', null] },
    { name: 'group selector', value: ['@group'] },
    { name: 'padded subgroup selector', value: [' @group/a '] },
    { name: 'eleven selectors', value: Array(11).fill('a') },
    { name: 'scalar selector', value: 'a' },
    { name: 'null selection', value: null },
  ])('rejects malformed or unsupported selection: $name', ({ value }) => {
    expect(() => parseQueryRepositories(value)).toThrow(/query.repo/);
  });
  it('accepts ten selectors', () =>
    expect(parseQueryRepositories(Array(10).fill('a'))).toHaveLength(10));
});

describe('multi-repository query merge', () => {
  it('keeps colliding local identities and valid per-repository joins', () => {
    const result = merged([member('/b'), member('/a')]);
    expect(result.repos).toEqual(['/a', '/b']);
    expect(result.processes.map((p) => [p._repo, p.id, p.symbol_count])).toEqual([
      ['/a', 'process', 1],
      ['/b', 'process', 1],
    ]);
    expect(result.process_symbols.map((s) => [s._repo, s.id, s.process_id, s.content])).toEqual([
      ['/a', 'symbol', 'process', 'source:/a'],
      ['/b', 'symbol', 'process', 'source:/b'],
    ]);
    expect(result.definitions).toHaveLength(2);
  });
  it('merges local ranks deterministically and limits processes globally', () => {
    const a = member('/a', { processes: [{ id: 'first' }, { id: 'second', priority: 999 }] });
    const b = member('/b');
    expect(merged([a, b], { limit: 2 })).toEqual(merged([b, a], { limit: 2 }));
    expect(merged([a, b], { limit: 2 }).processes.map((p) => [p._repo, p.id])).toEqual([
      ['/a', 'first'],
      ['/b', 'process'],
    ]);
  });
  it('keeps shared symbols under each process but sends source only once', () => {
    const result = merged(
      [
        member('/a', {
          processes: [{ id: 'one' }, { id: 'two' }],
          process_symbols: [
            { id: 'hub', process_id: 'one', content: 'body' },
            { id: 'hub', process_id: 'two' },
            { id: 'hub', process_id: 'two' },
            { id: 'extra', process_id: 'two' },
          ],
        }),
      ],
      { maxSymbols: 1 },
    );
    expect(result.process_symbols.map((s) => [s.id, s.process_id, s.content])).toEqual([
      ['hub', 'one', 'body'],
      ['hub', 'two', undefined],
    ]);
    expect(result.processes.map((p) => p.symbol_count)).toEqual([1, 1]);
  });
  it('recovers a preview from a process dropped by the global limit', () => {
    const result = merged(
      [
        member('/a', {
          processes: [{ id: 'kept' }, { id: 'dropped' }],
          process_symbols: [
            { id: 'hub', process_id: 'dropped', content: 'preview', content_truncated: true },
            { id: 'hub', process_id: 'kept' },
          ],
        }),
      ],
      { limit: 1 },
    );
    expect(result.process_symbols).toEqual([
      { id: 'hub', process_id: 'kept', _repo: '/a', content: 'preview', content_truncated: true },
    ]);
  });
  it('uses collision-safe repository and symbol tuple keys', () => {
    const result = merged([
      member('/a:extra', { definitions: [{ id: 'type', content: 'first' }] }),
      member('/a', { definitions: [{ id: 'extra:type', content: 'second' }] }),
    ]);
    expect(result.definitions.map((d) => d.content).sort()).toEqual(['first', 'second']);
  });
  it('caps definitions at twenty globally and reports returned counts', () => {
    const definitions = Array.from({ length: 20 }, (_, i) => ({ id: `type${i}` }));
    const result = merged([member('/a', { definitions }), member('/b', { definitions })]);
    expect(result.definitions).toHaveLength(20);
    expect(result.per_repo.map((r) => r.returned.definitions)).toEqual([10, 10]);
    expect(result.per_repo.map((r) => r.candidates.definitions)).toEqual([20, 20]);
  });
  it('shares one content budget, preserves truncation and avoids broken Unicode', () => {
    const members = Array.from({ length: 10 }, (_, i) =>
      member(`/repo${i}`, {
        process_symbols: [{ id: 'symbol', process_id: 'process', content: '😀'.repeat(10000) }],
      }),
    );
    const result = merged(members);
    const rows = [...result.process_symbols, ...result.definitions];
    expect(
      rows.reduce((n, row) => n + (typeof row.content === 'string' ? row.content.length : 0), 0),
    ).toBeLessThanOrEqual(16000);
    for (const row of result.process_symbols) {
      expect(row.content_truncated).toBe(true);
      expect(String(row.content)).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });
  it.each([160, 200])(
    'omits empty previews at the content-budget boundary (%i symbols per process)',
    (count) => {
      const result = merged(
        [
          member('/large', {
            processes: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` })),
            process_symbols: Array.from({ length: 100 * count }, (_, i) => ({
              id: `s${i}`,
              process_id: `p${Math.floor(i / count)}`,
              content: '😀',
            })),
            definitions: [],
          }),
        ],
        { limit: 100, maxSymbols: count },
      );
      expect(result.process_symbols).toHaveLength(100 * count);
      expect(result.process_symbols.some((row) => Object.hasOwn(row, 'content'))).toBe(false);
      expect(result.process_symbols.every((row) => row.content_truncated === true)).toBe(true);
    },
  );

  it('does not invent unavailable source and strips previews when not requested', () => {
    const a = member('/a');
    const b = member('/b', {
      process_symbols: [{ id: 'symbol', process_id: 'process' }],
      contentAvailability: { available: false },
    });
    expect(merged([a, b]).process_symbols.find((s) => s._repo === '/b')).not.toHaveProperty(
      'content',
    );
    expect(merged([a], { includeContent: false }).process_symbols[0]).not.toHaveProperty('content');
    expect(a.result.process_symbols![0].content).toBe('source:/a');
  });
  it('distinguishes failed, empty and degraded repositories and preserves metadata', () => {
    const result = merged([
      member('/failed', {
        error: 'unavailable',
        processes: [],
        definitions: [],
        process_symbols: [],
      }),
      member('/empty', {
        processes: [],
        definitions: [],
        process_symbols: [],
        staleness: { status: 'current' },
      }),
      member('/partial', { partial: true, warning: 'keyword lane degraded', timing: { wall: 4 } }),
    ]);
    expect(result.partial).toBe(true);
    expect(result.processes).toHaveLength(1);
    expect(result.per_repo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: '/failed', status: 'error', error: 'unavailable' }),
        expect.objectContaining({ repo: '/empty', status: 'ok', staleness: { status: 'current' } }),
        expect.objectContaining({
          repo: '/partial',
          partial: true,
          warning: 'keyword lane degraded',
          timing: { wall: 4 },
        }),
      ]),
    );
  });
  it('marks warning-only semantic degradation as partial without discarding keyword hits', () => {
    const warning = 'Semantic search unavailable: embedding provider is not configured.';
    const result = merged([member('/healthy'), member('/degraded', { warning })]);
    expect(result.partial).toBe(true);
    expect(result.processes.map((row) => row._repo)).toEqual(['/degraded', '/healthy']);
    expect(result.per_repo).toContainEqual(
      expect.objectContaining({ repo: '/degraded', status: 'ok', warning }),
    );
  });
  it('does not treat unavailable retained source or an empty warning as degraded search', () => {
    const result = merged([
      member('/symbol-only', { contentAvailability: { available: false }, warning: '' }),
    ]);
    expect(result.partial).toBe(false);
  });
  it('returns a complete empty result when every member searched successfully', () => {
    expect(
      merged([member('/empty', { processes: [], definitions: [], process_symbols: [] })]),
    ).toMatchObject({ processes: [], process_symbols: [], definitions: [], partial: false });
  });
  it('returns an error if every member failed', () => {
    expect(mergeRepositoryQueries([member('/bad', { error: 'offline' })], options)).toMatchObject({
      error: expect.any(String),
      partial: true,
      per_repo: [expect.objectContaining({ error: 'offline' })],
    });
  });
  it('fails the aggregate on symbol-identity corruption without publishing hits', () => {
    const result = mergeRepositoryQueries(
      [
        member('/a'),
        member('/corrupt', {
          error: 'invalid id',
          recoverySuggestion: SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
        }),
      ],
      options,
    );
    expect(result).toMatchObject({
      error: 'invalid id',
      recoverySuggestion: SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
    });
    expect(result).not.toHaveProperty('processes');
  });
});
