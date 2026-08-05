/**
 * The PDG inter-procedural descent hops through `BasicBlock.calleeIds`, so it
 * can only cross a call boundary that the RESOLVER managed to resolve. Chained
 * receiver calls (`out.inner().compute(x)`) are resolved by the receiver-typing
 * pass, whose resolved ids reach `calleeIds` through a separate sink from the
 * plain-call path — which means the chain could regress there without any
 * plain-call test noticing.
 *
 * This pins the resolver -> PDG seam for a chain: the block holding the chained
 * statement must carry the id of EVERY link, not just the first. The descent's
 * behaviour once the ids are present is covered by impact-pdg-interproc and
 * impact-pdg-fullchain-e2e; what those cannot catch is a chain link silently
 * missing from the column they both read.
 *
 * ── WHAT REACHES THE CELL ─────────────────────────────────────────────────────
 *
 * Measured against this fixture (one repo per shape and all shapes in one repo
 * agree, so the rows do not contaminate each other). Every receiver form now
 * carries its whole chain, whether the receiver's type is declared or inferred:
 *
 *   receiver form                                        calleeIds cell
 *   ---------------------------------------------------  ------------------------
 *   local  `const o = new Outer()`                        Outer.inner + Inner.compute
 *   field  `private p: Outer = new Outer()`               Outer.inner + Inner.compute
 *   field  `private p: Outer;` + ctor `this.p = new ...`  Outer.inner + Inner.compute
 *   receiver is a call result `makeOuter().inner()...`    makeOuter + both links
 *   three links `o.inner().mid().compute()`               all three links
 *   field  `private p = new Outer()`      (INFERRED)      Outer.inner + Inner.compute
 *   field  `private p;` + ctor `this.p = new Outer()`     Outer.inner + Inner.compute
 *
 * The last two rows were EMPTY before #2807 — not a truncated chain, an empty
 * cell, so the descent could not cross into `Outer.inner` either even though
 * that call has a perfectly ordinary named receiver. The cause was upstream of
 * the PDG entirely: an untyped field had no type binding, so the receiver fold
 * declined at its first step and no link was ever resolved to put here. The
 * resolver-level view of the same fact, with the full shape table, lives in
 * `test/integration/resolvers/typescript-inferred-field-receiver.test.ts`.
 *
 * Self-contained fixture rather than an addition to `fixtures/pdg-repo` — that
 * fixture is shared by eight suites including a snapshot test, so growing it to
 * cover one seam churns unrelated expectations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';
// The PRODUCTION reader of the cell: splits on `CALLEE_ID_SEP`
// (src/core/ingestion/cfg/emit.ts) and drops the truncation sentinel. Both the
// statement-precise bridge and the inter-procedural descent go through it, so
// asserting on its output is asserting on exactly the ids the descent sees —
// and it yields whole ids, which a substring match over the raw cell would not.
import { splitCalleeIds } from '../../../src/mcp/local/pdg-impact.js';

const FIXTURE_PATH = 'src/app.ts';

// Every caller below chains `.compute()` onto the RESULT of `.inner()`; the
// second call has no named receiver, so it resolves only if the receiver's type
// is carried through the chain. Only the receiver FORM varies between rows.
const CHAINED_SOURCE = `export class Mid {
  compute(v: number): number {
    return v * 3;
  }
}

export class Inner {
  compute(v: number): number {
    return v * 2;
  }
  mid(): Mid {
    return new Mid();
  }
}

export class Outer {
  inner(): Inner {
    return new Inner();
  }
}

export function makeOuter(): Outer {
  return new Outer();
}

export function runLocalConst(x: number): number {
  const localConst = new Outer();
  const r = localConst.inner().compute(x);
  return r;
}

export function runCallResultReceiver(x: number): number {
  const r = makeOuter().inner().compute(x);
  return r;
}

export function runThreeLink(x: number): number {
  const threeLink = new Outer();
  const r = threeLink.inner().mid().compute(x);
  return r;
}

export class AnnotatedFieldCaller {
  private annotated: Outer = new Outer();
  run(x: number): number {
    const r = this.annotated.inner().compute(x);
    return r;
  }
}

export class InferredFieldCaller {
  private inferred = new Outer();
  run(x: number): number {
    const r = this.inferred.inner().compute(x);
    return r;
  }
}

export class CtorAssignedAnnotatedCaller {
  private ctorTyped: Outer;
  constructor() {
    this.ctorTyped = new Outer();
  }
  run(x: number): number {
    const r = this.ctorTyped.inner().compute(x);
    return r;
  }
}

export class CtorAssignedInferredCaller {
  private ctorUntyped;
  constructor() {
    this.ctorUntyped = new Outer();
  }
  run(x: number): number {
    const r = this.ctorUntyped.inner().compute(x);
    return r;
  }
}
`;

// EXACT resolved ids — never substrings. `Inner.compute` as a substring is also
// satisfied by `Inner.computeExtra` and by `OtherInner.compute`, while the
// descent keys on the whole id for its span and CALL_SUMMARY lookups. The `#N`
// suffix is the arity disambiguator the resolver mints.
const OUTER_INNER = `Method:${FIXTURE_PATH}:Outer.inner#0`;
const INNER_COMPUTE = `Method:${FIXTURE_PATH}:Inner.compute#1`;
const INNER_MID = `Method:${FIXTURE_PATH}:Inner.mid#0`;
const MID_COMPUTE = `Method:${FIXTURE_PATH}:Mid.compute#1`;
const MAKE_OUTER = `Function:${FIXTURE_PATH}:makeOuter`;

/** Every link's id lands in the cell. The only value today — the
 *  inference-typed rows joined it in #2807 — but kept as a named type so a
 *  future gap row has somewhere to say so instead of being a bare boolean. */
type ChainResolution = 'reaches-pdg';

interface ReceiverShape {
  /** Row name; also the assertion key in the diff when a row moves. */
  readonly name: string;
  /** Unique fragment of the chained statement, used to find its block. */
  readonly marker: string;
  /** Every link of the chain, as an exact resolved id. */
  readonly links: readonly string[];
  readonly resolution: ChainResolution;
}

const RECEIVER_SHAPES: readonly ReceiverShape[] = [
  {
    name: 'local-const',
    marker: 'localConst.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
  {
    name: 'annotated-field',
    marker: 'this.annotated.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
  {
    name: 'ctor-assigned-annotated',
    marker: 'this.ctorTyped.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
  {
    name: 'call-result-receiver',
    marker: 'makeOuter().inner().compute(',
    links: [MAKE_OUTER, OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
  {
    name: 'three-link-chain',
    marker: 'threeLink.inner().mid().compute(',
    links: [OUTER_INNER, INNER_MID, MID_COMPUTE],
    resolution: 'reaches-pdg',
  },
  // ── Inference-typed fields (#2807) ────────────────────────────────────────
  // Identical to the two annotated rows above except that the field declares no
  // type, so its type comes from the initializer. Both emitted an EMPTY cell
  // until #2807 — the descent could not cross even `Outer.inner`, a plainly
  // named receiver call.
  {
    name: 'inferred-field',
    marker: 'this.inferred.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
  {
    name: 'ctor-assigned-inferred',
    marker: 'this.ctorUntyped.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'reaches-pdg',
  },
];

interface BlockCell {
  readonly text: string;
  readonly ids: readonly string[];
}

const repos = createTempDirPool('gn-pdg-chain-');
let blocks: readonly BlockCell[] = [];

function blocksFor(marker: string): readonly BlockCell[] {
  return blocks.filter((b) => b.text.includes(marker));
}

function idsFor(marker: string): readonly string[] {
  const matched = blocksFor(marker);
  // Exactly one block spans each chained statement; a fixture drift that split
  // or dropped it would otherwise make the id assertions vacuous.
  expect(matched).toHaveLength(1);
  return matched[0].ids;
}

/** The behaviour a `reaches-pdg` row has today. */
function assertChainReachesPdg(shape: ReceiverShape): void {
  const ids = idsFor(shape.marker);
  // Non-empty first: an unresolvable receiver drops EVERY link, so this
  // separates "the chained link regressed" from "the whole cell went away".
  expect(ids).not.toHaveLength(0);
  expect(ids).toEqual(expect.arrayContaining([...shape.links]));
}

describe('PDG calleeIds — chained receiver calls by receiver form (#2802 follow-up)', () => {
  beforeAll(async () => {
    const dir = repos.dir();
    fs.mkdirSync(path.join(dir, path.dirname(FIXTURE_PATH)));
    fs.writeFileSync(path.join(dir, FIXTURE_PATH), CHAINED_SOURCE);

    const result = await runPipelineFromRepo(dir, () => {}, { pdg: true });
    const collected: BlockCell[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'BasicBlock') return;
      collected.push({
        text: typeof n.properties.text === 'string' ? n.properties.text : '',
        ids: splitCalleeIds(n.properties.calleeIds),
      });
    });
    blocks = collected;
  }, 180000);

  it('every receiver shape contributes exactly one chained-call block', () => {
    const counts = Object.fromEntries(
      RECEIVER_SHAPES.map((s) => [s.name, blocksFor(s.marker).length]),
    );
    expect(counts).toEqual(Object.fromEntries(RECEIVER_SHAPES.map((s) => [s.name, 1])));
  });

  for (const shape of RECEIVER_SHAPES.filter((s) => s.resolution === 'reaches-pdg')) {
    it(`${shape.name}: every chain link's exact id reaches calleeIds`, () => {
      assertChainReachesPdg(shape);
    });
  }

  // The inference-typed rows are asserted as a SET, in one assertion, on top of
  // their per-row checks above: #2807's signature was that both of them emptied
  // together, so a regression that reopened the gap for only one shape has to
  // show up as a diff here rather than as a single quiet row failure.
  it('both inference-typed receivers carry the whole chain, not just the first link', () => {
    const inferred = ['inferred-field', 'ctor-assigned-inferred'] as const;
    const observed = Object.fromEntries(
      inferred.map((name) => {
        const shape = RECEIVER_SHAPES.find((s) => s.name === name);
        if (shape === undefined) throw new Error(`fixture drift: no row named ${name}`);
        return [name, [...idsFor(shape.marker)].sort()];
      }),
    );
    expect(observed).toEqual({
      'inferred-field': [INNER_COMPUTE, OUTER_INNER].sort(),
      'ctor-assigned-inferred': [INNER_COMPUTE, OUTER_INNER].sort(),
    });
  });
});
