/**
 * Resolver pin: every TypeScript receiver FORM resolves a chained call, whether
 * the receiver's type is declared or inferred from its initializer (#2807).
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────
 *
 * Measured against the single-file fixture below (all receiver shapes in one
 * repo). Every caller runs the same statement, `<receiver>.inner().compute(x)`;
 * only the receiver FORM varies:
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
 *   field   `private p = new Outer()`            (INFERRED)   Outer.inner + Inner.compute
 *   field   `private p;` + ctor `this.p = new Outer()`        Outer.inner + Inner.compute
 *   field   `private p;` + method `this.p = new Outer()`      Outer.inner + Inner.compute
 *
 * ── WHY THE LAST THREE ROWS ARE HERE (#2807) ──────────────────────────────────
 *
 * They used to emit NOTHING — not a partial chain, no outgoing CALLS edge at
 * all, so even `Outer.inner`, a plainly named receiver call, was lost. The
 * discriminator was whether the field DECLARED its type: an untyped field had
 * no entry in its class scope's `typeBindings`, so `typeOfMemberOnClass` came
 * back empty and `foldReceiverChain` declined at the very first step.
 *
 * The `new Outer()` initializer was never the problem — it always emitted its
 * own constructor edge, exactly as the annotated twin does (still asserted
 * below). What was missing was the step turning that initializer into a TYPE
 * BINDING for the field, i.e. a `@type-binding.constructor` capture pattern
 * anchored on `public_field_definition` and on `this.<field> = new …`.
 *
 * The annotated twins stay pinned alongside on purpose: they are what proves a
 * regression would be a regression, and one of them —
 * `AnnotationBeatsInitializerCaller` — deliberately mistypes its annotation so
 * that the annotation-over-initializer source-strength tie-break is asserted
 * executably rather than assumed.
 *
 * The same fact is observable one layer down as a `BasicBlock.calleeIds` cell
 * in `test/integration/cfg/pdg-chained-receiver-callees.test.ts` — that is the
 * PDG's view of this RESOLVER fact, behind a full `--pdg` pipeline. Keep the
 * two files in step: whoever changes receiver typing changes both.
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

export class MethodAssignedInferredCaller {
  private lateBound;
  setUp(): void {
    this.lateBound = new Outer();
  }
  runMethodAssignedInferred(x: number): number {
    const r = this.lateBound.inner().compute(x);
    return r;
  }
}

// Deliberately mistyped: the annotation says \`Mismatch\`, the initializer
// constructs an \`Outer\`. TypeScript would reject it; the resolver must still
// prefer the ANNOTATION, because \`annotation\` outranks \`constructor-inferred\`
// in \`typeBindingStrength\`. \`Mismatch\` has no \`inner\`, so a resolver that let
// the initializer win would emit \`Outer.inner\` here — the one row in this file
// that fails if the source-strength tie-break regresses.
export class Mismatch {
  notInner(): number {
    return 0;
  }
}

export class AnnotationBeatsInitializerCaller {
  private mistyped: Mismatch = new Outer();
  runAnnotationBeatsInitializer(x: number): number {
    const r = this.mistyped.inner().compute(x);
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

/** Every chain link becomes a CALLS edge. The only value today — the
 *  inference-typed rows joined it in #2807 — but kept as a named type so a
 *  future gap row has somewhere to say so instead of being a bare boolean. */
type ChainResolution = 'resolves';

interface ReceiverShape {
  /** Row name; also the assertion key in the diff when a row moves. */
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
  // ── Inference-typed fields (#2807) ────────────────────────────────────────
  // Identical to `annotated-field-initializer` / `ctor-assigned-annotated`
  // above except that the field carries no type annotation, so its type is
  // inferred from the initializer. These two emitted NOTHING before #2807 —
  // not even the first, plainly named link — because an untyped field had no
  // type binding for the receiver fold to stand on.
  {
    name: 'inferred-field-initializer',
    callerId: `Method:${FIXTURE_PATH}:InferredFieldCaller.runInferredField#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  {
    name: 'ctor-assigned-inferred',
    callerId: `Method:${FIXTURE_PATH}:CtorAssignedInferredCaller.runCtorAssignedInferred#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
  // The assignment that types the field need not be in the constructor — the
  // capture matches any `this.<field> = new …`, so a setter binds it too.
  {
    name: 'method-assigned-inferred',
    callerId: `Method:${FIXTURE_PATH}:MethodAssignedInferredCaller.runMethodAssignedInferred#1`,
    targets: [OUTER_INNER, INNER_COMPUTE],
    resolution: 'resolves',
  },
];

describe('TypeScript chained receiver calls by field-type form (#2807)', () => {
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

  // The source-strength tie-break, as an executable row rather than a comment.
  // `private mistyped: Mismatch = new Outer()` matches BOTH the annotation
  // pattern and the field constructor-inferred pattern added for #2807;
  // `annotation` outranks `constructor-inferred` in `typeBindingStrength`, so
  // the field must stay typed as `Mismatch` — which has no `inner` — and the
  // caller must emit NO call edge. If the inferred binding ever wins instead,
  // this is the only row in the file that notices: every other row would keep
  // resolving, because for them the two sources agree.
  //
  // The load-bearing half of the assertion is the ABSENCE of `Outer.inner`:
  // that is the edge a resolver would emit if the initializer had won.
  //
  // `Inner.compute` IS present, and deliberately pinned rather than filtered
  // out. It does not come from the field at all — `Mismatch` has no `inner`, so
  // the fold falls through to the hoisted branch in `typeOfMemberOnClass`,
  // finds the module-level return-type binding `inner -> Inner` that
  // `hoistTypeBindingsToModule` puts there, and types the NEXT position from
  // it. Verified byte-identical on the pre-#2807 tree (same fixture, same
  // single id), so it is a pre-existing property of the hoisted lookup and not
  // something the field-initializer patterns introduced. Pinning the exact list
  // rather than asserting "no Outer.inner" means a future change to either
  // mechanism has to come through this row.
  it('an annotated field beats its own initializer — the tie-break is by source strength', () => {
    const callerId = `Method:${FIXTURE_PATH}:AnnotationBeatsInitializerCaller.runAnnotationBeatsInitializer#1`;
    expect({ callerExists: nodeExists(callerId), calls: callTargetsFrom(callerId) }).toEqual({
      callerExists: true,
      calls: [INNER_COMPUTE],
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
