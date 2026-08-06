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
    const props = propertyNames().filter((n) => n === 'exitMinAtrMult' || n === 'stopAtrMult');
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
