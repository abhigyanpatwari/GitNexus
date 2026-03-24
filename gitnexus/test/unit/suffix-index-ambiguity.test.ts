/**
 * Unit tests for proximity-based Python import resolution.
 *
 * When two files share the same bare name (e.g. user.py in two different
 * directories), suffixResolve alone picks whichever was indexed first.
 * resolvePythonImport addresses this by checking the importer's own directory
 * first, mirroring Python's sys.path resolution order.
 */

import { describe, it, expect } from 'vitest';
import { buildSuffixIndex, suffixResolve } from '../../src/core/ingestion/import-resolvers/utils.js';
import { resolvePythonImportInternal } from '../../src/core/ingestion/import-resolvers/python.js';
import { resolveImportPath } from '../../src/core/ingestion/import-resolvers/standard.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(files: string[]) {
  const normalized = files.map(f => f.replace(/\\/g, '/'));
  const allFilesSet = new Set(files);
  const index = buildSuffixIndex(normalized, files);
  const cache = new Map<string, string | null>();
  return { files, normalized, allFilesSet, index, cache };
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

/** For non-Python languages, delegate directly to standard resolveImportPath. */
function resolve(
  currentFile: string,
  importPath: string,
  language: SupportedLanguages,
  ctx: ReturnType<typeof makeCtx>,
): string | null {
  return resolveImportPath(
    currentFile,
    importPath,
    ctx.allFilesSet,
    ctx.files,
    ctx.normalized,
    ctx.cache,
    language,
    null,
    ctx.index,
  );
}

// ---------------------------------------------------------------------------
// Python proximity resolution
// ---------------------------------------------------------------------------

describe('resolvePythonImport — proximity-based resolution for Python', () => {
  it('resolves bare import to same-directory file when multiple files share the name', () => {
    const ctx = makeCtx([
      'app/models/user.py',   // indexed first — would win without proximity
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('falls back to suffix index when no same-directory match exists', () => {
    const ctx = makeCtx([
      'app/models/user.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/models/user.py');
  });

  it('handles importer at repo root (no directory) without crashing', () => {
    const ctx = makeCtx([
      'user.py',
      'auth.py',
    ]);

    // importerDir is '' — proximity skipped, suffix fallback used
    const result = resolvePython('auth.py', 'user', ctx);
    expect(result).toBe('user.py');
  });

  it('does not apply proximity for multi-segment imports (dotted paths)', () => {
    const ctx = makeCtx([
      'app/models/utils/helpers.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'utils.helpers', ctx);
    expect(result).toBe('app/models/utils/helpers.py');
  });

  it('resolves same-directory package (user/__init__.py) via proximity', () => {
    const ctx = makeCtx([
      'app/models/user/__init__.py',  // indexed first — would win without proximity
      'app/services/user/__init__.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'user', ctx);
    expect(result).toBe('app/services/user/__init__.py');
  });

  it('falls back to suffixResolve for __init__.py when no same-directory package exists', () => {
    const ctx = makeCtx([
      'app/models/__init__.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', 'models', ctx);
    expect(result).toBe('app/models/__init__.py');
  });

  it('handles Windows-style backslash paths in currentFile without crashing', () => {
    const ctx = makeCtx([
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app\\services\\auth.py', 'user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('resolves PEP 328 relative import (.user) to same-directory file', () => {
    const ctx = makeCtx([
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    const result = resolvePython('app/services/auth.py', '.user', ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('returns null when relative import dots exceed directory depth (PEP 328 over-traversal)', () => {
    // auth.py is at depth 1 (one directory: 'app').
    // '...user' has 3 dots → 2 upward hops required, but only 1 directory level exists.
    // CPython raises ImportError; we return null.
    const ctx = makeCtx([
      'app/auth.py',
      'user.py',
    ]);

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
    'app/services/user/model.py',   // user/ has no __init__.py
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

// ---------------------------------------------------------------------------
// Ruby: bare require does NOT use proximity
// ---------------------------------------------------------------------------

describe('resolveImportPath — Ruby bare require does not use proximity', () => {
  it('returns first-indexed file for bare require (Ruby $LOAD_PATH excludes current directory)', () => {
    const ctx = makeCtx([
      'lib/core/helpers.rb',   // indexed first
      'lib/utils/helpers.rb',
      'lib/utils/formatter.rb',
    ]);

    // Ruby bare `require 'helpers'` searches $LOAD_PATH — current directory not included.
    // No proximity bias; first-indexed file is returned, same as before.
    const result = resolve('lib/utils/formatter.rb', 'helpers', SupportedLanguages.Ruby, ctx);
    expect(result).toBe('lib/core/helpers.rb');
  });

  it('resolves require_relative (dot-prefixed) to same-directory file via generic relative resolver', () => {
    const ctx = makeCtx([
      'lib/utils/helpers.rb',
      'lib/utils/formatter.rb',
    ]);

    // require_relative arrives as "./<path>" — caught by generic relative resolver, not proximity
    const result = resolve('lib/utils/formatter.rb', './helpers', SupportedLanguages.Ruby, ctx);
    expect(result).toBe('lib/utils/helpers.rb');
  });
});

// ---------------------------------------------------------------------------
// Other languages: no proximity applied
// ---------------------------------------------------------------------------

describe('resolveImportPath — no proximity for Java or TypeScript', () => {
  it('Java: fully-qualified import resolves to the correct file via unique suffix', () => {
    const ctx = makeCtx([
      'src/com/a/User.java',
      'src/com/b/User.java',
      'src/com/b/Service.java',
    ]);

    // "com.b.User" → "com/b/User" → unique suffix; no ambiguity
    const result = resolve('src/com/b/Service.java', 'com.b.User', SupportedLanguages.Java, ctx);
    expect(result).toBe('src/com/b/User.java');
  });

  it('TypeScript: relative import resolves via generic relative resolver', () => {
    const ctx = makeCtx([
      'src/services/user.ts',
      'src/services/auth.ts',
      'src/models/user.ts',
    ]);

    // "./user" is explicit relative — resolved before proximity is checked
    const result = resolve('src/services/auth.ts', './user', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/services/user.ts');
  });
});

