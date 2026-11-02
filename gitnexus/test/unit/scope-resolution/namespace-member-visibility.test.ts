/**
 * `ScopeResolver.isNamespaceMemberVisible` — the language-neutral seam by which
 * a provider says which module-scope declarations a namespace qualifier can
 * reach (`ns.member`, `x: ns.Type`).
 *
 * Three things are pinned here, none of which needs a Go toolchain or a parse:
 *
 *   1. the shared lookup (`findExportedDef` and its imported-names variant)
 *      behaves byte-for-byte as before when no predicate is supplied, and
 *      treats a refused declaration as undeclared when one is;
 *   2. Go's implementation of the hook follows the spec's export rule;
 *   3. Go is the ONLY registered provider that implements it, so every other
 *      language keeps seeing every namespace member (the default).
 *
 * The end-to-end behaviour (edges in a real graph, the rename re-resolution
 * pass) lives in `test/integration/resolvers/go-namespace-member-visibility`
 * and `test/unit/rename-go-reresolution`.
 */

import { describe, expect, it } from 'vitest';
import type { BindingRef, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index-types.js';
import {
  findExportedDef,
  findExportedDefIncludingImportedNames,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { goIsNamespaceMemberVisible } from '../../../src/core/ingestion/languages/go/namespace-member-visibility.js';
import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';

const TARGET_FILE = 'lib/target.go';
const MODULE = 'scope:lib:module' as ScopeId;

const def = (
  nodeId: string,
  qualifiedName: string,
  type: SymbolDefinition['type'] = 'Function',
): SymbolDefinition => ({ nodeId, filePath: TARGET_FILE, type, qualifiedName });

const local = (member: SymbolDefinition): BindingRef => ({ def: member, origin: 'local' });
const imported = (member: SymbolDefinition): BindingRef => ({ def: member, origin: 'import' });

/** One module scope whose finalized bindings are exactly `bindings`. */
function target(bindings: Record<string, readonly BindingRef[]>) {
  const moduleScope = {
    id: MODULE,
    kind: 'Module',
    parent: null,
    filePath: TARGET_FILE,
    bindings: new Map(Object.entries(bindings)),
  } as unknown as Scope;
  const index = {
    moduleScopeByFile: new Map([[TARGET_FILE, moduleScope]]),
  } as unknown as WorkspaceResolutionIndex;
  const scopes = {
    bindings: new Map([[MODULE, new Map(Object.entries(bindings))]]),
    bindingAugmentations: new Map(),
  } as unknown as ScopeResolutionIndexes;
  return { index, scopes };
}

const refuseAll = (): boolean => false;
const acceptAll = (): boolean => true;

describe('findExportedDef with a namespace-member visibility predicate', () => {
  const hidden = def('def:hidden', 'hidden');
  const { index } = target({ hidden: [local(hidden)] });

  it('returns every local module binding when no predicate is supplied', () => {
    expect(findExportedDef(TARGET_FILE, 'hidden', index)).toBe(hidden);
  });

  it('returns the local binding when the predicate accepts it', () => {
    expect(findExportedDef(TARGET_FILE, 'hidden', index, acceptAll)).toBe(hidden);
  });

  it('treats a local binding the predicate refuses as undeclared', () => {
    expect(findExportedDef(TARGET_FILE, 'hidden', index, refuseAll)).toBeUndefined();
  });

  it('hands the predicate the very declaration it would return', () => {
    const seen: SymbolDefinition[] = [];
    findExportedDef(TARGET_FILE, 'hidden', index, (candidate) => {
      seen.push(candidate);
      return true;
    });
    expect(seen).toEqual([hidden]);
  });

  it('skips a refused local binding and returns the next accepted one under the same name', () => {
    const refused = def('def:first', 'dup');
    const accepted = def('def:second', 'dup');
    const { index: duplicated } = target({ dup: [local(refused), local(accepted)] });
    expect(findExportedDef(TARGET_FILE, 'dup', duplicated, (d) => d.nodeId === 'def:second')).toBe(
      accepted,
    );
  });

  it('never returns a non-local binding, whatever the predicate says', () => {
    const published = def('def:published', 'published');
    const { index: republished } = target({ published: [imported(published)] });
    expect(findExportedDef(TARGET_FILE, 'published', republished, acceptAll)).toBeUndefined();
  });
});

describe('findExportedDefIncludingImportedNames with a namespace-member visibility predicate', () => {
  const declared = def('def:declared', 'name');
  const republished = def('def:republished', 'name');

  it('returns the local declaration when the predicate accepts it', () => {
    const { index, scopes } = target({ name: [local(declared)] });
    expect(
      findExportedDefIncludingImportedNames(TARGET_FILE, 'name', index, scopes, acceptAll),
    ).toBe(declared);
  });

  it('lets a refused local declaration own the name instead of falling through to a re-export', () => {
    const { index, scopes } = target({ name: [local(declared), imported(republished)] });
    expect(findExportedDefIncludingImportedNames(TARGET_FILE, 'name', index, scopes)).toBe(
      declared,
    );
    expect(
      findExportedDefIncludingImportedNames(TARGET_FILE, 'name', index, scopes, refuseAll),
    ).toBeUndefined();
  });

  it('still answers with a published name when the file declares no local of that name', () => {
    const { index, scopes } = target({ name: [imported(republished)] });
    expect(
      findExportedDefIncludingImportedNames(TARGET_FILE, 'name', index, scopes, refuseAll),
    ).toBe(republished);
  });
});

describe('goIsNamespaceMemberVisible follows the Go export rule', () => {
  it.each([
    ['an ASCII uppercase function', 'Target', true],
    ['an ASCII lowercase function', 'target', false],
    ['a Unicode uppercase identifier', 'Ünicode', true],
    ['a Unicode lowercase identifier', 'ünicode', false],
    ['a titlecase-initial identifier', 'ǅtitle', false],
    ['a caseless-letter identifier', '日本', false],
    ['an underscore-initial identifier', '_Target', false],
    ['a member qualified by its owner, judged by its own last segment', 'Owner.hidden', false],
    ['an exported member qualified by an unexported owner', 'owner.Shown', true],
  ])('%s', (_label, qualifiedName, expected) => {
    expect(goIsNamespaceMemberVisible({ member: def('def:x', qualifiedName) })).toBe(expected);
  });

  it('does not refuse a declaration that carries no identifier to read', () => {
    expect(
      goIsNamespaceMemberVisible({
        member: { nodeId: 'def:anonymous', filePath: TARGET_FILE, type: 'Function' },
      }),
    ).toBe(true);
  });
});

describe('isNamespaceMemberVisible registration inventory', () => {
  it('is implemented by Go alone, so every other language keeps the default', () => {
    const implementers = [...SCOPE_RESOLVERS.entries()]
      .filter(([, resolver]) => resolver.isNamespaceMemberVisible !== undefined)
      .map(([language]) => language);
    expect(implementers).toEqual(['go']);
  });
});
