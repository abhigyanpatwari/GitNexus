import { describe, expect, it } from 'vitest';
import { McpBudgetExceededError } from '../../src/mcp/output-budget.js';
import { fitListsToTokenBudget } from '../../src/mcp/response-list-budget.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** The fitted result is the input plus `trimmedForBudget`, which T can't express. */
const fit = (tool: 'query' | 'context', result: unknown, maxTokens: number, reservedBytes = 0) =>
  fitListsToTokenBudget(tool, result as Record<string, any>, maxTokens, reservedBytes);
const refs = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ uid: `Function:src/${prefix}${i}.ts:${prefix}${i}` }));

const context = {
  status: 'found',
  symbol: { uid: 'Function:src/a.ts:a', name: 'a' },
  epistemic: 'lower-bound',
  incoming: { calls: refs('caller', 30), imports: refs('importer', 3) },
  outgoing: { calls: refs('callee', 20) },
  chain: [{ depth: 1, upstream: refs('up', 15), downstream: refs('down', 15) }],
  staleness: { status: 'current' },
};

describe('fitListsToTokenBudget', () => {
  it('returns the same object when there is no budget or it already fits', () => {
    expect(fitListsToTokenBudget('context', context, undefined)).toBe(context);
    expect(fitListsToTokenBudget('context', context, bytes(context))).toBe(context);
  });

  it('passes through non-object results and backend errors', () => {
    expect(fitListsToTokenBudget('query', 'plain text', 1)).toBe('plain text');
    const error = { error: 'x'.repeat(500) };
    expect(fitListsToTokenBudget('query', error, 1)).toBe(error);
  });

  it('trims the flat results of an @group query', () => {
    const group = {
      group: 'g',
      query: 'auth',
      results: Array.from({ length: 50 }, (_, i) => ({ id: `Process:p${i}`, _repo: 'r' })),
      per_repo: [{ repo: 'r', count: 50 }],
    };
    const fitted = fit('query', group, 120);
    expect(bytes(fitted)).toBeLessThanOrEqual(120 * 4);
    expect(fitted.results.length).toBeGreaterThan(0);
    expect(fitted.results.length).toBeLessThan(50);
    expect(fitted.per_repo).toEqual(group.per_repo);
    expect(fitted.trimmedForBudget.lists.results).toEqual({
      shown: fitted.results.length,
      total: 50,
    });
  });

  it('still finds a larger prefix when completing short lists drops their report entries', () => {
    // Showing 3 items completes the three short lists, which removes their
    // `trimmedForBudget` entries, so a larger prefix fits where a smaller one does not.
    const short = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ uid: `${prefix}${i}` }));
    const mixed = {
      incoming: { a: short('a', 1), b: short('b', 2), c: short('c', 3), d: short('d', 40) },
      staleness: { status: 'current' },
    };
    const fitted = fit('context', mixed, 68);
    expect(bytes(fitted)).toBeLessThanOrEqual(68 * 4);
    expect(fitted.incoming.d).toHaveLength(3);
    expect(fitted.trimmedForBudget.lists).toEqual({ 'incoming.d': { shown: 3, total: 40 } });
  });

  it('keeps the same leading items in every list and the largest prefix that fits', () => {
    const maxTokens = 500;
    const fitted = fit('context', context, maxTokens);
    const kept = fitted.incoming.calls.length;

    expect(bytes(fitted)).toBeLessThanOrEqual(maxTokens * 4);
    expect(kept).toBeGreaterThan(3);
    expect(fitted.incoming.calls).toEqual(context.incoming.calls.slice(0, kept));
    expect(fitted.outgoing.calls).toEqual(context.outgoing.calls.slice(0, kept));
    expect(fitted.chain[0].upstream).toEqual(context.chain[0].upstream.slice(0, kept));
    // Short lists are untouched and not reported.
    expect(fitted.incoming.imports).toEqual(context.incoming.imports);
    expect(fitted.trimmedForBudget.lists).not.toHaveProperty('incoming.imports');
    expect(fitted.trimmedForBudget.lists['incoming.calls']).toEqual({ shown: kept, total: 30 });
    expect(fitted.trimmedForBudget.lists['chain[0].downstream']).toEqual({
      shown: kept,
      total: 15,
    });
    // Everything that is not a list survives as-is.
    expect(fitted.symbol).toEqual(context.symbol);
    expect(fitted.epistemic).toBe('lower-bound');
    expect(fitted.staleness).toEqual(context.staleness);

    // One more item per list, with the same report, would be over budget.
    const longer = (list: unknown[]) => list.slice(0, kept + 1);
    const next = {
      ...context,
      incoming: { calls: longer(context.incoming.calls), imports: context.incoming.imports },
      outgoing: { calls: longer(context.outgoing.calls) },
      chain: [
        {
          ...context.chain[0],
          upstream: longer(context.chain[0].upstream),
          downstream: longer(context.chain[0].downstream),
        },
      ],
      trimmedForBudget: fitted.trimmedForBudget,
    };
    expect(bytes(next)).toBeGreaterThan(maxTokens * 4);
  });

  it('reserves room for text appended after serialization', () => {
    const reserved = 400;
    const fitted = fit('context', context, 500, reserved);
    expect(bytes(fitted) + reserved).toBeLessThanOrEqual(500 * 4);
  });

  it('trims ambiguous candidates', () => {
    const ambiguous = { status: 'ambiguous', candidates: refs('candidate', 50) };
    const fitted = fit('context', ambiguous, 200);
    expect(fitted.candidates.length).toBeLessThan(50);
    expect(fitted.trimmedForBudget.lists.candidates.total).toBe(50);
  });

  it('drops query steps whose flow was trimmed away', () => {
    const query = {
      processes: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}` })),
      process_symbols: Array.from({ length: 24 }, (_, i) => ({
        id: `s${i}`,
        process_id: `p${i % 6}`,
      })),
      definitions: refs('def', 10),
    };
    const fitted = fit('query', query, 120);
    const shown = new Set(fitted.processes.map((p: { id: string }) => p.id));
    expect(shown.size).toBeLessThan(6);
    for (const symbol of fitted.process_symbols) expect(shown.has(symbol.process_id)).toBe(true);
  });

  it('trims the outer chain layers instead of failing when layers are what do not fit', () => {
    const layers = Array.from({ length: 5 }, (_, depth) => ({
      depth: depth + 1,
      upstream: refs(`up${depth}`, 6),
      downstream: refs(`down${depth}`, 6),
    }));
    const deep = { status: 'found', symbol: { uid: 'a' }, chain: layers };
    const fitted = fit('context', deep, 250);
    expect(fitted.chain.length).toBeGreaterThan(0);
    expect(fitted.chain.length).toBeLessThan(5);
    expect(fitted.trimmedForBudget.lists.chain).toEqual({ shown: fitted.chain.length, total: 5 });
    // Lists inside dropped layers are not reported separately.
    expect(
      Object.keys(fitted.trimmedForBudget.lists).every(
        (k) => !/^chain\[[0-9]+\]/.test(k) || Number(k.match(/\d+/)![0]) < fitted.chain.length,
      ),
    ).toBe(true);
  });

  it('joins query steps to flows on repo and id', () => {
    const query = {
      processes: [
        { id: 'p1', _repo: 'a' },
        { id: 'p1', _repo: 'b' },
      ],
      // The step of the dropped flow (repo b) comes first, so an id-only join keeps it.
      process_symbols: [
        { id: 's2', process_id: 'p1', _repo: 'b' },
        { id: 's1', process_id: 'p1', _repo: 'a' },
      ],
      definitions: refs('def', 20),
    };
    const fitted = fit('query', query, 80);
    expect(fitted.processes).toEqual([{ id: 'p1', _repo: 'a' }]);
    expect(fitted.process_symbols).toEqual([{ id: 's1', process_id: 'p1', _repo: 'a' }]);
  });

  it('throws when the result cannot fit even with every list empty', () => {
    expect(() => fitListsToTokenBudget('context', context, 10)).toThrow(McpBudgetExceededError);
    expect(() => fitListsToTokenBudget('query', { payload: 'x'.repeat(400) }, 10)).toThrow(
      McpBudgetExceededError,
    );
  });
});
