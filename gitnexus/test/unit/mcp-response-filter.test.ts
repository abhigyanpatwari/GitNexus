import { describe, expect, it } from 'vitest';
import {
  applyMcpResponseFilter,
  resolveMcpResponseFilter,
  withoutMcpResponseFilterArgs,
} from '../../src/mcp/response-filter.js';

const context = {
  status: 'found',
  symbol: { uid: 'Function:src/pay.ts:pay', name: 'pay', content: 'function pay() {}' },
  incoming: {
    calls: [{ uid: 'Function:src/buy.ts:buy' }],
    uses: [{ uid: 'Variable:src/ui.ts:onBuy' }],
  },
  outgoing: { calls: [{ uid: 'Function:src/db.ts:save' }], imports: [{ uid: 'File:src/db.ts' }] },
  processes: [{ id: 'process:checkout', name: 'Checkout' }],
  routes: [{ url: '/pay', method: 'POST' }],
  chain: [{ depth: 1, upstream: [{ uid: 'Function:src/buy.ts:buy' }] }],
  typed_properties: [{ uid: 'Property:src/pay.ts:currency' }],
  epistemic: 'lower-bound',
  boundaries: ['Dynamic dispatch is unresolved'],
  causes: { callableValueReferences: 1 },
  warning: 'Source extraction incomplete',
  partial: true,
  truncated: true,
  risk: 'UNKNOWN',
  riskNote: 'Not a safety verdict',
  staleness: { status: 'behind', lastCommit: 'abc' },
  futureCompletenessSignal: { incomplete: true },
};

describe('opt-in MCP response filters', () => {
  it('leaves omitted options and default output identical, including object identity', () => {
    const args = { uid: context.symbol.uid };
    const filter = resolveMcpResponseFilter('context', args);
    expect(filter).toBeUndefined();
    expect(withoutMcpResponseFilterArgs(args, filter)).toBe(args);
    expect(applyMcpResponseFilter(context, filter)).toBe(context);
  });

  it('returns exact selected evidence with identity, source and all safety metadata intact', () => {
    const before = JSON.stringify(context);
    const filter = resolveMcpResponseFilter('context', {
      response_sections: ['incoming'],
      relationTypes: ['CALLS'],
    });
    const result = applyMcpResponseFilter(context, filter) as typeof context & {
      response_filter: unknown;
    };
    expect(result.incoming).toEqual({ calls: context.incoming.calls });
    expect(result.symbol).toEqual(context.symbol);
    for (const key of [
      'epistemic',
      'boundaries',
      'causes',
      'warning',
      'partial',
      'truncated',
      'risk',
      'riskNote',
      'staleness',
      'futureCompletenessSignal',
    ] as const) {
      expect(result[key]).toEqual(context[key]);
    }
    for (const key of ['outgoing', 'processes', 'routes', 'chain', 'typed_properties']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result.response_filter).toMatchObject({
      sections: ['incoming'],
      relationTypes: ['CALLS'],
      omitted_relations: { incoming: ['uses'] },
    });
    expect(JSON.stringify(context)).toBe(before);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('distinguishes an empty selected category from an unfiltered absence', () => {
    const result = applyMcpResponseFilter(
      context,
      resolveMcpResponseFilter('context', {
        response_sections: ['incoming'],
        relationTypes: ['EXTENDS'],
      }),
    );
    expect(result).toMatchObject({
      incoming: {},
      epistemic: 'lower-bound',
      response_filter: { omitted_relations: { incoming: ['calls', 'uses'] } },
    });
  });

  it('filters only reference categories, leaving an explicitly requested chain unchanged', () => {
    const result = applyMcpResponseFilter(
      context,
      resolveMcpResponseFilter('context', {
        relationTypes: ['USES'],
      }),
    ) as typeof context;
    expect(result.incoming).toEqual({ uses: context.incoming.uses });
    expect(result.chain).toBe(context.chain);
    expect(result.processes).toBe(context.processes);
  });

  it('preserves selected process attachments, duplicate memberships and definitions exactly', () => {
    const query = {
      processes: [
        { id: 'proc:one', symbol_count: 1 },
        { id: 'proc:two', symbol_count: 1 },
      ],
      process_symbols: [
        { id: 'Function:src/pay.ts:pay', process_id: 'proc:one', content: 'source' },
        { id: 'Function:src/pay.ts:pay', process_id: 'proc:two' },
      ],
      definitions: [{ id: 'Interface:src/pay.ts:Payment' }],
      warning: 'keyword-only',
    };
    const result = applyMcpResponseFilter(
      query,
      resolveMcpResponseFilter('query', {
        response_sections: ['process_symbols', 'definitions'],
      }),
    );
    expect(result).toMatchObject({
      process_symbols: query.process_symbols,
      definitions: query.definitions,
      warning: query.warning,
      response_filter: { omitted_sections: ['processes'] },
    });
    expect(result).not.toHaveProperty('processes');
    expect(query.processes).toHaveLength(2);
  });

  it.each([
    { error: 'not found' },
    { status: 'ambiguous', candidates: [{ uid: 'a' }], totalCandidates: 1 },
    { status: 'not_found' },
    'backend error',
    null,
  ])('does not hide errors or ambiguity: %j', (value) => {
    expect(
      applyMcpResponseFilter(
        value,
        resolveMcpResponseFilter('context', {
          response_sections: ['incoming'],
        }),
      ),
    ).toBe(value);
  });

  it.each([
    null,
    [],
    'incoming',
    ['risk'],
    ['incoming', null],
    ['__proto__'],
    Array(100).fill('incoming'),
  ])('rejects malformed section filters: %j', (value) => {
    expect(() => resolveMcpResponseFilter('context', { response_sections: value })).toThrow(
      /response_sections/,
    );
  });
  it.each([null, [], ['calls'], ['MISSING'], ['CALLS', 1]])(
    'rejects invalid relations: %j',
    (value) => {
      expect(() => resolveMcpResponseFilter('context', { relationTypes: value })).toThrow(
        /relationTypes/,
      );
    },
  );
  it('rejects conflicting filters and unsupported group routing', () => {
    expect(() =>
      resolveMcpResponseFilter('context', {
        response_sections: ['processes'],
        relationTypes: ['CALLS'],
      }),
    ).toThrow(/requires incoming or outgoing/);
    for (const repo of ['@group', '@group/member']) {
      expect(() =>
        resolveMcpResponseFilter('query', { repo, response_sections: ['definitions'] }),
      ).toThrow(/single indexed repository/);
    }
  });
  it('strips only the filter arguments and leaves existing impact relationTypes alone', () => {
    const args = {
      uid: 'a',
      response_sections: ['incoming'],
      relationTypes: ['CALLS'],
      maxTokens: 1000,
    };
    expect(withoutMcpResponseFilterArgs(args, resolveMcpResponseFilter('context', args))).toEqual({
      uid: 'a',
      maxTokens: 1000,
    });
    const impact = { target: 'a', relationTypes: ['CALLS'] };
    expect(withoutMcpResponseFilterArgs(impact, resolveMcpResponseFilter('impact', impact))).toBe(
      impact,
    );
    expect(args.relationTypes).toEqual(['CALLS']);
  });
});
