/**
 * The `constructionSyntax` opt-in set is a deliberate, measured decision, not a
 * default (#2708). Every language here was checked by diffing analyzer output
 * between builds with and without the construction rule:
 *
 *   - wired      — the shape was dropped before the rule and resolves after it
 *   - NOT wired  — the shape already resolved through the language's own
 *                  capture-side path, so declaring it would be inert
 *
 * This test pins that inventory. A new entry means someone wired a language
 * without measuring it; a removed entry means a fix silently lost coverage.
 */

import { describe, it, expect } from 'vitest';
import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';

describe('constructionSyntax wiring inventory', () => {
  it('is declared for exactly the languages measured to need it', () => {
    const wired = [...SCOPE_RESOLVERS.entries()]
      .filter(([, resolver]) => resolver.constructionSyntax !== undefined)
      .map(([language, resolver]) => [language, resolver.constructionSyntax])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));

    expect(Object.fromEntries(wired)).toEqual({
      csharp: { keyword: 'new' },
      javascript: { keyword: 'new' },
      python: { bare: true },
      ruby: { selector: 'new' },
      typescript: { keyword: 'new' },
    });
  });

  it('leaves the languages that already resolve the shape unwired', () => {
    // Java resolves it via the #2564 object_creation_expression capture
    // rewrite; php/swift/dart/kotlin via their own capture-side paths.
    for (const language of ['java', 'php', 'swift', 'dart', 'kotlin'] as const) {
      const resolver = SCOPE_RESOLVERS.get(language);
      expect(resolver, `${language} resolver is registered`).toBeDefined();
      expect(resolver!.constructionSyntax, `${language} stays unwired`).toBeUndefined();
    }
  });
});
