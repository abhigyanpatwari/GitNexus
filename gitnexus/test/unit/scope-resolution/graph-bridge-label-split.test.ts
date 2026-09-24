/**
 * #2807 follow-up — `resolveDefGraphId` under a def/node LABEL SPLIT.
 *
 * Some structure phases emit a type's methods as `Function` nodes while the
 * scope extractor derives `Method` from the `@declaration.method` anchor. Every
 * key the resolver builds is label-scoped, so under that split all of them miss
 * and the def lands on the label-agnostic, first-write-wins `simpleKey`.
 *
 * The shipped fix retried the QUALIFIED keys under the sibling callable label,
 * but left the two keys ABOVE them — the #2699 position key and its fail-closed
 * guard — scoped to the def's own label. Since the split is the premise, both
 * were dead there: the guard could never fire for the case the retry serves, so
 * the retry inherited the aliasing the guard exists to stop. These cases pin the
 * mirrored behaviour at the unit level, where a lookup can be posed directly
 * instead of being coaxed out of a language.
 */
import { describe, expect, it } from 'vitest';
import { resolveDefGraphId } from '../../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import {
  AMBIGUOUS_POSITION,
  localNameKey,
  positionKey,
  qualifiedKey,
  simpleKey,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';

const FILE = 'src/app.swift';
const METHOD_NODE = `Function:${FILE}:Host.helper#1`;
const LOCAL_NODE = `Function:${FILE}:Host.run.helper@8:8#2`;

/**
 * The scope-side def for the function-local `helper`: labelled `Method` (the
 * declaration anchor), declared on 1-based line 9, and qualified by its owning
 * TYPE — which is why it collides with the class method's name at all.
 */
const LOCAL_DEF = {
  nodeId: `def:${FILE}#9:8:Method:helper`,
  qualifiedName: 'Host.helper',
  type: 'Method',
} as const;

/** The class method's own def: same name, same label, 1-based line 5. */
const METHOD_DEF = {
  nodeId: `def:${FILE}#5:4:Method:helper`,
  qualifiedName: 'Host.helper',
  type: 'Method',
} as const;

/** Keys the method's `Function` node always registers. */
const methodNameKeys: readonly (readonly [string, string])[] = [
  [qualifiedKey(FILE, 'Function', 'Host.helper'), METHOD_NODE],
  [qualifiedKey(FILE, 'Function', 'Host.helper#1'), METHOD_NODE],
  [simpleKey(FILE, 'helper'), METHOD_NODE],
];

const lookupOf = (entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> =>
  new Map(entries.map(([k, v]) => [k, v]));

describe('resolveDefGraphId across a def/node label split (#2807)', () => {
  it('consults the position key under the sibling label', () => {
    const lookup = lookupOf([
      ...methodNameKeys,
      [positionKey(FILE, 'Function', 4, 'helper'), METHOD_NODE],
      [positionKey(FILE, 'Function', 8, 'helper'), LOCAL_NODE],
    ]);
    expect({
      local: resolveDefGraphId(FILE, LOCAL_DEF, lookup),
      method: resolveDefGraphId(FILE, METHOD_DEF, lookup),
    }).toEqual({ local: LOCAL_NODE, method: METHOD_NODE });
  });

  // The guard's whole job: when the position join misses but a function-local of
  // this name is registered, emitting NO edge is correct and aliasing onto the
  // same-named method is not. Without the sibling arm this def reaches the
  // qualified retry and comes back as the method.
  it('fails closed under the sibling label when a same-named local exists', () => {
    const lookup = lookupOf([
      ...methodNameKeys,
      [localNameKey(FILE, 'Function', 'helper'), LOCAL_NODE],
    ]);
    expect(resolveDefGraphId(FILE, LOCAL_DEF, lookup)).toBeUndefined();
  });

  // …and only then. A file with no such local keeps resolving through the
  // sibling qualified retry, which is what the shipped #2807 fix added; a guard
  // that fired here would delete every Swift method edge in the repo.
  it('still resolves through the sibling qualified key when no local exists', () => {
    expect(resolveDefGraphId(FILE, METHOD_DEF, lookupOf(methodNameKeys))).toBe(METHOD_NODE);
  });

  // An `AMBIGUOUS_POSITION` tombstone means two callables already claim this
  // line under the def's OWN label. Relabelling must not resolve that by
  // picking a third node — the tombstone keeps falling through to the name keys.
  it('does not let the sibling label resolve an AMBIGUOUS_POSITION tombstone', () => {
    const lookup = lookupOf([
      ...methodNameKeys,
      [positionKey(FILE, 'Method', 8, 'helper'), AMBIGUOUS_POSITION],
      [positionKey(FILE, 'Function', 8, 'helper'), LOCAL_NODE],
    ]);
    expect(resolveDefGraphId(FILE, LOCAL_DEF, lookup)).toBe(METHOD_NODE);
  });

  // The dot gate on the qualified retry is untouched: a bare name carries no
  // owner, so crossing the labels there is precisely the top-level-vs-method
  // aliasing the label was introduced to prevent.
  it('keeps the dot gate on the qualified retry', () => {
    const lookup = lookupOf([
      [qualifiedKey(FILE, 'Function', 'helper'), `Function:${FILE}:helper`],
    ]);
    expect(
      resolveDefGraphId(
        FILE,
        { nodeId: `def:${FILE}#9:8:Method:helper`, qualifiedName: 'helper', type: 'Method' },
        lookup,
      ),
    ).toBeUndefined();
  });
});
