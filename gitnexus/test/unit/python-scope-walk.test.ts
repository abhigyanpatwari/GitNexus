import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { walkPythonScopes } from '../../src/core/ingestion/languages/python/type-imports.js';

describe('walkPythonScopes unpacking targets', () => {
  it.each([
    ['a tuple assignment', 'a, b = 1, 2\n', ['a', 'b']],
    ['a for loop over pairs', 'for k, v in d.items():\n    pass\n', ['k', 'v']],
    ['a nested list target', '[a, (b, c)] = f()\n', ['a', 'b', 'c']],
    ['a starred target', 'first, *rest = xs\n', ['first', 'rest']],
  ])('finishes and binds every name in %s', async (_label, source, names) => {
    const parser = await createParserForLanguage(SupportedLanguages.Python);
    let visits = 0;
    const module = walkPythonScopes(parser.parse(source).rootNode, () => {
      if (++visits > 1000) return 'stop';
    });
    expect(visits).toBeLessThan(1000);
    for (const name of names) expect(module.bindings.has(name), name).toBe(true);
  });
});
