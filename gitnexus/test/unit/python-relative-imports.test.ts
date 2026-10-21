import { describe, expect, it } from 'vitest';
import { resolvePythonImportInternal } from '../../src/core/ingestion/languages/python/import-helpers.js';
import { resolvePythonImportTarget } from '../../src/core/ingestion/languages/python/import-target.js';

/** Both the helper and the public adapter must respect Python's file boundary. */
function resolveBoth(files: string[], target = '.peer', fromFile = 'pkg/main.py') {
  const allFilePaths = new Set([fromFile, ...files]);
  return [
    resolvePythonImportInternal(fromFile, target, allFilePaths),
    resolvePythonImportTarget(
      { kind: 'namespace', targetRaw: target, localName: 'peer', importedName: '*' },
      { fromFile, allFilePaths },
    ),
  ];
}

describe('Python relative import file candidates', () => {
  it.each(['.ts', '.tsx', '.js', '.php', '.rb', ''])(
    'leaves a relative import unresolved when only peer%s exists',
    (extension) => {
      expect(resolveBoth([`pkg/peer${extension}`])).toEqual([null, null]);
    },
  );

  it('selects the Python module despite a same-named TypeScript file', () => {
    expect(resolveBoth(['pkg/peer.ts', 'pkg/peer.py'])).toEqual(['pkg/peer.py', 'pkg/peer.py']);
  });

  it('selects a Python package despite a same-named TypeScript file', () => {
    expect(resolveBoth(['pkg/peer.ts', 'pkg/peer/__init__.py'])).toEqual([
      'pkg/peer/__init__.py',
      'pkg/peer/__init__.py',
    ]);
  });

  it.each([
    ['.peer', 'pkg/main.py'],
    ['..peer', 'pkg/child/main.py'],
  ])('prefers a package over a module for %s from %s', (target, fromFile) => {
    expect(resolveBoth(['pkg/peer.py', 'pkg/peer/__init__.py'], target, fromFile)).toEqual([
      'pkg/peer/__init__.py',
      'pkg/peer/__init__.py',
    ]);
  });

  it('resolves a parent-relative Python module without borrowing a TypeScript file', () => {
    expect(resolveBoth(['peer.ts', 'peer.py'], '..peer')).toEqual(['peer.py', 'peer.py']);
  });
});
