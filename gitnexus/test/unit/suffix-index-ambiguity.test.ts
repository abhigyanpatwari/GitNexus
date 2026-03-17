/**
 * Unit tests for proximity-based import resolution.
 *
 * When two files share the same bare name (e.g. user.py in two different
 * directories), suffixResolve alone picks whichever was indexed first.
 * resolveImportPath addresses this for Python by checking the importer's
 * own directory first, mirroring Python's sys.path resolution order.
 */

import { describe, it, expect } from 'vitest';
import { buildSuffixIndex } from '../../src/core/ingestion/resolvers/utils.js';
import { resolveImportPath } from '../../src/core/ingestion/resolvers/standard.js';
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

describe('resolveImportPath — proximity-based resolution for Python', () => {
  it('resolves bare import to same-directory file when multiple files share the name', () => {
    const ctx = makeCtx([
      'app/models/user.py',   // indexed first — would win without proximity
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    // auth.py does `import user` — should get services/user.py (same directory)
    const result = resolve('app/services/auth.py', 'user', SupportedLanguages.Python, ctx);
    expect(result).toBe('app/services/user.py');
  });

  it('falls back to suffix index when no same-directory match exists', () => {
    const ctx = makeCtx([
      'app/models/user.py',
      'app/services/auth.py', // no user.py in services/
    ]);

    const result = resolve('app/services/auth.py', 'user', SupportedLanguages.Python, ctx);
    expect(result).toBe('app/models/user.py');
  });

  it('handles importer at repo root (no directory) without crashing', () => {
    const ctx = makeCtx([
      'user.py',
      'auth.py',
    ]);

    // importerDir is '' — proximity is skipped, suffix fallback used
    const result = resolve('auth.py', 'user', SupportedLanguages.Python, ctx);
    expect(result).toBe('user.py');
  });

  it('does not apply proximity for multi-segment imports (dotted paths)', () => {
    // "import utils.helpers" → pathLike = "utils/helpers" → contains '/'
    // proximity skipped; suffix fallback resolves unambiguously
    const ctx = makeCtx([
      'app/models/utils/helpers.py',
      'app/services/auth.py',
    ]);

    const result = resolve('app/services/auth.py', 'utils.helpers', SupportedLanguages.Python, ctx);
    expect(result).toBe('app/models/utils/helpers.py');
  });

  it('resolves package import via __init__.py when no bare .py in same directory', () => {
    const ctx = makeCtx([
      'app/models/__init__.py',
      'app/services/auth.py',
    ]);

    // No models.py in services/ — falls through to suffixResolve which tries models/__init__.py
    const result = resolve('app/services/auth.py', 'models', SupportedLanguages.Python, ctx);
    expect(result).toBe('app/models/__init__.py');
  });

  it('resolves PEP 328 relative import unchanged (dot prefix handled before proximity)', () => {
    const ctx = makeCtx([
      'app/services/user.py',
      'app/services/auth.py',
    ]);

    // ".user" is an explicit relative import — caught at Step 5, not proximity
    const result = resolve('app/services/auth.py', '.user', SupportedLanguages.Python, ctx);
    expect(result).toBe('app/services/user.py');
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

// ---------------------------------------------------------------------------
// Flag-based demo: same scenario, proximity ON vs OFF
// Shows exactly what the fix changes and why it matters.
// NOT meant for CI — purely for local understanding.
// ---------------------------------------------------------------------------

function resolveWithFlag(
  currentFile: string,
  importPath: string,
  ctx: ReturnType<typeof makeCtx>,
  useProximity: boolean,
): string | null {
  // Reproduce the exact tail of resolveImportPath after dot-to-slash normalisation.
  // Intentionally a local reimplementation so we can toggle proximity on/off
  // without touching production code.
  const pathLike = importPath.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  if (useProximity && !pathLike.includes('/')) {
    // O(1) exact lookup via allFiles Set — mirrors the production implementation.
    const importerDir = currentFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (importerDir) {
      const candidate = `${importerDir}/${pathLike}.py`;
      if (ctx.allFilesSet.has(candidate)) return candidate;
    }
  }

  // Global suffix fallback — what happened before the fix
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/') + '.py';
    const hit = ctx.index.get(suffix);
    if (hit) return hit;
  }
  return null;
}

describe('flag-based demo — proximity ON vs OFF (same scenario)', () => {
  const ctx = makeCtx([
    'app/models/user.py',   // indexed first — owns "user.py" in exactMap
    'app/services/user.py',
    'app/services/auth.py',
  ]);

  it('WITHOUT proximity (flag=false): returns models/user.py — wrong', () => {
    const result = resolveWithFlag('app/services/auth.py', 'user', ctx, false);
    process.stdout.write(`\n  [flag=false] import user from app/services/auth.py → resolved to: ${result}\n`);
    process.stdout.write(`               expected: app/services/user.py  ← WRONG (models/ was indexed first)\n\n`);
    expect(result).toBe('app/models/user.py');
  });

  it('WITH proximity (flag=true): returns services/user.py — correct', () => {
    const result = resolveWithFlag('app/services/auth.py', 'user', ctx, true);
    process.stdout.write(`\n  [flag=true]  import user from app/services/auth.py → resolved to: ${result}\n`);
    process.stdout.write(`               allFiles.has("app/services/user.py") = true ← CORRECT (O(1) exact lookup)\n\n`);
    expect(result).toBe('app/services/user.py');
  });
});
