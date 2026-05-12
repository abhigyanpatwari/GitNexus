/**
 * Unit tests for TypeScript ESM .js extension resolution.
 *
 * TypeScript ESM requires imports to use .js extensions even when source
 * files are .ts. The resolver must map .js → .ts (and .jsx → .tsx,
 * .mjs → .mts, .cjs → .cts) when the literal .js file does not exist.
 */

import { describe, it, expect } from 'vitest';
import { resolveImportPath } from '../../src/core/ingestion/import-resolvers/standard.js';
import { stripJsExtension } from '../../src/core/ingestion/import-resolvers/standard.js';
import { buildSuffixIndex } from '../../src/core/ingestion/import-resolvers/utils.js';
import { SupportedLanguages } from 'gitnexus-shared';

function makeCtx(files: string[]) {
  const normalized = files.map((f) => f.toLowerCase());
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

describe('TypeScript ESM .js extension resolution', () => {
  it('resolves ./utils.js to ./utils.ts when .js does not exist', () => {
    const ctx = makeCtx(['src/index.ts', 'src/utils.ts']);
    const result = resolve('src/index.ts', './utils.js', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/utils.ts');
  });

  it('resolves ./component.jsx to ./component.tsx', () => {
    const ctx = makeCtx(['src/app.ts', 'src/component.tsx']);
    const result = resolve('src/app.ts', './component.jsx', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/component.tsx');
  });

  it('resolves ./config.mjs to ./config.mts', () => {
    const ctx = makeCtx(['src/index.ts', 'src/config.mts']);
    const result = resolve('src/index.ts', './config.mjs', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/config.mts');
  });

  it('resolves ./legacy.cjs to ./legacy.cts', () => {
    const ctx = makeCtx(['src/index.ts', 'src/legacy.cts']);
    const result = resolve('src/index.ts', './legacy.cjs', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/legacy.cts');
  });

  it('prefers actual .js file when it exists', () => {
    const ctx = makeCtx(['src/index.ts', 'src/utils.js', 'src/utils.ts']);
    const result = resolve('src/index.ts', './utils.js', SupportedLanguages.TypeScript, ctx);
    expect(result).toBe('src/utils.js');
  });

  it('resolves relative path with ../ and .js extension', () => {
    const ctx = makeCtx(['src/helpers/token.ts', 'src/core/engine.ts']);
    const result = resolve(
      'src/core/engine.ts',
      '../helpers/token.js',
      SupportedLanguages.TypeScript,
      ctx,
    );
    expect(result).toBe('src/helpers/token.ts');
  });

  it('works for JavaScript language too', () => {
    const ctx = makeCtx(['src/index.js', 'src/utils.ts']);
    const result = resolve('src/index.js', './utils.js', SupportedLanguages.JavaScript, ctx);
    expect(result).toBe('src/utils.ts');
  });

  it('does NOT apply ESM fallback for non-TS/JS languages', () => {
    const ctx = makeCtx(['src/main.py', 'src/utils.ts']);
    const result = resolve('src/main.py', './utils.js', SupportedLanguages.Python, ctx);
    expect(result).toBeNull();
  });

  it('returns null when neither .js nor .ts exists', () => {
    const ctx = makeCtx(['src/index.ts']);
    const result = resolve('src/index.ts', './missing.js', SupportedLanguages.TypeScript, ctx);
    expect(result).toBeNull();
  });
});

describe('stripJsExtension', () => {
  it('strips .js', () => expect(stripJsExtension('foo/bar.js')).toBe('foo/bar'));
  it('strips .jsx', () => expect(stripJsExtension('foo/bar.jsx')).toBe('foo/bar'));
  it('strips .mjs', () => expect(stripJsExtension('foo/bar.mjs')).toBe('foo/bar'));
  it('strips .cjs', () => expect(stripJsExtension('foo/bar.cjs')).toBe('foo/bar'));
  it('returns null for .ts', () => expect(stripJsExtension('foo/bar.ts')).toBeNull());
  it('returns null for no extension', () => expect(stripJsExtension('foo/bar')).toBeNull());
});
