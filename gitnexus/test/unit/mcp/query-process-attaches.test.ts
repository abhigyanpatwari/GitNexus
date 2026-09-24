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
    expect(process_symbols.map((s) => s.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `func:hit-${i}`),
    );
    expect(process_symbols.every((s) => s.process_id === 'proc:fat')).toBe(true);
    expect(processes[0]?.symbol_count).toBe(25);
  });

  it('keeps pairs that a colon join would collapse', () => {
    const { process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('login-flow', [attach('func:validate:proc', 'login-flow')]),
        ranked('proc:login-flow', [attach('func:validate', 'proc:login-flow')]),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    expect(process_symbols.map((s) => [s.id, s.process_id])).toEqual([
      ['func:validate:proc', 'login-flow'],
      ['func:validate', 'proc:login-flow'],
    ]);
  });

  it('keeps the first row when the same pair appears twice (KTD4)', () => {
    const { processes, process_symbols } = shapeQueryProcessAttaches(
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
    expect(processes[0]?.symbol_count).toBe(1);
  });

  it('keeps include_content only on the first row for a hub id', () => {
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

    expect(process_symbols.map((s) => s.process_id)).toEqual(['proc:login-flow', 'proc:beta-flow']);
    expect(process_symbols[0]?.content).toBe('function validate() {}');
    expect(process_symbols[1]).not.toHaveProperty('content');
  });

  it('strips content from a later entry-point row while flagging it', () => {
    const { process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [
          attach('func:validate', 'proc:login-flow', { content: 'function validate() {}' }),
        ]),
        ranked(
          'proc:beta-flow',
          [attach('func:validate', 'proc:beta-flow', { content: 'function validate() {}' })],
          { entryPointId: 'func:validate' },
        ),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    expect(process_symbols.map((s) => s.process_id)).toEqual(['proc:login-flow', 'proc:beta-flow']);
    expect(process_symbols[0]?.content).toBe('function validate() {}');
    expect(process_symbols[0]).not.toHaveProperty('is_entry_point');
    expect(process_symbols[1]?.is_entry_point).toBe(true);
    expect(process_symbols[1]).not.toHaveProperty('content');
  });

  it('keeps content only on the first of three rows for a hub id', () => {
    const { processes, process_symbols } = shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [
          attach('func:validate', 'proc:login-flow', { content: 'function validate() {}' }),
        ]),
        ranked('proc:beta-flow', [
          attach('func:validate', 'proc:beta-flow', { content: 'function validate() {}' }),
        ]),
        ranked('proc:gamma-flow', [
          attach('func:validate', 'proc:gamma-flow', { content: 'function validate() {}' }),
        ]),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    expect(process_symbols.map((s) => s.process_id)).toEqual([
      'proc:login-flow',
      'proc:beta-flow',
      'proc:gamma-flow',
    ]);
    expect(process_symbols.map((s) => Object.hasOwn(s, 'content'))).toEqual([true, false, false]);
    expect(process_symbols[0]?.content).toBe('function validate() {}');
    expect(processes.map((p) => [p.id, p.symbol_count])).toEqual([
      ['proc:login-flow', 1],
      ['proc:beta-flow', 1],
      ['proc:gamma-flow', 1],
    ]);
  });

  it('does not mutate the input attach objects', () => {
    const first = attach('func:validate', 'proc:login-flow', { content: 'function validate() {}' });
    const second = attach('func:validate', 'proc:beta-flow', { content: 'function validate() {}' });
    const before = structuredClone([first, second]);

    shapeQueryProcessAttaches(
      [
        ranked('proc:login-flow', [first]),
        ranked('proc:beta-flow', [second], { entryPointId: 'func:validate' }),
      ],
      { maxSymbolsPerProcess: 25 },
    );

    expect([first, second]).toEqual(before);
    expect(second.content).toBe('function validate() {}');
    expect(second).not.toHaveProperty('is_entry_point');
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

    const mixed = shapeQueryProcessAttaches(
      [
        ranked(
          'proc:login-flow',
          [attach('func:login', 'proc:login-flow'), attach('func:validate', 'proc:login-flow')],
          { entryPointId: 'func:login' },
        ),
        ranked('proc:beta-flow', [attach('func:login', 'proc:beta-flow')], {
          entryPointId: 'func:beta',
        }),
      ],
      { maxSymbolsPerProcess: 25 },
    );
    const flagged = mixed.process_symbols.filter((s) => s.is_entry_point === true);
    expect(flagged).toEqual([
      expect.objectContaining({ id: 'func:login', process_id: 'proc:login-flow' }),
    ]);
    expect(
      mixed.process_symbols
        .filter((s) => s.is_entry_point !== true)
        .map((s) => [s.id, s.process_id]),
    ).toEqual([
      ['func:validate', 'proc:login-flow'],
      ['func:login', 'proc:beta-flow'],
    ]);
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
