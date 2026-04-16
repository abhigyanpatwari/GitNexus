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
      // Function/method/block boundaries indicate block scope
      if (
        t === 'function_declaration' ||
        t === 'function_definition' ||
        t === 'function_item' ||
        t === 'method_declaration' ||
        t === 'method_definition' ||
        t === 'arrow_function' ||
        t === 'function_expression' ||
        t === 'lambda' ||
        t === 'block' ||
        t === 'function_body' ||
        t === 'compound_statement'
      ) {
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
      if (!allNodeTypes.has(node.type)) return null;

      const name = config.extractName(node);
      if (!name) return null;

      const type = config.extractType(node) ?? null;
      const visibility = config.extractVisibility(node);
      // isConst/isStatic: node type membership is a hint, but config.isConst/isStatic
      // has final say. For languages where const and non-const share a node type
      // (e.g., TS lexical_declaration for both const and let), config.isConst disambiguates.
      const isConst = config.isConst(node);
      const isStatic = staticNodeSet.has(node.type) || config.isStatic(node);
      const isMutable = config.isMutable(node);
      const scope = determineScope(node);

      return {
        name,
        type,
        visibility,
        isConst,
        isStatic,
        isMutable,
        scope,
        sourceFile: context.filePath,
        line: node.startPosition.row + 1,
      };
    },
  };
}
