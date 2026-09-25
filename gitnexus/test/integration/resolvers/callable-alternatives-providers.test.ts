/**
 * Callable chosen by a value-selecting expression, per provider (#3354).
 *
 * The shared branch expansion in `callable-flow-captures.ts` keys on tree-sitter
 * field names (`left`/`operator`/`right`, `condition`/`consequence`/
 * `alternative`). Grammars that spell `??` / `?:` / elvis / ternary without
 * those fields supply their branches through the `valueAlternatives` provider
 * hook; without it only the LAST operand flowed and `impact` under-reported
 * callers while still claiming `epistemic: "exact"`. Ruby's statement-bodied
 * `if` shares the ternary's field names but its branches are statement lists,
 * so its hook only expands single-statement branches and skips the rest.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const runFixture = (name: string): Promise<PipelineResult> =>
  runPipelineFromRepo(path.join(FIXTURES, name), () => {});

// Only flow edges count: Kotlin's `::fn` reference alone already yields a
// `local-call` edge to fn, which would make its assertions vacuous.
const callsOf = (result: PipelineResult): string[] =>
  edgeSet(
    getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'callable-value-flow'),
  );

describe('Python callable chosen by `or` / `x if c else y`', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runFixture('python-callable-alternatives');
  }, 60000);

  it('`override or fn` reaches fn', () => {
    expect(callsOf(result)).toContain('logical_or → run_sweep');
  });

  it('`f if c else g` reaches both branches', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['ternary → run_then', 'ternary → run_else']),
    );
  });
});

describe('Kotlin callable chosen by `?:` / `if` expression', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runFixture('kotlin-callable-alternatives');
  }, 60000);

  it('`override ?: ::fn` reaches fn', () => {
    expect(callsOf(result)).toContain('elvis → runSweep');
  });

  it('`if (c) ::f else ::g` reaches both branches', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['ifExpression → runThen', 'ifExpression → runElse']),
    );
  });

  // A braced branch nests its value in a `statements` node one level below
  // the `control_structure_body` wrapper.
  it('`if (c) { ::f } else { ::g }` reaches both branches', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['braced → runBracedThen', 'braced → runBracedElse']),
    );
  });

  it('a multi-statement branch keeps the whole `if` opaque', () => {
    expect(callsOf(result).filter((edge) => edge.startsWith('multiStatement →'))).toEqual([]);
  });
});

describe('Swift callable chosen by `??` / `?:`', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runFixture('swift-callable-alternatives');
  }, 60000);

  it('`override ?? fn` reaches fn', () => {
    expect(callsOf(result)).toContain('nilCoalescing → runSweep');
  });

  it('`c ? f : g` reaches both branches', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['ternary → runThen', 'ternary → runElse']),
    );
  });
});

describe('Dart callable chosen by `??` / `?:`', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runFixture('dart-callable-alternatives');
  }, 60000);

  it('`override ?? fn` reaches fn', () => {
    expect(callsOf(result)).toContain('ifNull → runSweep');
  });

  it('`c ? f : g` reaches both branches', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['conditional → runThen', 'conditional → runElse']),
    );
  });
});

describe('Ruby statement-bodied `if` as a callable source', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runFixture('ruby-callable-alternatives');
  }, 60000);

  it('single-statement branches each reach their callable', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['single_statement_if → run_then', 'single_statement_if → run_else']),
    );
  });

  it('an identifier read inside a multi-statement branch does not flow into the binding', () => {
    expect(callsOf(result)).not.toContain('statement_if → run_other');
  });

  it('a multi-statement branch is skipped while its sibling branch still flows', () => {
    expect(callsOf(result)).toContain('statement_if → run_sweep');
  });

  it('a multi-statement `elsif` does not hide the branches around it', () => {
    expect(callsOf(result)).toEqual(
      expect.arrayContaining(['elsif_chain → run_a', 'elsif_chain → run_b']),
    );
    expect(callsOf(result)).not.toContain('elsif_chain → run_inner');
  });
});
