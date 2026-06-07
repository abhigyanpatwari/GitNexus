// gitnexus/src/core/ingestion/variable-extractors/generic.ts

/**
 * Generic table-driven variable extractor factory.
 *
 * Follows the same config+factory pattern as field-extractors/generic.ts.
 * Define a VariableExtractionConfig per language and generate extractors
 * from configs. The factory converts node type arrays to Sets at construction
 * time for O(1) lookups.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  VariableExtractionConfig,
  VariableExtractor,
  VariableExtractorContext,
  VariableInfo,
  VariableScope,
} from '../variable-types.js';

/**
 * Type-declaration node types whose body can be a bare `block`. tree-sitter-python
 * models a class body as a `block` node — the same node type used for function and
 * control-flow bodies — so a class attribute would otherwise look block-scoped. Most
 * other grammars give class bodies dedicated node types (`class_body`,
 * `declaration_list`, `body_statement`), which are not in the block-scope list below,
 * so this guard is a no-op for them but keeps the rule language-agnostic.
 */
const CLASS_LIKE_CONTAINERS = new Set<string>([
  'class_definition',
  'class_declaration',
  'class_specifier',
  'struct_item',
  'impl_item',
  'trait_item',
  'interface_declaration',
  'enum_declaration',
  'object_declaration',
]);

/**
 * Create a VariableExtractor from a declarative config.
 */
export function createVariableExtractor(config: VariableExtractionConfig): VariableExtractor {
  const staticNodeSet = new Set(config.staticNodeTypes);
  // Combined set for fast isVariableDeclaration checks
  const allNodeTypes = new Set([
    ...config.constNodeTypes,
    ...config.staticNodeTypes,
    ...config.variableNodeTypes,
  ]);

  function determineScope(node: SyntaxNode): VariableScope {
    // Walk up to determine scope:
    // - 'module': node is inside a top-level program/module/source_file container
    // - 'block': node is inside a function, method, or block scope
    // - 'file': fallback when no recognizable container is found (e.g., standalone snippets)
    let current = node.parent;
    while (current) {
      const t = current.type;
      // Top-level program/module nodes indicate module/file scope
      if (
        t === 'program' ||
        t === 'source_file' ||
        t === 'module' ||
        t === 'translation_unit' ||
        t === 'compilation_unit'
      ) {
        return 'module';
      }
      // Function/method boundaries indicate block scope
      if (
        t === 'function_declaration' ||
        t === 'function_definition' ||
        t === 'function_item' ||
        t === 'method_declaration' ||
        t === 'method_definition' ||
        t === 'arrow_function' ||
        t === 'function_expression' ||
        t === 'lambda' ||
        t === 'function_body' ||
        t === 'compound_statement'
      ) {
        return 'block';
      }
      // A bare `block` is block scope UNLESS it is a class body. A class member
      // (e.g. Python `class C: MAX = 100`) is not an inert function-local — keep
      // walking so it resolves to its true enclosing scope ('module' for a
      // top-level class) instead of being misclassified and pruned.
      if (t === 'block' && !(current.parent && CLASS_LIKE_CONTAINERS.has(current.parent.type))) {
        return 'block';
      }
      current = current.parent;
    }
    return 'file';
  }

  return {
    language: config.language,

    isVariableDeclaration(node: SyntaxNode): boolean {
      return allNodeTypes.has(node.type);
    },

    extract(node: SyntaxNode, context: VariableExtractorContext): VariableInfo | null {
      return this.extractAll(node, context)[0] ?? null;
    },

    extractAll(node: SyntaxNode, context: VariableExtractorContext): VariableInfo[] {
      if (!allNodeTypes.has(node.type)) return [];

      const names = config.extractNames
        ? config.extractNames(node)
        : [config.extractName(node)].filter((name): name is string => Boolean(name));
      if (names.length === 0) return [];

      // isConst/isStatic: node type membership is a hint, but config.isConst/isStatic
      // has final say. For languages where const and non-const share a node type
      // (e.g., TS lexical_declaration for both const and let), config.isConst disambiguates.
      const isConst = config.isConst(node);
      const isStatic = staticNodeSet.has(node.type) || config.isStatic(node);
      const isMutable = config.isMutable(node);
      const scope = determineScope(node);

      return names.map((name) => ({
        name,
        type: config.extractTypeForName?.(node, name) ?? config.extractType(node) ?? null,
        visibility: config.extractVisibilityForName?.(node, name) ?? config.extractVisibility(node),
        isConst,
        isStatic,
        isMutable,
        scope,
        sourceFile: context.filePath,
        line: node.startPosition.row + 1,
      }));
    },
  };
}
