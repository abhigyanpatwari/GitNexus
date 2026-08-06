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

  // The EDGES are not landed yet — nodes and declarations are.
  //
  // Established: the shape is a class-like scope already (`interface_declaration`
  // and `type_alias_declaration value:(object_type)` both emit `@scope.class`),
  // and `property_signature` now emits `@declaration.property` alongside the
  // pre-existing `method_signature` -> `@declaration.method`. So the receiver
  // has a scope and the scope has members, yet no ACCESSES forms — the missing
  // link is owner/type-binding, i.e. the member def carrying an `ownerId` that
  // the typed receiver resolves to via `findOwnedMember`.
  //
  // There is deliberately NO name-based safety net here: TypeScript sets
  // `fieldFallbackOnMethodLookup: false` (scope-resolver.ts) because name
  // matching over-connects in a typed language, and the unique-name pass
  // honors that opt-out. The precise path is the only route for TS, by design.
  it('links an interface field to its consumer', () => {
    expect(readersOf('ifaceSlots')).toContain('renderIface');
  });

  // ALIAS field -> consumer is still unlinked. Diagnosis, traced to the end so
  // the next attempt starts from facts rather than from this list again:
  //
  //   1. The graph side is COMPLETE and symmetric with the interface:
  //      `Property:contracts.ts:LiveModeConfig.bookSlots` is owner-qualified
  //      and carries `HAS_PROPERTY LiveModeConfig->bookSlots`.
  //   2. Resolution enters `resolveClassBindingForName('LiveModeConfig')`
  //      (verified by instrumentation) and misses.
  //   3. It misses because the module scope binds `LiveModeIface:Interface`,
  //      `renderAlias`, `renderIface` — and NOT `LiveModeConfig`. The alias has
  //      no binding on the receiver's scope chain at all.
  //   4. The TS scope query tags aliases `@declaration.type`, but
  //      `normalizeNodeLabel` accepts only `typealias` / `type_alias` and has
  //      no `type` case, so it returns undefined. Kotlin and Dart use
  //      `@declaration.type_alias`; TypeScript is alone on the dead tag.
  //   5. Retagging it to `@declaration.type_alias` is NECESSARY BUT NOT
  //      SUFFICIENT — tried, and the binding still does not appear on the
  //      chain, so a second gate exists in how a declaration anchored on a
  //      node that is ALSO a `@scope.class` anchor gets attached (the alias
  //      appears to bind inside its own scope instead of hoisting to Module,
  //      where `interface_declaration` evidently does hoist).
  //
  // A widened predicate (`isShapeLike`) plus a mirrored
  // `findShapeBindingInScope` were also built and REVERTED: with no binding on
  // the chain they never fire, and shipping inert widening is worse than none.
  // Fix step 5 first; the rest is then a small, testable change.
  it.todo('links an alias field to its consumer');
});
