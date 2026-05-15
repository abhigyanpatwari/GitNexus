// gitnexus/src/core/ingestion/class-extractors/configs/elixir.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const ELIXIR_MODULE_KEYWORDS = new Set(['defmodule', 'defprotocol']);

/** Return the `target` identifier text of a call node, or undefined. */
function callKeyword(node: SyntaxNode): string | undefined {
  const t = node.childForFieldName?.('target');
  return t?.type === 'identifier' ? t.text : undefined;
}

/** Find the arguments node among named children. */
function findArguments(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'arguments') return c;
  }
  return null;
}

export const elixirClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Elixir,

  // defmodule / defprotocol are the class-like nodes (both are `call` nodes in tree-sitter)
  typeDeclarationNodes: ['call'],

  extractName(node) {
    if (!ELIXIR_MODULE_KEYWORDS.has(callKeyword(node) ?? '')) return undefined;
    const args = findArguments(node);
    if (!args) return undefined;
    for (let i = 0; i < args.namedChildCount; i++) {
      const a = args.namedChild(i);
      if (a?.type === 'alias') return a.text;
    }
    return undefined;
  },

  extractType(node) {
    const kw = callKeyword(node);
    if (kw === 'defprotocol') return 'Interface';
    if (kw === 'defmodule') return 'Class';
    return undefined;
  },
};
