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

  // The ALIAS half still does not link, and the remaining blocker is now
  // exact: resolving `cfg: LiveModeConfig` to its members requires the name
  // `LiveModeConfig` to resolve to a CLASS-LIKE def, and `isClassLike` is
  // Class|Interface|Struct|Record|Enum|Trait — no TypeAlias. That predicate is
  // consulted from ~12 sites including MRO and heritage, and every language
  // mints TypeAlias (Rust type_item, Kotlin/Swift/Dart typealias, C typedef),
  // so widening it would enrol aliases in linearization where they do not
  // belong. Widening only the scope index was tried and is NOT sufficient —
  // the type-name walkers gate on it independently. Needs a deliberate
  // "shape-like" concept rather than more call-site widening.
  it.todo('links an alias field to its consumer');
});
