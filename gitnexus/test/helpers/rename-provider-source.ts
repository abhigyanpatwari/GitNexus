import type { SupportedLanguages } from 'gitnexus-shared';
import assert from 'node:assert/strict';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';

export async function source(language: SupportedLanguages, path: string, content: string) {
  const resolver = SCOPE_RESOLVERS.get(language)!;
  assert.ok(resolver.languageProvider.rename);
  return resolver.languageProvider.rename.parseSource({
    filePath: path,
    content,
    languageProvider: resolver.languageProvider,
    scopeResolver: resolver,
  });
}
