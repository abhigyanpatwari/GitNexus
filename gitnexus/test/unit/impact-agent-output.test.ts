import { describe, expect, it } from 'vitest';
import {
  compactImpactItemProcesses,
  fitImpactToTokenBudget,
  ImpactBudgetExceededError,
  IMPACT_AGENT_DEFAULT_LIMIT,
  impactAgentDefaultLimit,
  shapeImpactForAgent,
  withImpactAgentDefaults,
} from '../../src/mcp/impact-agent-output.js';
import {
  isMissingStaticGatedError,
  withoutStaticGatedColumn,
} from '../../src/mcp/local/local-backend.js';

const symbol = (id: string, processes = 0) => ({
  id,
  name: id,
  filePath: `src/${id}.ts`,
  relationType: 'CALLS',
  confidence: 1,
  processes: Array.from({ length: processes }, (_, i) => ({ id: `proc_${i}`, label: `Flow ${i}` })),
});

const result = (byDepth: Record<string, unknown[]>) => ({
  target: { id: 'Function:src/t.ts:t', name: 't' },
  impactedCount: Object.values(byDepth).reduce((n, items) => n + items.length, 0),
  byDepthCounts: Object.fromEntries(Object.entries(byDepth).map(([d, items]) => [d, items.length])),
  byDepth,
});

describe('impact agent defaults', () => {
  it.each([{ offset: 0 }, { summaryOnly: false }, { offset: 0, summaryOnly: false }])(
    'pages requests with materialized schema defaults: %j',
    (defaults) => {
      expect(withImpactAgentDefaults({ target: 't', ...defaults }, {})).toEqual({
        target: 't',
        ...defaults,
        limit: 30,
      });
    },
  );
  it('adds the default page only when the caller chose no pagination', () => {
    expect(withImpactAgentDefaults({ target: 't' }, {})).toEqual({
      target: 't',
      limit: IMPACT_AGENT_DEFAULT_LIMIT,
    });
    expect(withImpactAgentDefaults({ target: 't', limit: 5 }, {})).toEqual({
      target: 't',
      limit: 5,
    });
    expect(withImpactAgentDefaults({ target: 't', offset: 30 }, {})).toEqual({
      target: 't',
      offset: 30,
    });
    expect(withImpactAgentDefaults({ target: 't', summaryOnly: true }, {})).toEqual({
      target: 't',
      summaryOnly: true,
    });
  });

  it('leaves group and PDG requests alone, which ignore pagination', () => {
    expect(withImpactAgentDefaults({ target: 't', repo: '@group' }, {})).toEqual({
      target: 't',
      repo: '@group',
    });
    expect(withImpactAgentDefaults({ target: 't', mode: 'pdg' }, {})).toEqual({
      target: 't',
      mode: 'pdg',
    });
  });

  it('reads GITNEXUS_IMPACT_DEFAULT_LIMIT, where 0 restores the unpaged result', () => {
    expect(impactAgentDefaultLimit({ GITNEXUS_IMPACT_DEFAULT_LIMIT: '50' })).toBe(50);
    expect(impactAgentDefaultLimit({ GITNEXUS_IMPACT_DEFAULT_LIMIT: '0' })).toBeUndefined();
    expect(
      withImpactAgentDefaults({ target: 't' }, { GITNEXUS_IMPACT_DEFAULT_LIMIT: '0' }),
    ).toEqual({
      target: 't',
    });
    expect(() => impactAgentDefaultLimit({ GITNEXUS_IMPACT_DEFAULT_LIMIT: '-1' })).toThrow();
  });
});

describe('compactImpactItemProcesses', () => {
  it('keeps three processes per symbol and records the full count', () => {
    const out = compactImpactItemProcesses(result({ '1': [symbol('a', 5), symbol('b', 2)] }));
    const [a, b] = out.byDepth['1'] as any[];
    expect(a.processes).toHaveLength(3);
    expect(a.processCount).toBe(5);
    expect(b.processes).toHaveLength(2);
    expect(b).not.toHaveProperty('processCount');
  });

  it('returns results without a symbol list unchanged', () => {
    const ambiguous = { status: 'ambiguous', candidates: [{ uid: 'x' }] };
    expect(compactImpactItemProcesses(ambiguous)).toBe(ambiguous);
  });
});

describe('fitImpactToTokenBudget', () => {
  it('drops whole symbols from the deepest level first and keeps the JSON valid', () => {
    const full = result({
      '1': Array.from({ length: 3 }, (_, i) => symbol(`direct${i}`)),
      '2': Array.from({ length: 40 }, (_, i) => symbol(`indirect${i}`)),
    });
    const maxTokens = 600;
    const fitted = fitImpactToTokenBudget(full, maxTokens) as any;

    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(maxTokens * 4);
    expect(fitted.byDepth['1']).toHaveLength(3);
    expect(fitted.byDepth['2'].length).toBeLessThan(40);
    expect(fitted.byDepthCounts).toEqual({ '1': 3, '2': 40 });
    expect(fitted.pagination).toMatchObject({
      truncated: true,
      trimmedForBudget: { maxTokens, shownByDepth: { '1': 3, '2': fitted.byDepth['2'].length } },
    });
  });

  it('keeps a result that already fits and rejects a budget smaller than its summary', () => {
    const small = result({ '1': [symbol('a')] });
    expect(fitImpactToTokenBudget(small, 10_000)).toBe(small);
    expect(() => fitImpactToTokenBudget(small, 1)).toThrow(ImpactBudgetExceededError);
  });

  it.each([
    { ...result({ '1': [symbol('a')] }), affected_processes: [{ name: 'x'.repeat(10_000) }] },
    { impactedCount: 1, affected_modules: [{ name: 'x'.repeat(10_000) }] },
    { status: 'ambiguous', candidates: [{ name: 'x'.repeat(10_000) }] },
    { group: 'services', local: { payload: 'x'.repeat(10_000) } },
  ])('fails explicitly when non-symbol fields cannot fit (case %#)', (input) => {
    expect(() => fitImpactToTokenBudget(input, 100)).toThrow(ImpactBudgetExceededError);
  });

  it('does not trim one of the two PDG views independently', () => {
    const byDepth = { '1': Array.from({ length: 50 }, (_, i) => symbol(`s${i}`, 5)) };
    const pdg = { ...result(byDepth), mode: 'pdg', interproceduralByDepth: byDepth };
    expect(shapeImpactForAgent(pdg, undefined)).toBe(pdg);
    expect(() => shapeImpactForAgent(pdg, 200)).toThrow(ImpactBudgetExceededError);
  });

  it.each([1, 3, 4, 8, 20, 100])(
    'keeps even a tiny budget error valid JSON (%i tokens)',
    (budget) => {
      const text = new ImpactBudgetExceededError(budget).toJSONText();
      expect(() => JSON.parse(text)).not.toThrow();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget * 4);
      if (budget >= 4) expect(JSON.parse(text)).toHaveProperty('error');
    },
  );

  it('reserves room for text appended after serialization', () => {
    const full = result({ '1': Array.from({ length: 30 }, (_, i) => symbol(`s${i}`)) });
    const withoutReserve = fitImpactToTokenBudget(full, 500) as any;
    const withReserve = fitImpactToTokenBudget(full, 500, 400) as any;
    expect(withReserve.byDepth['1'].length).toBeLessThan(withoutReserve.byDepth['1'].length);
  });

  it('shapeImpactForAgent compacts processes even without a budget', () => {
    const out = shapeImpactForAgent(result({ '1': [symbol('a', 9)] }), undefined) as any;
    expect(out.byDepth['1'][0].processCount).toBe(9);
  });
});

describe('impact walk on indexes without staticGated', () => {
  it('recognises the binder error and reads the column as NULL', () => {
    expect(
      isMissingStaticGatedError(
        new Error('Prepare failed: Binder exception: Cannot find property staticGated for r.'),
      ),
    ).toBe(true);
    expect(isMissingStaticGatedError(new Error('Cannot find property other for r.'))).toBe(false);
    expect(isMissingStaticGatedError('Cannot find property staticGated for r.')).toBe(false);
    expect(
      withoutStaticGatedColumn(
        'RETURN r.confidence AS confidence, r.staticGated AS staticGated LIMIT 5',
      ),
    ).toBe('RETURN r.confidence AS confidence, NULL AS staticGated LIMIT 5');
  });
});
