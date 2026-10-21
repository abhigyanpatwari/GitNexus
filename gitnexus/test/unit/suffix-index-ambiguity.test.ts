/**
 * Unit tests for proximity-based Python import resolution.
 *
 * When two files share the same bare name (e.g. user.py in two different
 * directories), suffixResolve alone picks whichever was indexed first.
 * resolvePythonImport addresses this by checking the importer's own directory
 * first, mirroring Python's sys.path resolution order.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSuffixIndex,
  suffixResolve,
} from '../../src/core/ingestion/import-resolvers/utils.js';
import { resolvePythonImportInternal } from '../../src/core/ingestion/import-resolvers/python.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(files: string[]) {
  const normalized = files.map((f) => f.replace(/\\/g, '/'));
  const allFilesSet = new Set(files);
  const index = buildSuffixIndex(normalized, files);
  return { files, normalized, allFilesSet, index };
}

/** Simulate the full dispatch: resolvePythonImport first, then suffixResolve fallback. */
function resolvePython(
  currentFile: string,
  importPath: string,
  ctx: ReturnType<typeof makeCtx>,
): string | null {
  const proximity = resolvePythonImportInternal(currentFile, importPath, ctx.allFilesSet);
  if (proximity) return proximity;
  if (importPath.startsWith('.')) return null;
  const pathLike = importPath.replace(/\./g, '/');
  const parts = pathLike.split('/').filter(Boolean);
  return suffixResolve(parts, ctx.normalized, ctx.files, ctx.index);
}

// ---------------------------------------------------------------------------
// Python proximity resolution
// ---------------------------------------------------------------------------

describe('resolvePythonImport — proximity-based resolution for Python', () => {
  it('resolves bare import to same-directory file when multiple files share the name', () => {
    const ctx = makeCtx([
      'app/models/user.py', // indexed first — would win without proximity
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('falls back to suffix index when no same-directory match exists', () => {
    const ctx = makeCtx(['app/models/user.py', 'app/services/auth.py']);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/models/user.py');
  });

  it('handles importer at repo root (no directory) without crashing', () => {
    const ctx = makeCtx(['user.py', 'auth.py']);

    // importerDir is '' — proximity skipped, suffix fallback used
    const result = resolvePython('auth.py', 'user', ctx);
    expect(result).toBe('user.py');
  });

  it('does not apply proximity for multi-segment imports (dotted paths)', () => {
    const ctx = makeCtx(['app/models/utils/helpers.py', 'app/services/auth.py']);

    const result = resolvePython('app/services/auth.py', 'utils.helpers', ctx);
    expect(result).toBe('app/models/utils/helpers.py');
  });

  it('resolves same-directory package (user/__init__.py) via proximity', () => {
    const ctx = makeCtx([
      'app/models/user/__init__.py', // indexed first — would win without proximity
      'app/services/user/__init__.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/services/user/__init__.py');
  });

  it('falls back to suffixResolve for __init__.py when no same-directory package exists', () => {
    const ctx = makeCtx(['app/models/__init__.py', 'app/services/auth.py']);

    const result = resolvePython('app/services/auth.py', 'models', ctx);
    expect(result).toBe('app/models/__init__.py');
  });

  it('handles Windows-style backslash paths in currentFile without crashing', () => {
    const ctx = makeCtx(['app/services/user.py', 'app/services/auth.py']);

    const result = resolvePython('app\\services\\auth.py', 'user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('resolves PEP 328 relative import (.user) to same-directory file', () => {
    const ctx = makeCtx(['app/services/user.py', 'app/services/auth.py']);

    const result = resolvePython('app/services/auth.py', '.user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('returns null when relative import dots exceed directory depth (PEP 328 over-traversal)', () => {
    // auth.py is at depth 1 (one directory: 'app').
    // '...user' has 3 dots → 2 upward hops required, but only 1 directory level exists.
    // CPython raises ImportError; we return null.
    const ctx = makeCtx(['app/auth.py', 'user.py']);

    const result = resolvePython('app/auth.py', '...user', ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Namespace packages (PEP 420) — directory with no __init__.py
// ---------------------------------------------------------------------------

describe('resolvePythonImport — namespace packages (no __init__.py)', () => {
  // user/ exists as a namespace package: no __init__.py, only submodules.
  const files = [
    'app/services/auth.py',
    'app/services/user/model.py', // user/ has no __init__.py
    'app/services/user/queries.py',
  ];

  it('bare import of namespace package returns null (no file to resolve to)', () => {
    // `import user` — proximity finds neither user.py nor user/__init__.py.
    // suffixResolve also finds nothing because no file is literally named "user".
    // This is expected: CPython itself sets user.__file__ = None for namespace packages.
    const ctx = makeCtx(files);
    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBeNull();
  });

  it('submodule form resolves correctly via suffixResolve fallback', () => {
    // `import user.model` — multi-segment, proximity skipped, suffixResolve finds user/model.py.
    const ctx = makeCtx(files);
    const result = resolvePython('app/services/auth.py', 'user.model', ctx);
    expect(result).toBe('app/services/user/model.py');
  });
});
