import { describe, expect, it } from 'vitest';
import type { ImportEdge, ParsedFile, ScopeId } from 'gitnexus-shared';
import { collectNamespaceTargets } from '../../../src/core/ingestion/scope-resolution/scope/namespace-targets.js';
import { pythonNamespaceReceiverPaths } from '../../../src/core/ingestion/languages/python/import-target.js';
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

/** Collect with Python's hook, against a workspace containing `files`. */
function collectPython(edges: readonly ImportEdge[], files: readonly string[] = []) {
  const parsed = { filePath: 'caller.py', moduleScope: MODULE_SCOPE } as ParsedFile;
  const scopes = { imports: new Map([[MODULE_SCOPE, edges]]) } as unknown as ScopeResolutionIndexes;
  const present = new Set(files);
  return collectNamespaceTargets(parsed, scopes, {
    receiverPaths: pythonNamespaceReceiverPaths,
    moduleFileExists: (filePath) => present.has(filePath),
  });
}

/** Collect the way a provider with no hook does. */
function collectDefault(edges: readonly ImportEdge[]) {
  const parsed = { filePath: 'caller.ts', moduleScope: MODULE_SCOPE } as ParsedFile;
  const scopes = { imports: new Map([[MODULE_SCOPE, edges]]) } as unknown as ScopeResolutionIndexes;
  return collectNamespaceTargets(parsed, scopes);
}

describe('collectNamespaceTargets — namespace receiver spellings (#2826)', () => {
  it('keys only the bound name when no provider hook is supplied', () => {
    const targets = collectDefault([edge({})]);
    expect(targets.get('pkg')).toEqual(['pkg/db.py']);
    expect(targets.has('pkg.db')).toBe(false);
  });

  it('keys the dotted import path for Python', () => {
    expect(collectPython([edge({})]).get('pkg.db')).toEqual(['pkg/db.py']);
  });

  // The root key is the reason this is a hook and not a flag. `import pkg.db`
  // binds `pkg`, but `pkg` names the PACKAGE, not the submodule — keying it to
  // pkg/db.py made `pkg.helper()` resolve into the submodule whenever that file
  // happened to export `helper`, silently preferring a decoy over the real one.
  it('keys the package root at its own __init__, never at the leaf module', () => {
    const targets = collectPython([edge({})], ['pkg/__init__.py']);
    expect(targets.get('pkg')).toEqual(['pkg/__init__.py', 'pkg/db.py']);
    expect(targets.get('pkg.db')).toEqual(['pkg/db.py']);
  });

  it('omits a prefix whose package file the workspace never parsed', () => {
    // PEP-420 namespace package: no __init__.py. Better no key than one
    // pointing at a file that does not exist — or at the wrong file.
    const targets = collectPython([edge({})], []);
    expect(targets.get('pkg')).toEqual(['pkg/db.py']);
    expect(targets.get('pkg.db')).toEqual(['pkg/db.py']);
  });

  it('keys every intermediate package of a deep import', () => {
    const deep = edge({
      localName: 'a',
      targetExportedName: 'a.b.c',
      targetFile: 'a/b/c.py',
    });
    const targets = collectPython([deep], ['a/__init__.py', 'a/b/__init__.py']);
    expect(targets.get('a')).toEqual(['a/__init__.py', 'a/b/c.py']);
    expect(targets.get('a.b')).toEqual(['a/b/__init__.py', 'a/b/c.py']);
    expect(targets.get('a.b.c')).toEqual(['a/b/c.py']);
  });

  // Swift's `import Foo.Bar` produces an edge structurally identical to
  // Python's `import pkg.db` — localName 'Foo', targetExportedName 'Foo.Bar'.
  // Swift resolves the FIRST segment as the SPM target, so 'Foo.Bar' names a
  // nested type, not the imported file. Minting a key for it would hand
  // `resolveConstructionExpressionClass` an authoritative-but-wrong namespace,
  // and that function deliberately does not fall through on a miss — so a
  // working `Foo.Bar(x)` would start resolving to nothing. Only the provider
  // opt-in keeps the two apart; a structural predicate cannot.
  it('mints nothing extra for a provider without the hook, on a Swift-shaped edge', () => {
    const swiftShaped = edge({
      localName: 'Foo',
      targetExportedName: 'Foo.Bar',
      targetFile: 'Sources/Foo/Foo.swift',
    });
    const targets = collectDefault([swiftShaped]);
    expect(targets.get('Foo')).toEqual(['Sources/Foo/Foo.swift']);
    expect(targets.has('Foo.Bar')).toBe(false);
  });

  it('does not key an alias import under the module path it does not bind', () => {
    // `import pkg.db as pdb` binds ONLY `pdb`; `pkg.db.f()` is a NameError.
    const aliased = edge({ localName: 'pdb', targetExportedName: 'pkg.db' });
    const targets = collectPython([aliased], ['pkg/__init__.py']);
    expect(targets.get('pdb')).toEqual(['pkg/db.py']);
    expect(targets.has('pkg.db')).toBe(false);
    expect(targets.has('pkg')).toBe(false);
  });

  it('keeps two same-package imports on separate keys', () => {
    const targets = collectPython(
      [
        edge({ targetExportedName: 'pkg.db', targetFile: 'pkg/db.py' }),
        edge({ targetExportedName: 'pkg.cache', targetFile: 'pkg/cache.py' }),
      ],
      ['pkg/__init__.py'],
    );
    expect(targets.get('pkg.db')).toEqual(['pkg/db.py']);
    expect(targets.get('pkg.cache')).toEqual(['pkg/cache.py']);
    // The shared root LEADS with the package itself — not with whichever
    // submodule happened to be imported first — and keeps both leaves behind it
    // so a name merely re-exported by `__init__.py` still resolves.
    expect(targets.get('pkg')).toEqual(['pkg/__init__.py', 'pkg/db.py', 'pkg/cache.py']);
  });

  it('ignores non-namespace and unresolved edges', () => {
    const targets = collectPython(
      [
        edge({ kind: 'named', localName: 'db', targetExportedName: 'pkg.db' }),
        edge({ targetFile: null, targetExportedName: 'pkg.gone' }),
      ],
      ['pkg/__init__.py'],
    );
    expect(targets.size).toBe(0);
  });

  // Prefix packages are anchored on the RESOLVED leaf, not on the import
  // spelling: `resolvePythonImportTarget` resolves off-root in two of its three
  // tiers, so an import can land outside the workspace root.
  it('anchors prefix packages on the resolved leaf, not the workspace root', () => {
    const offRoot = edge({
      localName: 'utils',
      targetExportedName: 'utils.db',
      targetFile: 'libs/common/utils/db.py',
    });
    // A DIFFERENT `utils` package exists at the root. Anchoring on the spelling
    // would key `utils` to it — a module this import never named.
    const targets = collectPython(
      [offRoot],
      ['utils/__init__.py', 'libs/common/utils/__init__.py'],
    );
    expect(targets.get('utils')).toEqual([
      'libs/common/utils/__init__.py',
      'libs/common/utils/db.py',
    ]);
    expect(targets.get('utils.db')).toEqual(['libs/common/utils/db.py']);
  });

  it('keys prefixes in a src/-style layout', () => {
    const srcLayout = edge({
      localName: 'a',
      targetExportedName: 'a.b.c',
      targetFile: 'src/a/b/c.py',
    });
    const targets = collectPython([srcLayout], ['src/a/__init__.py', 'src/a/b/__init__.py']);
    expect(targets.get('a')).toEqual(['src/a/__init__.py', 'src/a/b/c.py']);
    expect(targets.get('a.b')).toEqual(['src/a/b/__init__.py', 'src/a/b/c.py']);
    expect(targets.get('a.b.c')).toEqual(['src/a/b/c.py']);
  });

  it('falls back to the default for a bare single-segment import', () => {
    const bare = edge({
      localName: 'single',
      targetExportedName: 'single',
      targetFile: 'single.py',
    });
    expect(collectPython([bare]).get('single')).toEqual(['single.py']);
  });
});
