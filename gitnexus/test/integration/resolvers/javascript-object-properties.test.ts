/**
 * A1/A5 — property access on a PLAIN OBJECT LITERAL must be answerable.
 *
 * Verified root cause: `Property` definition nodes are created only for
 * DECLARED CLASS FIELDS. Object-literal keys mint no node, so `ACCESSES` has
 * no target and "who reads/writes this config field?" returns a confident
 * zero. Capture and emission are already correct and language-neutral — a
 * `read`/`write` site maps to `ACCESSES` for any resolved target — so this is
 * purely definition-node coverage plus receiver resolution.
 *
 * Two receiver shapes, deliberately separated:
 *   - through the holding variable (`exitRules.exitMinAtrMult`) — the receiver
 *     is typeable, so this must resolve precisely.
 *   - through an untyped param (`cfg.exitMinAtrMult`) — the option-bag shape
 *     that dominates idiomatic JS. Not precisely solvable without types;
 *     covered by name-based fallback at reduced confidence.
 *
 * Both halves now land. Object-literal keys bound to a variable mint the graph
 * `Property` node (JAVASCRIPT_QUERIES) and the scope-resolution def
 * (languages/javascript/query.ts), and the ACCESSES edges resolve for both
 * receiver shapes: precisely where the receiver is typeable, and by
 * workspace-unique name where it is not — at reduced confidence, refusing to
 * choose when two properties share a name (see the ambiguity cases below).
 *
 * TRAP, learned the hard way and recorded so the next reader does not repeat
 * it: under vitest the PARSE WORKER runs the BUILT `dist/` code, because
 * `parse-impl.ts` resolves `../workers/parse-worker.js`, which does not exist
 * under `src/`, and falls back to dist. Scope resolution runs from `src`. So a
 * change to TYPESCRIPT/JAVASCRIPT_QUERIES is invisible to tests until
 * `npm run build` — it reads exactly like a failed hypothesis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('JavaScript plain-object property access (A1/A5)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-object-properties'),
      () => {},
    );
  }, 60000);

  const propertyNames = (): string[] =>
    Array.from(
      (result as unknown as { graph: { iterNodes(): Iterable<PropNode> } }).graph.iterNodes(),
    )
      .filter((n) => n.label === 'Property')
      .map((n) => String(n.properties.name));

  const readersOf = (field: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.target === field)
      .map((e) => e.source);

  it('indexes object-literal keys as Property nodes', () => {
    const props = propertyNames();
    expect(props).toContain('exitMinAtrMult');
    expect(props).toContain('stopAtrMult');
  });

  it('gives every indexed key a distinct node, not one merged symbol', () => {
    // Asserted on the RAW array, not on a Set of it. `new Set([...]).size === 2`
    // over two different literal strings can only ever be 2 — it cannot detect
    // the merge the title promises, which is a difference in COUNT.
    const props = propertyNames().filter((n) => n === 'exitMinAtrMult' || n === 'stopAtrMult');
    expect(props).toHaveLength(2);
    expect(new Set(props).size).toBe(2);
  });

  it('emits ACCESSES for a read through the holding variable', () => {
    expect(readersOf('exitMinAtrMult')).toContain('readViaVariable');
  });

  it('emits ACCESSES for the property WRITE (A5)', () => {
    const writes = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'exitMinAtrMult' && (e.rel.reason ?? '').includes('write'),
    );
    expect(writes.map((e) => e.source)).toContain('tightenExit');
  });

  it('emits ACCESSES for a read through an untyped param (option bag)', () => {
    expect(readersOf('exitMinAtrMult')).toContain('applyRules');
  });

  // The safety property. Name inference is only defensible because it refuses
  // to choose between candidates: two objects sharing a key name means a read
  // through an untyped receiver could mean either, and a wrong edge in the
  // pre-edit safety gate is worse than a missing one. Without this, the pass
  // would silently link generic keys (id, name, data) across unrelated objects.
  it('emits NOTHING when two objects share the key name', () => {
    expect(readersOf('sharedTimeoutMs')).toEqual([]);
  });

  it('still indexes both ambiguous keys as nodes — only the EDGE is withheld', () => {
    // The symbols must remain findable; it is the inference that is unsafe,
    // not the definitions.
    expect(propertyNames().filter((n) => n === 'sharedTimeoutMs')).toHaveLength(2);
  });

  it('marks a name-inferred edge at reduced confidence, not as precise', () => {
    const inferred = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'exitMinAtrMult' && (e.rel.reason ?? '').includes('unique-name'),
    );
    expect(inferred.length).toBeGreaterThan(0);
    for (const e of inferred) expect(e.rel.confidence).toBeLessThan(0.85);
  });

  // R2-1c. The function that implements a behaviour usually destructures its
  // settings out of the argument rather than reaching through a receiver, so
  // the most relevant reader was the one shape with no read site at all.
  describe('destructured parameters (R2-1c)', () => {
    it('emits ACCESSES for a destructured key with a default', () => {
      expect(readersOf('destructuredOnlyField')).toContain('appliesDestructured');
    });

    it('emits ACCESSES for bare shorthand destructuring', () => {
      expect(readersOf('destructuredOnlyField')).toContain('appliesShorthand');
    });

    // `{ field: alias }` reads `field` and binds `alias`; the READ is of the
    // key, so the edge must point at the key rather than the local name.
    it('follows the key, not the local alias, when renamed', () => {
      expect(readersOf('destructuredOnlyField')).toContain('appliesRenamed');
      expect(propertyNames()).not.toContain('aliased');
    });
  });

  // R2-1b. The read side answered well while "who SETS this field?" missed the
  // code that stamps the value, because a record built inline is bound to no
  // variable and so mints no definition to point at.
  describe('record construction writes (R2-1b)', () => {
    const writersOf = (field: string): string[] =>
      getRelationships(result, 'ACCESSES')
        .filter((e) => e.target === field && (e.rel.reason ?? '').includes('write'))
        .map((e) => e.source);

    it('emits a WRITE for a literal nested under a key', () => {
      expect(writersOf('destructuredOnlyField')).toContain('buildPlan');
    });

    it('emits a WRITE for a returned literal', () => {
      expect(writersOf('destructuredOnlyField')).toContain('buildFlat');
    });

    // This asserted `toHaveLength(1)` — no new definition — until R3-4 began
    // anchoring returned literals, which mints exactly one here (`buildFlat`'s
    // return shape). The assertion was the right instinct expressed as the
    // wrong invariant: what R2-1b actually protects is that adding definitions
    // must not move an answer that already resolved, and node count was a proxy
    // for that. The property itself is now asserted directly, and it holds
    // because narrowing ranks declared anchors above return shapes.
    it('keeps the DECLARED definition winning despite a return-shape sibling', () => {
      const nodes = propertyNames().filter((n) => n === 'destructuredOnlyField');
      expect(nodes.length).toBeGreaterThan(1);
      // Every reader still resolves, and to the declared home — a read that had
      // dropped to ambiguous would show up as a missing edge here.
      for (const reader of ['appliesDestructured', 'appliesShorthand', 'appliesRenamed']) {
        expect(readersOf('destructuredOnlyField')).toContain(reader);
      }
    });

    it('leaves an inline call-argument prop bag alone', () => {
      expect(propertyNames()).not.toContain('notAConstructedField');
      expect(writersOf('notAConstructedField')).toEqual([]);
    });
  });

  // R3-4. The dominant shape in idiomatic JS and the one with no anchor at all:
  // 437 `return {` sites in a single backend directory of the reporting repo,
  // including the ~25-field payload of its whole signal pipeline. The literal
  // binds to nothing, so its keys could not even be named.
  describe('anonymous returned object literals (R3-4)', () => {
    it('indexes keys of a literal returned from a named function', () => {
      expect(propertyNames()).toContain('returnShapeOnlyField');
    });

    it('resolves a read of a return-shape key', () => {
      expect(readersOf('returnShapeOnlyField')).toContain('readsReturnShape');
    });

    // `{ symbol, interval, score }` is the commonest spelling of all and
    // `(pair)` does not match it — tree-sitter models it as
    // `shorthand_property_identifier`, where the key IS the value. Caught by
    // dumping the golden fixture and seeing that a literal returning
    // `{ level, message, timestamp: Date.now() }` had indexed only `timestamp`.
    it('indexes SHORTHAND keys, not just explicit pairs', () => {
      expect(propertyNames()).toContain('shorthandOnlyField');
    });

    // Qualified by the owning function, so two functions returning the same key
    // are two shapes rather than one merged symbol — the same collision
    // `ownerName` prevents for variable-bound literals.
    it('qualifies by the owning function', () => {
      const ids = Array.from(
        (result as unknown as { graph: { iterNodes(): Iterable<PropNode> } }).graph.iterNodes(),
      )
        .filter((n) => n.label === 'Property')
        .map((n) => String(n.id));
      expect(ids.some((id) => id.includes('formatAlert.returnShapeOnlyField'))).toBe(true);
      expect(ids.some((id) => id.includes('formatSummary.summaryOnlyField'))).toBe(true);
    });

    // THE GUARANTEE that reconciles this with R2-1b. `sharedWithDeclared` is
    // both a named-object key and a return-shape key; a read must still resolve
    // to the DECLARED one, or indexing return shapes would silently move
    // answers that already worked.
    it('never outranks a declared anchor', () => {
      expect(readersOf('sharedWithDeclared')).toContain('readsShared');
      const declaredWins = getRelationships(result, 'ACCESSES').filter(
        (e) => e.target === 'sharedWithDeclared' && e.source === 'readsShared',
      );
      expect(declaredWins.length).toBeGreaterThan(0);
    });
  });

  // R2. Strict workspace uniqueness was measurably too blunt: in the reporting
  // repo `exitMinAtrMult` had 26 definitions, 16 of them in one-off scripts the
  // backend has no relationship with, so every backend read was refused because
  // of competitors the reader cannot even see.
  describe('scope narrowing for multi-candidate names (R2)', () => {
    const reasonsFor = (field: string): string[] =>
      getRelationships(result, 'ACCESSES')
        .filter((e) => e.target === field)
        .map((e) => String(e.rel.reason ?? ''));

    it('still sees two definitions of the narrowed name', () => {
      // Precondition. Without this the narrowing assertions below would pass
      // trivially by there being nothing to narrow.
      expect(propertyNames().filter((n) => n === 'narrowedTimeoutMs')).toHaveLength(2);
    });

    it('resolves an untyped read using direct-import evidence', () => {
      expect(readersOf('narrowedTimeoutMs')).toContain('readsNarrowed');
    });

    it('records which tier resolved it, not just that something did', () => {
      expect(reasonsFor('narrowedTimeoutMs').some((r) => r.includes('imported-file'))).toBe(true);
    });

    // The bound. Narrowing exists to USE scope evidence, not to lower the bar
    // for guessing — a reader that can see both candidates is exactly as stuck
    // as before, and must stay refused.
    it('still refuses when the reader imports BOTH candidates', () => {
      expect(readersOf('narrowedTimeoutMs')).not.toContain('readsBothVisible');
    });

    // Same-file evidence that is itself ambiguous must stop the walk rather
    // than fall through to a weaker tier.
    it('keeps refusing two same-named keys in the reading file', () => {
      expect(readersOf('sharedTimeoutMs')).toEqual([]);
    });

    // This assertion was VACUOUS when written: it read the stat off a
    // `scopeResolution` field that PipelineResult does not have, so the
    // `undefined` guard swallowed it and the whole test passed with the
    // production code deleted. The facts are now published as
    // `propertyInference`, and the guard is an assertion rather than an escape.
    it('reports the names it could not resolve, not only a count', () => {
      const inference = result.propertyInference;
      expect(inference).toBeDefined();
      // Both halves. Asserting only the empty edge set is satisfied equally by
      // "the ambiguity gate fired" and "the name was never looked up at all",
      // so the counter must be shown to have MOVED.
      expect(inference!.ambiguous).toBeGreaterThan(0);
      expect(inference!.ambiguousNames).toContain('sharedTimeoutMs');
    });
  });

  // R2-1a. Reported as the cheapest remaining win and it is: freezing a config
  // object is how JS publishes an immutable contract, so the shape whose fields
  // are most worth querying was the one shape the rule could not see.
  describe('identity-preserving wrappers (R2-1a)', () => {
    it('indexes keys of a literal wrapped in Object.freeze', () => {
      const props = propertyNames();
      expect(props).toContain('frozenExitModel');
      expect(props).toContain('frozenMaxHoldMs');
    });

    it('indexes keys wrapped in Object.seal', () => {
      expect(propertyNames()).toContain('sealedMaxNotional');
    });

    it('resolves a read through the frozen binding', () => {
      expect(readersOf('frozenMaxHoldMs')).toContain('readsFrozen');
    });

    // The bound of the fix. Only freeze/seal/preventExtensions return the
    // argument they were given; for any other call the literal is an argument
    // and the binding holds the callee's return value, so minting members here
    // would attribute fields to an object that does not have them.
    it('does NOT index a literal passed to a non-identity call', () => {
      expect(propertyNames()).not.toContain('notAMemberOfDerived');
    });

    // The case above is rejected structurally (identifier callee), so it holds
    // even with no allowlist at all. `Object.entries` differs from
    // `Object.freeze` by name alone, so this is the assertion that actually
    // pins the predicate.
    it('does NOT index Object.entries — same shape, non-identity name', () => {
      expect(propertyNames()).not.toContain('notAMemberOfEntries');
    });
  });
});

interface PropNode {
  readonly label: string;
  readonly properties: Record<string, unknown>;
}
