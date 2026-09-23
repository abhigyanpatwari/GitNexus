/**
 * Pair-key query attach shaping (#3351).
 *
 * Locks AE1 / AE2 / KTD4 without Ladybug: unique-id first-wins must not return.
 */
import { describe, expect, it } from 'vitest';
import {
  shapeQueryProcessAttaches,
  type QueryProcessAttach,
  type RankedQueryProcess,
} from '../../../src/mcp/local/query-process-attaches.js';

function attach(
  id: string,
  processId: string,
  extras: Record<string, unknown> = {},
): QueryProcessAttach {
  return { id, process_id: processId, ...extras };
}

function ranked(
  id: string,
  symbols: Array<{ id: string; process_id: string } & Record<string, unknown>>,
  extras: Partial<RankedQueryProcess> = {},
): RankedQueryProcess {
  return {
    id,
    label: id,
    priority: 1,
    symbols,
    ...extras,
  };
}

describe('shapeQueryProcessAttaches', () => {
  it('keeps a shared hub under every owning process (AE1)', () => {
    const { processes, process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [attach('func:validate', 'proc:login-flow', { step_index: 2 })]),
        ranked('proc:beta-flow', [attach('func:validate', 'proc:beta-flow', { step_index: 3 })]),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    const pairs = process_symbols
      .filter((s) => s.id === 'func:validate')
      .map((s) => [s.process_id, s.step_index]);
    expect(pairs).toEqual([
      ['proc:login-flow', 2],
      ['proc:beta-flow', 3],
    ]);
    expect(processes.find((p) => p.id === 'proc:login-flow')?.symbol_count).toBe(1);
    expect(processes.find((p) => p.id === 'proc:beta-flow')?.symbol_count).toBe(1);
  });

  it('sets each process symbol_count from emitted attaches, not pre-slice hits (AE2)', () => {
    const hits = Array.from({ length: 40 }, (_, i) =>
      attach(`func:hit-${i}`, 'proc:fat', { step_index: i }),
    );
    const { processes, process_symbols } = shapeQueryProcessAttaches([ranked('proc:fat', hits)], {
      maxSymbolsPerProcess: 25,
    });

    expect(process_symbols).toHaveLength(25);
    expect(process_symbols.every((s) => s.process_id === 'proc:fat')).toBe(true);
    expect(processes[0]?.symbol_count).toBe(25);
  });

  it('keeps the first row when the same pair appears twice (KTD4)', () => {
    const { process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [
          attach('func:validate', 'proc:login-flow', { step_index: 2, content: 'first' }),
          attach('func:validate', 'proc:login-flow', { step_index: 99, content: 'second' }),
        ]),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    const rows = process_symbols.filter((s) => s.id === 'func:validate');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.step_index).toBe(2);
    expect(rows[0]?.content).toBe('first');
  });

  it('keeps include_content on every emitted hub attach (KTD5)', () => {
    const { process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [
          attach('func:validate', 'proc:login-flow', { content: 'function validate() {}' }),
        ]),
        ranked('proc:beta-flow', [
          attach('func:validate', 'proc:beta-flow', { content: 'function validate() {}' }),
        ]),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    expect(process_symbols.map((s) => s.content)).toEqual([
      'function validate() {}',
      'function validate() {}',
    ]);
  });

  it('marks the entry-point hit and preserves process card extras', () => {
    const chain = [{ direction: 'downstream' }];
    const { processes, process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [attach('func:login', 'proc:login-flow')], {
          heuristicLabel: 'User Login',
          processType: 'intra_community',
          stepCount: 2,
          entryPointId: 'func:login',
          priority: 1.23456,
          routes: [{ url: '/login', method: 'POST' }],
        }),
      ],
      { maxSymbolsPerProcess: 25, chainByProcessId: new Map([['proc:login-flow', chain]]) },
    );

    expect(process_symbols[0]?.is_entry_point).toBe(true);
    expect(processes[0]).toMatchObject({
      id: 'proc:login-flow',
      summary: 'User Login',
      priority: 1.235,
      symbol_count: 1,
      process_type: 'intra_community',
      step_count: 2,
      route: '/login',
      method: 'POST',
      chain,
    });
  });
});
