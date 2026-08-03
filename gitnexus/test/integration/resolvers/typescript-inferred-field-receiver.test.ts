/**
 * Resolver pin: a TypeScript class field whose type must be INFERRED from its
 * initializer cannot act as a call receiver — the calling method emits NO CALLS
 * edges at all, not even for the first, ordinary named-receiver link.
 *
 * ── WHERE THE SUPPORT ACTUALLY STOPS ──────────────────────────────────────────
 *
 * Measured against the single-file fixture below (nine receiver shapes in one
 * repo). Every caller runs the same statement, `<receiver>.inner().compute(x)`;
 * only the receiver FORM varies. The discriminator is whether the receiver's
 * type is DECLARED, not whether it is a local or a field:
 *
 *   receiver form                                            CALLS edges emitted
 *   -------------------------------------------------------  --------------------------
 *   local   `const o = new Outer()`                           Outer.inner + Inner.compute
 *   field   `private p: Outer = new Outer()`     (ANNOTATED)  Outer.inner + Inner.compute
 *   field   `private p: Outer;` + ctor `this.p = new Outer()` Outer.inner + Inner.compute
 *   field   `private p: Outer;` + ctor param `this.p = p`     Outer.inner + Inner.compute
 *   field   `constructor(private p: Outer)` (param property)  Outer.inner + Inner.compute
 *   result  `makeOuter().inner().compute()`                   makeOuter + both links
 *   chain   `o.inner().mid().compute()`        (three links)  all three links
 *   field   `private p = new Outer()`            (INFERRED)   NONE   <- known gap
 *   field   `private p;` + ctor `this.p = new Outer()`        NONE   <- known gap
 *
 * The two gap rows do not merely lose the CHAINED link. They emit nothing: the
 * caller has no outgoing CALLS edge whatsoever, so `Outer.inner` — a plainly
 * named receiver call — is lost too. `KNOWN GAP` below asserts that empty value
 * EXACTLY, alongside a `callerExists` probe so the assertion cannot pass
 * vacuously if fixture drift or an id-scheme change moved the caller node.
 *
 * `only the receiver TYPE is lost` narrows where to look: the `new Outer()`
 * initializer of an inferred field IS resolved (it emits its own constructor
 * CALLS edge, exactly as the annotated twin does). What is missing is the step
 * that turns that initializer into a type binding for the field.
 *
 * The annotated twins are pinned in the same file on purpose — a gap test that
 * shows only the broken shape does not tell the next engineer where the
 * boundary is.
 *
 * ── THIS PIN IS SELF-DIFFING: IT WILL GO RED ON PURPOSE ───────────────────────
 *
 * The gap is tracked as issue #2807 ("Inference-typed field receivers resolve to
 * no CALLS edges at all"); PR #2810 is open against it at the time of writing.
 * `KNOWN GAP` asserts that the gap EXISTS — no CALLS edges, exactly — so it is a
 * record rather than a regression guard. When the resolver learns to infer a
 * field's type from its initializer it fails with the newly resolved ids in the
 * diff; that is the intended signal. The fix is to update this file (the table
 * above, the rows' `resolution`, and the pin's expected value), not to relax the
 * assertion into something a passing fix would also satisfy.
 *
 * The gap was FOUND during #2802 work but is PRE-EXISTING and independent of it:
 * nothing on that branch touches receiver typing. Track the gap itself at #2807.
 *
 * The same fact is also observable one layer down, as an empty
 * `BasicBlock.calleeIds` cell, in `test/integration/cfg/
 * pdg-chained-receiver-callees.test.ts` — but that is the PDG's view of a
 * RESOLVER fact, behind a full `--pdg` pipeline. Whoever closes this gap will
 * be working in the resolver suite, so the fact is pinned here too, at the
 * level the fix actually changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

const FIXTURE_PATH = 'src/app.ts';

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
  runAnnotatedField(x: number): number {
    const r = this.annotated.inner().compute(x);
    return r;
  }
}

export class CtorAssignedAnnotatedCaller {
  private ctorTyped: Outer;
  constructor() {
    this.ctorTyped = new Outer();
  }
  runCtorAssignedAnnotated(x: number): number {
    const r = this.ctorTyped.inner().compute(x);
    return r;
  }
}

export class CtorParamAnnotatedCaller {
  private ctorParam: Outer;
  constructor(ctorParam: Outer) {
    this.ctorParam = ctorParam;
  }
  runCtorParamAnnotated(x: number): number {
    const r = this.ctorParam.inner().compute(x);
    return r;
  }
}

export class ParamPropertyCaller {
  constructor(private paramProp: Outer) {}
  runParamProperty(x: number): number {
    const r = this.paramProp.inner().compute(x);
    return r;
  }
}

export class InferredFieldCaller {
  private inferred = new Outer();
  runInferredField(x: number): number {
    const r = this.inferred.inner().compute(x);
    return r;
  }
}

export class CtorAssignedInferredCaller {
  private ctorUntyped;
  constructor() {
    this.ctorUntyped = new Outer();
  }
  runCtorAssignedInferred(x: number): number {
    const r = this.ctorUntyped.inner().compute(x);
    return r;
  }
}
`;

// EXACT node ids — never names or substrings. `compute` alone is ambiguous
// between `Inner.compute` and `Mid.compute`, and matching on the source NAME
// would collide on `constructor` (two classes define one). `#N` is the arity
// disambiguator the resolver mints.
const OUTER_CLASS = `Class:${FIXTURE_PATH}:Outer`;
const OUTER_INNER = `Method:${FIXTURE_PATH}:Outer.inner#0`;
const INNER_COMPUTE = `Method:${FIXTURE_PATH}:Inner.compute#1`;
const INNER_MID = `Method:${FIXTURE_PATH}:Inner.mid#0`;
const MID_COMPUTE = `Method:${FIXTURE_PATH}:Mid.compute#1`;
const MAKE_OUTER = `Function:${FIXTURE_PATH}:makeOuter`;

/**
 * `resolves` — every chain link becomes a CALLS edge today.
 * `known-gap-no-calls-edges` — the resolver cannot type the receiver, so the
 * caller emits no CALLS edge at all and even the named first link is lost.
 */
type ChainResolution = 'resolves' | 'known-gap-no-calls-edges';

interface ReceiverShape {
  /** Row name; also the key of the known-gap pin below. */
  readonly name: string;
  /** Exact node id of the function or method holding the chained statement. */
  readonly callerId: string;
  /** EVERY CALLS target id this caller emits today, in any order. */
  readonly targets: readonly string[];
  readonly resolution: ChainResolution;
}

const RECEIVER_SHAPES: readonly ReceiverShape[] = [
  {
    name: 'local-const',
    callerId: `Function:${FIXTURE_PATH}:runLocalConst`,
    targets: [OUTER_CLASS, OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'annotated-field-initializer',
    callerId: `Method:${FIXTURE_PATH}:AnnotatedFieldCaller.runAnnotatedField#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'ctor-assigned-annotated',
    callerId: `Method:${FIXTURE_PATH}:CtorAssignedAnnotatedCaller.runCtorAssignedAnnotated#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'ctor-param-annotated',
    callerId: `Method:${FIXTURE_PATH}:CtorParamAnnotatedCaller.runCtorParamAnnotated#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'param-property',
    callerId: `Method:${FIXTURE_PATH}:ParamPropertyCaller.runParamProperty#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'call-result-receiver',
    callerId: `Function:${FIXTURE_PATH}:runCallResultReceiver`,
    targets: [MAKE_OUTER, OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'three-link-chain',
    callerId: `Function:${FIXTURE_PATH}:runThreeLink`,
    targets: [OUTER_CLASS, OUTER_INNER, INNER_MID, MID_COMPUTE],
    resolution: 'resolves',
  },
  // ── Known gaps ────────────────────────────────────────────────────────────
  // Identical to `annotated-field-initializer` / `ctor-assigned-annotated`
  // above except that the field carries no type annotation, so its type would
  // have to be inferred from the initializer.
  {
    name: 'inferred-field-initializer',
    callerId: `Method:${FIXTURE_PATH}:InferredFieldCaller.runInferredField#1`,
    targets: [],
    resolution: 'known-gap-no-calls-edges',
  },
  {
    name: 'ctor-assigned-inferred',
    callerId: `Method:${FIXTURE_PATH}:CtorAssignedInferredCaller.runCtorAssignedInferred#1`,
    targets: [],
    resolution: 'known-gap-no-calls-edges',
  },
];

describe('TypeScript chained receiver calls by field-type form (known gap: #2807)', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-inferred-field-'));
    writeFixtureRepo(repoDir, { [FIXTURE_PATH]: CHAINED_SOURCE });
    // CALLS resolution is complete before the graph phases run and this pin
    // reads nothing they produce (MRO, communities, processes), so skipping
    // them narrows the run to the phase under test. Cost here is dominated by
    // worker-pool startup, not by the phases, so this is about scope rather
    // than speed.
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  /** Every CALLS target id emitted by one exact caller node, sorted. */
  function callTargetsFrom(callerId: string): string[] {
    return getRelationships(result, 'CALLS')
      .filter((edge) => edge.rel.sourceId === callerId)
      .map((edge) => edge.rel.targetId)
      .sort();
  }

  function nodeExists(id: string): boolean {
    return result.graph.getNode(id) !== undefined;
  }

  it('every receiver shape contributes exactly one caller node', () => {
    const found = Object.fromEntries(RECEIVER_SHAPES.map((s) => [s.name, nodeExists(s.callerId)]));
    expect(found).toEqual(Object.fromEntries(RECEIVER_SHAPES.map((s) => [s.name, true])));
  });

  // Exact set equality, not `arrayContaining`: a shape that started resolving
  // something extra (or stopped resolving a link) has to show up in the diff.
  for (const shape of RECEIVER_SHAPES.filter((s) => s.resolution === 'resolves')) {
    it(`${shape.name}: every chain link becomes a CALLS edge`, () => {
      expect(callTargetsFrom(shape.callerId)).toEqual([...shape.targets].sort());
    });
  }

  // Pins the CURRENT broken value, not merely that the chain fails. An
  // `it.fails` row here would be strictly weaker — it is satisfied by ANY
  // throw, so a renamed fixture symbol would keep it green on a rotted
  // premise. `callerExists` is folded into the same object so an empty
  // `calls` list can never be read as "resolved fine, wrong node id".
  // This asserts the gap EXISTS (issue #2807), so closing #2807 turns it red
  // BY DESIGN; update it together with the header table and the rows'
  // `resolution` rather than loosening it.
  it('KNOWN GAP (#2807): an inference-typed field receiver emits NO CALLS edges at all', () => {
    const gaps = RECEIVER_SHAPES.filter((s) => s.resolution === 'known-gap-no-calls-edges');
    const observed = Object.fromEntries(
      gaps.map((s) => [
        s.name,
        { callerExists: nodeExists(s.callerId), calls: callTargetsFrom(s.callerId) },
      ]),
    );

    expect(observed).toEqual({
      'inferred-field-initializer': { callerExists: true, calls: [] },
      'ctor-assigned-inferred': { callerExists: true, calls: [] },
    });
  });

  // Boundary evidence: the initializer is not invisible to the resolver. Both
  // twins of each pair emit the `new Outer()` constructor edge; only the
  // annotated one turns it into a receiver type. So the missing step is the
  // initializer -> field type binding, not the initializer itself.
  it('the inferred field initializer IS resolved — only the receiver TYPE is lost', () => {
    const initializerCalls = {
      'annotated-field-initializer': callTargetsFrom(`Class:${FIXTURE_PATH}:AnnotatedFieldCaller`),
      'inferred-field-initializer': callTargetsFrom(`Class:${FIXTURE_PATH}:InferredFieldCaller`),
      'ctor-assigned-annotated': callTargetsFrom(
        `Method:${FIXTURE_PATH}:CtorAssignedAnnotatedCaller.constructor#0`,
      ),
      'ctor-assigned-inferred': callTargetsFrom(
        `Method:${FIXTURE_PATH}:CtorAssignedInferredCaller.constructor#0`,
      ),
    };

    expect(initializerCalls).toEqual({
      'annotated-field-initializer': [OUTER_CLASS],
      'inferred-field-initializer': [OUTER_CLASS],
      'ctor-assigned-annotated': [OUTER_CLASS],
      'ctor-assigned-inferred': [OUTER_CLASS],
    });
  });
});
