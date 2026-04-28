/**
 * Python Language Provider
 *
 * Assembles all Python-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Python traits:
 *   - importSemantics: 'namespace' (Python uses namespace imports, not wildcard)
 *   - mroStrategy: 'c3' (Python C3 linearization for multiple inheritance)
 *   - namedBindingExtractor: present (from X import Y)
 */

import type { NodeLabel } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { pythonClassConfig } from '../class-extractors/configs/python.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as pythonConfig } from '../type-extractors/python.js';
import { pythonExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { pythonImportConfig } from '../import-resolvers/configs/python.js';
import { extractPythonNamedBindings } from '../named-bindings/python.js';
import { PYTHON_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { pythonConfig as pythonFieldConfig } from '../field-extractors/configs/python.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { pythonMethodConfig } from '../method-extractors/configs/python.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { pythonVariableConfig } from '../variable-extractors/configs/python.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { pythonCallConfig } from '../call-extractors/configs/python.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import type { CaptureMap } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  emitPythonScopeCaptures,
  pythonFunctionDefinitionLabel,
  interpretPythonImport,
  interpretPythonTypeBinding,
  pythonArityCompatibility,
  pythonBindingScopeFor,
  pythonImportOwningScope,
  pythonMergeBindings,
  pythonReceiverBinding,
  resolvePythonImportTarget,
} from './python/index.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'list',
  'dict',
  'set',
  'tuple',
  'append',
  'extend',
  'update',
  'type',
  'isinstance',
  'issubclass',
  'getattr',
  'setattr',
  'hasattr',
  'enumerate',
  'zip',
  'sorted',
  'reversed',
  'min',
  'max',
  'sum',
  'abs',
]);

function pythonDescriptionExtractor(
  nodeLabel: NodeLabel,
  _nodeName: string,
  captureMap: CaptureMap,
): string | undefined {
  if (nodeLabel !== 'Function' && nodeLabel !== 'Method') return undefined;
  const functionNode = captureMap['definition.function'] ?? captureMap['definition.method'];
  if (functionNode === undefined) return undefined;
  return extractPythonDocstring(functionNode);
}

function extractPythonDocstring(functionNode: SyntaxNode): string | undefined {
  const body = functionNode.childForFieldName('body');
  const firstStatement = body?.namedChild(0);
  if (firstStatement?.type !== 'expression_statement') return undefined;

  const literal = firstStatement.namedChild(0);
  if (literal?.type !== 'string') return undefined;
  return normalizePythonStringLiteral(literal.text);
}

function normalizePythonStringLiteral(text: string): string | undefined {
  const match = text.match(/^[rRuUbBfF]*("""|'''|"|')([\s\S]*)\1$/);
  const raw = match?.[2]?.trim();
  if (!raw) return undefined;
  return raw.replace(/\s+/g, ' ');
}

export const pythonProvider = defineLanguage({
  id: SupportedLanguages.Python,
  extensions: ['.py'],
  treeSitterQueries: PYTHON_QUERIES,
  typeConfig: pythonConfig,
  exportChecker: pythonExportChecker,
  importResolver: createImportResolver(pythonImportConfig),
  namedBindingExtractor: extractPythonNamedBindings,
  importSemantics: 'namespace',
  mroStrategy: 'c3',
  callExtractor: createCallExtractor(pythonCallConfig),
  fieldExtractor: createFieldExtractor(pythonFieldConfig),
  methodExtractor: createMethodExtractor(pythonMethodConfig),
  variableExtractor: createVariableExtractor(pythonVariableConfig),
  classExtractor: createClassExtractor(pythonClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.Python),
  descriptionExtractor: pythonDescriptionExtractor,
  builtInNames: BUILT_INS,
  labelOverride: pythonFunctionDefinitionLabel,

  // ── RFC #909 Ring 3: scope-based resolution hooks (RFC §5) ──────────
  // Python is the first migration. See ./python/index.ts for the
  // full per-hook rationale and the canonical capture vocabulary in
  // ./python/query.ts (PYTHON_SCOPE_QUERY constant).
  emitScopeCaptures: emitPythonScopeCaptures,
  interpretImport: interpretPythonImport,
  interpretTypeBinding: interpretPythonTypeBinding,
  bindingScopeFor: pythonBindingScopeFor,
  importOwningScope: pythonImportOwningScope,
  mergeBindings: (_scope, bindings) => pythonMergeBindings(bindings),
  receiverBinding: pythonReceiverBinding,
  arityCompatibility: pythonArityCompatibility,
  resolveImportTarget: resolvePythonImportTarget,
});
