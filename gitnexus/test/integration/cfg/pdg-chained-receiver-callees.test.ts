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
 * ── WHERE THE SUPPORT ACTUALLY STOPS ──────────────────────────────────────────
 *
 * Chained resolution is NOT general. Measured against this fixture (one repo per
 * shape and all shapes in one repo agree, so the rows do not contaminate each
 * other), the discriminator is whether the receiver's type is DECLARED, not
 * whether it is a local or a field:
 *
 *   receiver form                                        calleeIds cell
 *   ---------------------------------------------------  ------------------------
 *   local  `const o = new Outer()`                        Outer.inner + Inner.compute
 *   field  `private p: Outer = new Outer()`               Outer.inner + Inner.compute
 *   field  `private p: Outer;` + ctor `this.p = new ...`  Outer.inner + Inner.compute
 *   receiver is a call result `makeOuter().inner()...`    makeOuter + both links
 *   three links `o.inner().mid().compute()`               all three links
 *   field  `private p = new Outer()`      (INFERRED)      EMPTY  <- known gap
 *   field  `private p;` + ctor `this.p = new Outer()`     EMPTY  <- known gap
 *
 * An inference-typed receiver does not merely lose the CHAINED link — it empties
 * the whole cell, so the descent cannot cross into `Outer.inner` either, even
 * though that call has a perfectly ordinary named receiver. Those two rows are
 * pinned by `KNOWN GAP: an inference-typed receiver empties the WHOLE calleeIds
 * cell` below, which asserts the current empty value EXACTLY.
 *
 * ── THIS PIN IS SELF-DIFFING: IT WILL GO RED ON PURPOSE ───────────────────────
 *
 * The gap is tracked as issue #2807 ("Inference-typed field receivers resolve to
 * no CALLS edges at all"); PR #2810 is open against it at the time of writing.
 * The `KNOWN GAP` test asserts that the gap EXISTS — the empty cell, exactly —
 * so it is not a regression guard, it is a record. Whoever closes #2807 will see
 * it fail with the newly resolved ids in the diff; that is the intended signal,
 * and the fix is to update this file (the table above, the rows' `resolution`,
 * and the pin's expected value), not to relax the assertion. A single-shape
 * fixture, or an `it.fails` row, would instead have kept quietly implying that
 * chained receivers work in general.
 *
 * The gap was FOUND during #2802 work but is PRE-EXISTING and independent of it:
 * nothing on that branch touches receiver typing. Track the gap itself at #2807.
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

/**
 * `reaches-pdg` — every link's id lands in the cell today.
 * `known-gap-empty-cell` — the resolver cannot type the receiver, so the cell is
 * emitted EMPTY and the descent cannot cross ANY link of the chain.
 */
type ChainResolution = 'reaches-pdg' | 'known-gap-empty-cell';

interface ReceiverShape {
  /** Row name; also the key of the known-gap pin below. */
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
  // ── Known gaps ────────────────────────────────────────────────────────────
  // Identical to the two rows above except that the field has no type
  // annotation, so its type would have to be inferred from the initializer.
  {
    name: 'inferred-field',
    marker: 'this.inferred.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'known-gap-empty-cell',
  },
  {
    name: 'ctor-assigned-inferred',
    marker: 'this.ctorUntyped.inner().compute(',
    links: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'known-gap-empty-cell',
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

describe('PDG calleeIds — chained receiver calls by receiver form (known gap: #2807)', () => {
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

  // The `known-gap-empty-cell` rows are deliberately absent here — an `it.fails`
  // row over them would be strictly weaker than the exact pin below, since
  // `it.fails` is satisfied by ANY throw, including `idsFor`'s own non-vacuity
  // guard. Fixture drift that renamed a marker would keep it green while the
  // premise had rotted.
  for (const shape of RECEIVER_SHAPES.filter((s) => s.resolution === 'reaches-pdg')) {
    it(`${shape.name}: every chain link's exact id reaches calleeIds`, () => {
      assertChainReachesPdg(shape);
    });
  }

  // Pins the CURRENT broken value, not merely that the chain fails: both known
  // gaps emit an EMPTY cell — the first link (`Outer.inner`, a plainly named
  // receiver) is gone too. This asserts the gap EXISTS (issue #2807), so closing
  // #2807 turns it red BY DESIGN; update it together with the header table and
  // the rows' `resolution` rather than loosening it.
  it('KNOWN GAP (#2807): an inference-typed receiver empties the WHOLE calleeIds cell', () => {
    const gaps = RECEIVER_SHAPES.filter((s) => s.resolution === 'known-gap-empty-cell');
    const observed = Object.fromEntries(gaps.map((s) => [s.name, idsFor(s.marker)]));
    expect(observed).toEqual({ 'inferred-field': [], 'ctor-assigned-inferred': [] });
  });
});
