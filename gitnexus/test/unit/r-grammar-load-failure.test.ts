/**
 * A native R grammar that fails to load must disable R parsing only. The binding is loaded
 * lazily through the shared grammar loader (like Kotlin's), never by a static import that would
 * take every module importing the R provider, and the parse worker, down with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

// A static `import R from '@eagleoutice/tree-sitter-r'` anywhere under the R provider would throw
// here at module load.
vi.mock('@eagleoutice/tree-sitter-r', () => {
  throw new Error('No native build was found (simulated)');
});

// The shared loader reaches the package through `createRequire`, which vi.mock cannot intercept,
// so the R row of the grammar table is made to fail instead.
vi.mock('../../src/core/tree-sitter/grammar-sources.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/core/tree-sitter/grammar-sources.js')>();
  return {
    ...actual,
    GRAMMAR_SOURCES: {
      ...actual.GRAMMAR_SOURCES,
      [SupportedLanguages.R]: {
        ...actual.GRAMMAR_SOURCES[SupportedLanguages.R],
        load: () => {
          throw new Error('No native build was found (simulated)');
        },
      },
    },
  };
});

describe('R grammar load failure', () => {
  it('importing the R provider and the language registry does not load the grammar', async () => {
    await expect(import('../../src/core/ingestion/languages/index.js')).resolves.toBeDefined();
    await expect(
      import('../../src/core/ingestion/languages/r/scope-resolver.js'),
    ).resolves.toBeDefined();
  });

  it('reports R unavailable and leaves other languages available', async () => {
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isLanguageAvailable(SupportedLanguages.R)).toBe(false);
    expect(isLanguageAvailable(SupportedLanguages.JavaScript)).toBe(true);
  });

  it('fails only when R parsing is actually used', async () => {
    const { getRParser, getRScopeQuery } =
      await import('../../src/core/ingestion/languages/r/query.js');
    expect(() => getRParser()).toThrow(/No native build/);
    expect(() => getRScopeQuery()).toThrow(/No native build/);
  });

  it('does not cache a parser whose language failed to load', async () => {
    const { getRParser } = await import('../../src/core/ingestion/languages/r/query.js');
    // The first call fails; a later call must fail the same way (or retry), never return a
    // parser that has no language set.
    expect(() => getRParser()).toThrow(/No native build/);
    expect(() => getRParser()).toThrow(/No native build/);
  });

  it('keeps the parse worker from importing the grammar statically', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/ingestion/workers/parse-worker.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]@eagleoutice\/tree-sitter-r['"]/);
    expect(source).toMatch(/getLanguageGrammar\(SupportedLanguages\.R\)/);
  });
});
