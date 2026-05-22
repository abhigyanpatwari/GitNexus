/**
 * Unit tests for the Kotlin companion-promoted-method "static-only"
 * marker mechanism (#1756 / U5 of the lang-kotlin remediation plan).
 *
 * Pins the contract of the `isKotlinStaticOnly` reader and the
 * implicit `WeakSet`-backed writer driven by
 * `populateKotlinOwners`:
 *
 *   1. Round-trip: methods declared inside a companion-object scope
 *      pass `isKotlinStaticOnly` after `populateKotlinOwners` runs;
 *      methods declared directly on a regular class scope do not.
 *   2. Identity, not structure: spreading a marked def into a new
 *      object reference produces a structurally-identical but
 *      identity-distinct def that does NOT pass the marker check.
 *      Documents the identity-based design boundary that the
 *      previous enumerable-property mechanism did not enforce.
 *   3. Multi-def fanout: marking three companion methods in one
 *      pass leaves all three readable and an unmarked sibling
 *      unaffected.
 *
 * The writer is intentionally not exported — these tests drive it
 * through the public `populateKotlinOwners` entry point using a
 * hand-built `ParsedFile` shape, mirroring the runtime call site.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedFile, Range, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import {
  clearCompanionScopes,
  isCompanionScope,
  markCompanionScope,
} from '../../src/core/ingestion/languages/kotlin/companion-scopes.js';
import {
  isKotlinStaticOnly,
  populateKotlinOwners,
} from '../../src/core/ingestion/languages/kotlin/owners.js';

const RANGE: Range = { startLine: 1, startCol: 0, endLine: 1, endCol: 0 };

function makeScope(args: {
  id: string;
  parent: string | null;
  kind: Scope['kind'];
  filePath: string;
  ownedDefs: readonly SymbolDefinition[];
}): Scope {
  return {
    id: args.id as ScopeId,
    parent: args.parent === null ? null : (args.parent as ScopeId),
    kind: args.kind,
    range: RANGE,
    filePath: args.filePath,
    bindings: new Map(),
    ownedDefs: args.ownedDefs,
    imports: [],
    typeBindings: new Map(),
  } as Scope;
}

function makeMethodDef(args: { nodeId: string; filePath: string; name: string }): SymbolDefinition {
  return {
    nodeId: args.nodeId,
    filePath: args.filePath,
    type: 'Function',
    qualifiedName: args.name,
  } as SymbolDefinition;
}

function makeClassDef(args: { nodeId: string; filePath: string; name: string }): SymbolDefinition {
  return {
    nodeId: args.nodeId,
    filePath: args.filePath,
    type: 'Class',
    qualifiedName: args.name,
  } as SymbolDefinition;
}

/**
 * Build a synthetic `ParsedFile` modelling:
 *
 *   class Outer {
 *     fun instanceMethod() { ... }   // regular instance method
 *     companion object {
 *       fun staticMethod() { ... }    // companion-promoted method
 *     }
 *   }
 *
 * The companion scope is registered with `markCompanionScope` so
 * `populateCompanionMembersOnEnclosingClass` recognises it as the
 * companion-object scope to walk for promotion + marking.
 */
function buildCompanionFixture(
  filePath: string,
  companionMethods: readonly string[],
  instanceMethods: readonly string[],
): {
  parsed: ParsedFile;
  outerClassDef: SymbolDefinition;
  companionMethodDefs: SymbolDefinition[];
  instanceMethodDefs: SymbolDefinition[];
} {
  const moduleScopeId = `${filePath}:module`;
  const outerClassScopeId = `${filePath}:class:Outer`;
  const companionScopeId = `${filePath}:class:Outer.Companion`;

  const outerClassDef = makeClassDef({
    nodeId: `${filePath}#Outer`,
    filePath,
    name: 'Outer',
  });

  const companionMethodDefs = companionMethods.map((name) =>
    makeMethodDef({
      nodeId: `${filePath}#Outer.Companion.${name}`,
      filePath,
      name,
    }),
  );

  const instanceMethodDefs = instanceMethods.map((name) =>
    makeMethodDef({
      nodeId: `${filePath}#Outer.${name}`,
      filePath,
      name,
    }),
  );

  const scopes: Scope[] = [
    makeScope({
      id: moduleScopeId,
      parent: null,
      kind: 'Module',
      filePath,
      ownedDefs: [outerClassDef],
    }),
    makeScope({
      id: outerClassScopeId,
      parent: moduleScopeId,
      kind: 'Class',
      filePath,
      ownedDefs: [outerClassDef],
    }),
    makeScope({
      id: companionScopeId,
      parent: outerClassScopeId,
      kind: 'Class',
      filePath,
      ownedDefs: [],
    }),
  ];

  // Each companion method lives in its own Function scope whose parent
  // is the companion-class scope — the exact shape
  // `populateCompanionMembersOnEnclosingClass` iterates.
  companionMethodDefs.forEach((def, idx) => {
    scopes.push(
      makeScope({
        id: `${filePath}:fn:companion:${idx}`,
        parent: companionScopeId,
        kind: 'Function',
        filePath,
        ownedDefs: [def],
      }),
    );
  });

  // Instance methods on the outer class — Function scopes whose
  // parent is the outer-class scope; populateClassOwnedMembers
  // stamps these with `ownerId = Outer` but they MUST NOT be
  // tagged by the companion promotion pass.
  instanceMethodDefs.forEach((def, idx) => {
    scopes.push(
      makeScope({
        id: `${filePath}:fn:instance:${idx}`,
        parent: outerClassScopeId,
        kind: 'Function',
        filePath,
        ownedDefs: [def],
      }),
    );
  });

  // Tell the companion-scope side-channel that
  // `outerClassScopeId.companion` is the companion scope id —
  // matches what `emitKotlinScopeCaptures` does at runtime.
  markCompanionScope(filePath, companionScopeId as ScopeId);

  const parsed: ParsedFile = {
    filePath,
    moduleScope: moduleScopeId as ScopeId,
    scopes,
    parsedImports: [],
    localDefs: [outerClassDef, ...companionMethodDefs, ...instanceMethodDefs],
    referenceSites: [],
  };

  return { parsed, outerClassDef, companionMethodDefs, instanceMethodDefs };
}

describe('isKotlinStaticOnly (WeakSet-backed marker)', () => {
  beforeEach(() => {
    clearCompanionScopes();
  });

  it('marks companion-object methods and leaves instance methods unmarked (round-trip)', () => {
    const { parsed, companionMethodDefs, instanceMethodDefs } = buildCompanionFixture(
      'fixture-roundtrip.kt',
      ['staticMethod'],
      ['instanceMethod'],
    );

    populateKotlinOwners(parsed);

    expect(isKotlinStaticOnly(companionMethodDefs[0]!)).toBe(true);
    expect(isKotlinStaticOnly(instanceMethodDefs[0]!)).toBe(false);
  });

  it('keys on def identity, not on def structure (spread copy is not marked)', () => {
    const { parsed, companionMethodDefs } = buildCompanionFixture(
      'fixture-identity.kt',
      ['staticMethod'],
      [],
    );

    populateKotlinOwners(parsed);

    const marked = companionMethodDefs[0]!;
    // Spread produces a new object reference with identical fields.
    // The previous enumerable-property marker would have copied through;
    // the WeakSet correctly tracks identity only.
    const structuralClone = { ...marked } as SymbolDefinition;

    expect(isKotlinStaticOnly(marked)).toBe(true);
    expect(isKotlinStaticOnly(structuralClone)).toBe(false);
    // Sanity: the clone really does have the same own-properties.
    expect(structuralClone.nodeId).toBe(marked.nodeId);
    expect(structuralClone.qualifiedName).toBe(marked.qualifiedName);
  });

  it('marks every companion method in a multi-method companion and leaves siblings unaffected', () => {
    const { parsed, companionMethodDefs, instanceMethodDefs } = buildCompanionFixture(
      'fixture-multi.kt',
      ['create', 'build', 'of'],
      ['save'],
    );

    populateKotlinOwners(parsed);

    expect(isKotlinStaticOnly(companionMethodDefs[0]!)).toBe(true);
    expect(isKotlinStaticOnly(companionMethodDefs[1]!)).toBe(true);
    expect(isKotlinStaticOnly(companionMethodDefs[2]!)).toBe(true);
    expect(isKotlinStaticOnly(instanceMethodDefs[0]!)).toBe(false);
  });

  it('returns false for a fresh def the writer never saw', () => {
    const unrelated = makeMethodDef({
      nodeId: 'unrelated#foo',
      filePath: 'unrelated.kt',
      name: 'foo',
    });

    expect(isKotlinStaticOnly(unrelated)).toBe(false);
  });
});

describe('kotlinScopeResolver.loadResolutionConfig lifecycle', () => {
  it('clears stale companionScopesByFile entries from a prior workspace pass', async () => {
    const staleFile = 'stale-prior-pass.kt';
    const staleScopeId = `scope:${staleFile}#1:0-2:0:Class` as ScopeId;
    markCompanionScope(staleFile, staleScopeId);
    expect(isCompanionScope(staleFile, staleScopeId)).toBe(true);

    const { kotlinScopeResolver } =
      await import('../../src/core/ingestion/languages/kotlin/scope-resolver.js');
    kotlinScopeResolver.loadResolutionConfig!('/any/repo/path');

    expect(isCompanionScope(staleFile, staleScopeId)).toBe(false);
  });
});
