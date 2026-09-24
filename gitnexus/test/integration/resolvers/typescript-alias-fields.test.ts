/**
 * A4 — TypeScript type aliases and interface members must be indexed.
 *
 * A TS frontend models its API contracts as `type X = { … }` and `interface`,
 * so a field on one is the thing you ask "who breaks if I remove this?" about.
 * Three gaps made that unanswerable, all in the TypeScript PARSE query:
 *
 *   1. No `type_alias_declaration` -> `@definition.type`, so the alias minted
 *      NO NODE AT ALL and `context({name:'LiveModeConfig'})` said "Symbol not
 *      found". TypeScript was the only language missing this — Rust
 *      (`type_item`), Kotlin (`type_alias`), Swift (`typealias_declaration`)
 *      and Dart all emit it.
 *   2. No `property_signature` pattern, so INTERFACE members minted no
 *      `Property` nodes either — the upstream report's "class/interface index
 *      fine" is only half right.
 *   3. Alias members likewise had no node.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';
import path from 'path';

interface LabelledNode {
  readonly label: string;
  readonly properties: Record<string, unknown>;
}

describe('TypeScript type-alias and interface members (A4)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-alias-fields'), () => {});
  }, 60000);

  const nodesOfLabel = (label: string): string[] =>
    Array.from(
      (result as unknown as { graph: { iterNodes(): Iterable<LabelledNode> } }).graph.iterNodes(),
    )
      .filter((n) => n.label === label)
      .map((n) => String(n.properties.name));

  const readersOf = (field: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.target === field)
      .map((e) => e.source);

  it('indexes the type alias as a symbol', () => {
    // Previously "Symbol not found" — the alias existed for scope resolution
    // but never became a graph node.
    expect(nodesOfLabel('TypeAlias')).toContain('LiveModeConfig');
  });

  it('indexes type-alias members as Property nodes', () => {
    const props = nodesOfLabel('Property');
    expect(props).toContain('bookNotionalUsdt');
    expect(props).toContain('bookSlots');
  });

  it('indexes interface members as Property nodes', () => {
    expect(nodesOfLabel('Property')).toContain('ifaceSlots');
  });

  // Member edges land through the PRECISE path only. The shape is a class-like
  // scope (`interface_declaration` and `type_alias_declaration value:
  // (object_type)` both emit `@scope.class`) and `property_signature` emits
  // `@declaration.property`, so a typed receiver resolves to the shape's scope
  // and finds the member there.
  //
  // There is deliberately NO name-based safety net: TypeScript sets
  // `fieldFallbackOnMethodLookup: false` (scope-resolver.ts) because name
  // matching over-connects in a typed language, and the unique-name pass honors
  // that opt-out. The precise path is the only route for TS, by design.
  it('links an interface field to its consumer', () => {
    expect(readersOf('ifaceSlots')).toContain('renderIface');
  });

  it('links an alias field to its consumer', () => {
    expect(readersOf('bookNotionalUsdt')).toContain('renderAlias');
  });

  // R2-2. Owning the members was only half of it: with no edge INTO the type,
  // `context()` on an exported contract answered `incoming: {}`, so "what
  // breaks if I remove this field?" — the question a contract type exists to
  // answer — had nothing to walk. Measured on the reporting repo, all 324
  // TypeAlias nodes and every Interface node had DEFINES as their ONLY
  // incoming edge, because TypeScript captured no type references at all.
  // RV-4. `property_signature` occurs in EVERY object_type, not only in a
  // declared shape, so inline parameter types, inline return types and nested
  // object types matched too and the enclosing-container walk hung them off the
  // nearest class/interface/alias. `addNode` is first-write-wins, so when the
  // inline member shared a name with a real one the two symbols merged onto a
  // single node and every answer about that field described the merge.
  //
  // Each inline member below is UNIQUELY named on purpose. A merge and a
  // correct exclusion both leave exactly one node behind, so counting ids
  // cannot tell them apart — the only discriminator is a name that the
  // unanchored rule alone could produce. Measured against it, all four appeared:
  // `Svc.inlineParamOnlyKey`, `Repo.inlineQueryOnlyKey`,
  // `NestedConfig.nestedOnlyKey` and `buildInline.inlineReturnOnlyKey`.
  describe('shape anchoring (RV-4)', () => {
    const propertyIds = (): string[] =>
      Array.from(
        (result as unknown as { graph: { iterNodes(): Iterable<PropNode> } }).graph.iterNodes(),
      )
        .filter((n) => n.label === 'Property')
        .map((n) => String(n.id));

    it('does not attribute an inline PARAMETER type member to the class', () => {
      expect(propertyIds().some((id) => id.includes('inlineParamOnlyKey'))).toBe(false);
    });

    it('does not attribute an inline parameter type member to the interface', () => {
      expect(propertyIds().some((id) => id.includes('inlineQueryOnlyKey'))).toBe(false);
    });

    it('does not attribute a NESTED object type member to the alias', () => {
      expect(propertyIds().some((id) => id.includes('nestedOnlyKey'))).toBe(false);
    });

    it('does not mint a member for an inline RETURN type', () => {
      // The TYPE's member, not the returned value's key — those are different
      // rules with opposite expectations, and the fixture names them apart so
      // this assertion cannot be satisfied by the wrong one.
      expect(propertyIds().some((id) => id.includes('inlineReturnTypeOnlyKey'))).toBe(false);
    });

    // The other half: anchoring must not cost real members.
    it('still indexes every member of a declared shape', () => {
      const ids = propertyIds();
      for (const expected of [
        'LiveModeConfig.bookSlots',
        'LiveModeConfig.bookNotionalUsdt',
        'LiveModeIface.ifaceSlots',
        'NestedConfig.host',
        'Svc.retries',
        'Repo.retries',
      ]) {
        expect(ids.some((id) => id.endsWith(expected))).toBe(true);
      }
    });
  });

  // R3-3. Found while building a fixture for the opt-out reporting change, not
  // from a report: the object-literal rules were JavaScript-only, so the most
  // common config idiom in TypeScript had invisible keys.
  describe('object-literal keys in TypeScript (R3-3)', () => {
    const names = (): string[] =>
      Array.from(
        (result as unknown as { graph: { iterNodes(): Iterable<PropNode> } }).graph.iterNodes(),
      )
        .filter((n) => n.label === 'Property')
        .map((n) => String(n.properties.name));

    it('indexes keys of a named object literal', () => {
      expect(names()).toContain('tsConfigRetries');
      expect(names()).toContain('tsConfigTimeoutMs');
    });

    it('indexes keys behind an identity-preserving wrapper', () => {
      expect(names()).toContain('tsFrozenMaxNotional');
    });

    // The half that matters for TypeScript specifically. It opts out of
    // name inference, so the value of minting these nodes is that the PRECISE
    // path — a read through the holding variable — now has something to
    // resolve to.
    it('resolves a precise read through the holding variable', () => {
      expect(readersOf('tsConfigRetries')).toContain('readsTsConfig');
      expect(readersOf('tsFrozenMaxNotional')).toContain('readsTsConfig');
    });

    it('keeps the same allowlist bound as the JavaScript rule', () => {
      expect(names()).not.toContain('tsNotAMember');
    });
  });

  describe('type consumers (R2-2)', () => {
    const usersOf = (typeName: string): string[] =>
      getRelationships(result, 'USES')
        .filter((e) => e.target === typeName)
        .map((e) => e.source);

    it('links a parameter annotation to the alias it names', () => {
      expect(usersOf('LiveModeConfig')).toContain('renderAlias');
    });

    it('links a parameter annotation to the interface it names', () => {
      expect(usersOf('LiveModeIface')).toContain('renderIface');
    });
  });
});

interface PropNode {
  readonly id: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
}
