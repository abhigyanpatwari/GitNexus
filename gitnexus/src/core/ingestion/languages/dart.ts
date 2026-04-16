/**
 * Dart Language Provider
 *
 * Dart traits:
 *   - importSemantics: 'wildcard-leaf' (Dart imports bring everything public into scope)
 *   - exportChecker: public if no leading underscore
 *   - Dart SDK imports (dart:*) and external packages are skipped
 *   - enclosingFunctionFinder: Dart's tree-sitter grammar places function_body
 *     as a sibling of function_signature/method_signature (not as a child).
 *     The hook resolves the enclosing function by inspecting the previous sibling.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import { FUNCTION_NODE_TYPES } from '../utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { dartClassConfig } from '../class-extractors/configs/dart.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as dartConfig } from '../type-extractors/dart.js';
import { dartExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { dartImportConfig } from '../import-resolvers/configs/dart.js';
import { DART_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { dartConfig as dartFieldConfig } from '../field-extractors/configs/dart.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { dartMethodConfig } from '../method-extractors/configs/dart.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { dartVariableConfig } from '../variable-extractors/configs/dart.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { dartCallConfig } from '../call-extractors/configs/dart.js';

/**
 * Resolve the enclosing function from a `function_body` node by looking at its
 * previous sibling.  In Dart's tree-sitter grammar, function_signature and
 * function_body are siblings under program or class_body, unlike most languages
 * where the function declaration wraps both.
 *
 * Extracts the function name inline — Dart uses function_signature and
 * method_signature (which wraps function_signature) as its FUNCTION_NODE_TYPES.
 */
const dartEnclosingFunctionFinder = (
  node: SyntaxNode,
): { funcName: string; label: NodeLabel } | null => {
  if (node.type !== 'function_body') return null;
  const prev = node.previousSibling;
  if (!prev || !FUNCTION_NODE_TYPES.has(prev.type)) return null;

  // method_signature wraps function_signature — unwrap to reach the name
  let target = prev;
  let label: NodeLabel = 'Function';
  if (prev.type === 'method_signature') {
    label = 'Method';
    for (let i = 0; i < prev.childCount; i++) {
      const c = prev.child(i);
      if (c?.type === 'function_signature') {
        target = c;
        break;
      }
    }
  }
  const funcName = target.childForFieldName?.('name')?.text ?? null;
  return funcName ? { funcName, label } : null;
};

const BUILT_INS: ReadonlySet<string> = new Set([
  'setState',
  'mounted',
  'debugPrint',
  'runApp',
  'showDialog',
  'showModalBottomSheet',
  'Navigator',
  'push',
  'pushNamed',
  'pushReplacement',
  'pop',
  'maybePop',
  'ScaffoldMessenger',
  'showSnackBar',
  'deactivate',
  'reassemble',
  'debugDumpApp',
  'debugDumpRenderTree',
  'then',
  'catchError',
  'whenComplete',
  'listen',
]);

export const dartProvider = defineLanguage({
  id: SupportedLanguages.Dart,
  extensions: ['.dart'],
  treeSitterQueries: DART_QUERIES,
  typeConfig: dartConfig,
  exportChecker: dartExportChecker,
  importResolver: createImportResolver(dartImportConfig),
  importSemantics: 'wildcard-leaf',
  callExtractor: createCallExtractor(dartCallConfig),
  fieldExtractor: createFieldExtractor(dartFieldConfig),
  methodExtractor: createMethodExtractor(dartMethodConfig),
  variableExtractor: createVariableExtractor(dartVariableConfig),
  classExtractor: createClassExtractor(dartClassConfig),
  enclosingFunctionFinder: dartEnclosingFunctionFinder,
  builtInNames: BUILT_INS,
});
