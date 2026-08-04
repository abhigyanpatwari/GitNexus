import { describe, expect, it } from 'vitest';
import type { ImportEdge, ParsedFile, ScopeId } from 'gitnexus-shared';
import { collectNamespaceTargets } from '../../../src/core/ingestion/scope-resolution/scope/namespace-targets.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

// `collectNamespaceTargets` reads exactly two things: the file's module scope
// and `scopes.imports`. Hand-building those keeps this test about the keying
// rule itself rather than about any one language's parser — which matters,
// because the rule's whole job is to tell otherwise identical-looking edges
// from different languages apart.

const MODULE_SCOPE = 'mod:caller' as ScopeId;

function edge(partial: Partial<ImportEdge>): ImportEdge {
  return {
    localName: 'pkg',
    targetFile: 'pkg/db.py',
    targetExportedName: 'pkg.db',
    kind: 'namespace',
    ...partial,
  } as ImportEdge;
}

function collect(edges: readonly ImportEdge[], includeImportPath: boolean) {
  const parsed = { filePath: 'caller.py', moduleScope: MODULE_SCOPE } as ParsedFile;
  const scopes = { imports: new Map([[MODULE_SCOPE, edges]]) } as unknown as ScopeResolutionIndexes;
  return collectNamespaceTargets(parsed, scopes, { includeImportPath });
}

describe('collectNamespaceTargets — dotted import-path keys (#2826)', () => {
  it('keys the local binding name whether or not the provider opts in', () => {
    for (const optIn of [false, true]) {
      expect(collect([edge({})], optIn).get('pkg')).toEqual(['pkg/db.py']);
    }
  });

  it('adds the dotted import path only when the provider opts in', () => {
    expect(collect([edge({})], false).has('pkg.db')).toBe(false);
    expect(collect([edge({})], true).get('pkg.db')).toEqual(['pkg/db.py']);
  });

  // Swift's `import Foo.Bar` produces localName 'Foo' / targetExportedName
  // 'Foo.Bar' — structurally identical to Python's `import pkg.db`. Swift
  // resolves the FIRST segment as the SPM target, so 'Foo.Bar' names a nested
  // type, not the imported file. Minting a key for it would hand
  // `resolveConstructionExpressionClass` an authoritative-but-wrong namespace,
  // and that function deliberately does not fall through on a miss — so a
  // working `Foo.Bar(x)` would start resolving to nothing. The opt-in is what
  // keeps the two apart; a bare structural predicate cannot.
  it('mints nothing for a non-opted-in provider with a Swift-shaped edge', () => {
    const swiftShaped = edge({
      localName: 'Foo',
      targetExportedName: 'Foo.Bar',
      targetFile: 'Sources/Foo/Foo.swift',
    });
    const targets = collect([swiftShaped], false);
    expect(targets.get('Foo')).toEqual(['Sources/Foo/Foo.swift']);
    expect(targets.has('Foo.Bar')).toBe(false);
  });

  it('does not key an alias import under the module path it does not bind', () => {
    // `import pkg.db as pdb` binds ONLY `pdb`; `pkg.db.f()` is a NameError.
    // The root-segment check is what rejects it.
    const aliased = edge({ localName: 'pdb', targetExportedName: 'pkg.db' });
    const targets = collect([aliased], true);
    expect(targets.get('pdb')).toEqual(['pkg/db.py']);
    expect(targets.has('pkg.db')).toBe(false);
  });

  it('keeps two same-package imports on separate keys', () => {
    const targets = collect(
      [
        edge({ targetExportedName: 'pkg.db', targetFile: 'pkg/db.py' }),
        edge({ targetExportedName: 'pkg.cache', targetFile: 'pkg/cache.py' }),
      ],
      true,
    );
    expect(targets.get('pkg.db')).toEqual(['pkg/db.py']);
    expect(targets.get('pkg.cache')).toEqual(['pkg/cache.py']);
    // The shared root stays ambiguous, exactly as before this change.
    expect(targets.get('pkg')).toEqual(['pkg/db.py', 'pkg/cache.py']);
  });

  it('ignores non-namespace and unresolved edges', () => {
    const targets = collect(
      [
        edge({ kind: 'named', localName: 'db', targetExportedName: 'pkg.db' }),
        edge({ targetFile: null, targetExportedName: 'pkg.gone' }),
      ],
      true,
    );
    expect(targets.size).toBe(0);
  });
});
