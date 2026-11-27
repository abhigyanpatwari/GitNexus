import type * as SafeParseModule from '../../src/core/tree-sitter/safe-parse.js';

/**
 * Counts parses per event-loop turn, for tests that check a parse loop yields
 * a macrotask every `PARSES_PER_RELEASE` parses.
 *
 * Usage (the mock factory must import this helper dynamically; `vi.mock` is
 * hoisted above static imports):
 *
 *   vi.mock('<path>/src/core/tree-sitter/safe-parse.js', async (importOriginal) => {
 *     const { recordParseTurns } = await import('<path>/helpers/event-loop-turns.js');
 *     return recordParseTurns(await importOriginal());
 *   });
 */
export const turnProbe = {
  turn: 0,
  parseTurns: [] as number[],
  /** Sources for which the recorded parse throws, as a timed-out parse does. */
  failParse: null as ((source: string) => boolean) | null,
};

/** `safe-parse` with a pass-through `parseSourceSafe` that records each parse's turn. */
export function recordParseTurns<T extends Pick<typeof SafeParseModule, 'parseSourceSafe'>>(
  actual: T,
) {
  return {
    ...actual,
    parseSourceSafe: (...args: Parameters<typeof actual.parseSourceSafe>) => {
      turnProbe.parseTurns.push(turnProbe.turn);
      if (turnProbe.failParse?.(args[1])) throw new Error('parse failed (test)');
      return actual.parseSourceSafe(...args);
    },
  };
}

/** Run `fn` while a self-rescheduling `setImmediate` numbers event-loop turns. */
export async function countingTurns<T>(fn: () => Promise<T>): Promise<T> {
  turnProbe.turn = 0;
  turnProbe.parseTurns = [];
  let running = true;
  const tick = (): void => {
    if (!running) return;
    turnProbe.turn += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    return await fn();
  } finally {
    running = false;
    turnProbe.failParse = null;
  }
}

/** Most parses that ran inside one event-loop turn of the last `countingTurns`. */
export function maxParsesPerTurn(): number {
  const perTurn = new Map<number, number>();
  for (const turn of turnProbe.parseTurns) perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
  return Math.max(0, ...perTurn.values());
}
