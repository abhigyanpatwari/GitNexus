/**
 * Shared AST utilities for the embedding pipeline.
 * Centralizes parser caching and tree-sitter node lookups
 * used by both chunker.ts and structural-extractor.ts.
 */

import { getLanguageFromFilename } from 'gitnexus-shared';
import {
  createParserForLanguage,
  isLanguageAvailable,
  resolveLanguageKey,
} from '../tree-sitter/parser-loader.js';

const parserCache = new Map<string, any>();

/**
 * Ensure parser is initialized and language is loaded, then parse content.
 * Returns null if language is unavailable or parsing fails.
 */
export const ensureAndParse = async (content: string, filePath: string): Promise<any | null> => {
  const language = getLanguageFromFilename(filePath);
  if (!language) return null;
  if (!isLanguageAvailable(language)) return null;

  const parserKey = resolveLanguageKey(language, filePath);
  let parserInstance = parserCache.get(parserKey);
  if (!parserInstance) {
    parserInstance = await createParserForLanguage(language, filePath);
    parserCache.set(parserKey, parserInstance);
  }

  return parserInstance.parse(content);
};

const FUNCTION_LIKE_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'method_declaration',
  'method_definition',
  'function_item',
  'function_signature_item',
  'arrow_function',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'async_function_declaration',
  'async_arrow_function',
  'constructor_declaration',
  'constructor_definition',
  'compact_constructor_declaration',
  'short_function_declaration',
  'proc_declaration',
  'func_literal',
  'local_function_statement',
  'anonymous_function',
  'lambda_literal',
  'init_declaration',
  'deinit_declaration',
]);

/**
 * Find the first function/method-like declaration in a snippet AST.
 * Used by the chunker when parsing node.content where absolute line
 * numbers don't apply.
 */
export const findFunctionNode = (root: any): any | null => {
  // Iterative DFS — avoids stack overflow on deeply nested ASTs.
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (FUNCTION_LIKE_TYPES.has(node.type)) return node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return null;
};

/**
 * Find the first class/struct/interface/enum-like declaration in an AST.
 * Used when parsing node.content (a snippet, not a full file) where
 * absolute line numbers don't apply.
 */
export const findDeclarationNode = (root: any): any | null => {
  const CLASS_LIKE_TYPES = new Set([
    'class_declaration',
    'class_definition',
    'struct_declaration',
    'struct_item',
    'interface_declaration',
    'interface_definition',
    'enum_declaration',
    'enum_item',
    'type_declaration', // Go: type X struct
    'declaration', // Go: type X struct
    'object_declaration', // Kotlin: object
    'impl_item', // Rust: impl
  ]);

  // Iterative DFS — avoids stack overflow on deeply nested ASTs.
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (CLASS_LIKE_TYPES.has(node.type)) return node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return null;
};
