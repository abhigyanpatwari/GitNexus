import type { LanguageTypeConfig } from './types.js';

/**
 * Elixir type extractor — minimal implementation.
 *
 * Elixir is dynamically typed with no mandatory type annotations.
 * Typespecs (@spec) exist but are comments to the compiler and
 * don't appear as typed AST nodes in tree-sitter-elixir. Pattern
 * matching in function heads provides structural dispatch, not type
 * dispatch, so Tier 0 declaration extraction is not applicable.
 *
 * This config is intentionally minimal. Tier 1 constructor inference
 * and Tier 2 propagation can be added as a follow-up when needed.
 */
export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: new Set<string>(),
  extractDeclaration: () => {},
  extractParameter: () => {},
};
