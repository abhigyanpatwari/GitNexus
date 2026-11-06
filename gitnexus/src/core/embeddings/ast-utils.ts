/**
 * Shared AST utilities for the embedding pipeline.
 * Centralizes parser caching and tree-sitter node lookups
 * used by both chunker.ts and structural-extractor.ts.
 */

import {
  createParserForLanguage,
  isLanguageAvailable,
  resolveLanguageKey,
} from '../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../tree-sitter/safe-parse.js';
import { extractNotebookPython, isNotebookPath } from '../ingestion/ipynb-extractor.js';

const parserCache = new Map<string, any>();

/**
 * Ensure parser is initialized and language is loaded, then parse content.
 * Returns null if language is unavailable or parsing fails.
 */
export const ensureAndParse = async (content: string, filePath: string): Promise<any | null> => {
  const { getLanguageForFileContent, getProvider } =
    await import('../ingestion/languages/index.js');
  // Same classifier as ingest. Filename-only maps `.h` → C++, so Objective-C
  // headers (and method snippets from those headers) would parse with the
  // wrong grammar and miss class_interface / protocol_declaration / methods.
  const language = getLanguageForFileContent(filePath, content);
  if (!language) return null;
  if (!isLanguageAvailable(language)) return null;

  const parserKey = resolveLanguageKey(language, filePath);
  let parserInstance = parserCache.get(parserKey);
  if (!parserInstance) {
    parserInstance = await createParserForLanguage(language, filePath);
    parserCache.set(parserKey, parserInstance);
  }

  // Same text the ingestion worker parses — otherwise a provider whose
  // `preprocessSource` repairs a declaration (Swift conditional directives,
  // C++ UE macros, Dart extension types) would leave embeddings looking at an
  // error-recovered tree. Resolved from `language` so the transform and the
  // parser always come from the same provider. Length-preserving, so node
  // offsets still index `content` except for `.ipynb`, which is replaced by
  // concatenated code-cell Python (same as the parse worker).
  const provider = getProvider(language);
  if (isNotebookPath(filePath)) {
    const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (body.trimStart().startsWith('{')) {
      const extracted = extractNotebookPython(content);
      if (!extracted) return null;
      const parseContent =
        provider.preprocessSource?.(extracted.pythonSource, filePath) ?? extracted.pythonSource;
      return parseSourceSafe(parserInstance, parseContent);
    }
  }

  const parseContent = provider.preprocessSource?.(content, filePath) ?? content;
  return parseSourceSafe(parserInstance, parseContent);
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
 * Find a declaration of one of the supplied types in a snippet AST.
 * Without a name, return the first match. With a name, prefer that match
 * and fall back only when the snippet has a single candidate.
 * Snippet offsets are relative to node.content, not the original file.
 */
const findSnippetNode = (
  root: any,
  types: ReadonlySet<string>,
  expectedName?: string,
): any | null => {
  // Iterative DFS — avoids stack overflow on deeply nested ASTs.
  const stack = [root];
  let first: any = null;
  let candidates = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (types.has(node.type)) {
      if (expectedName === undefined) return node;
      let name = node.childForFieldName?.('name')?.text;
      // Kotlin class/object names are direct children without a field name.
      // On callables, a direct type_identifier can instead be the return type.
      if (!name && (node.type === 'class_declaration' || node.type === 'object_declaration')) {
        name = node.namedChildren?.find((child: any) => child.type === 'type_identifier')?.text;
      }
      name ??= node.parent?.childForFieldName?.('name')?.text;
      if (name === expectedName) return node;
      first ??= node;
      candidates++;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  // Some providers expose qualified names or anonymous declarations. A unique
  // declaration is still unambiguous; multiple unmatched siblings are not.
  return candidates === 1 ? first : null;
};

export const findFunctionNode = (root: any, expectedName?: string): any | null =>
  findSnippetNode(root, FUNCTION_LIKE_TYPES, expectedName);

const CLASS_LIKE_TYPES = new Set([
  'class_declaration',
  'class_definition',
  'class_specifier',
  'struct_declaration',
  'struct_item',
  'interface_declaration',
  'interface_definition',
  'protocol_declaration', // Objective-C protocol
  'class_interface', // Objective-C class, category, or extension
  'class_implementation', // Objective-C implementation
  'enum_declaration',
  'enum_item',
  'type_declaration', // Go: type X struct
  'declaration', // Go: type X struct
  'object_declaration', // Kotlin: object
  'impl_item', // Rust: impl
]);

export const findDeclarationNode = (root: any, expectedName?: string): any | null =>
  findSnippetNode(root, CLASS_LIKE_TYPES, expectedName);
