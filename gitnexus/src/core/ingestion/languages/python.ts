/**
 * Python Language Provider
 *
 * Assembles all Python-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Python traits:
 *   - mroStrategy: 'c3' (Python C3 linearization for multiple inheritance)
 */

import type { NodeLabel } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { pythonClassConfig } from '../class-extractors/configs/python.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { typeConfig as pythonConfig } from '../type-extractors/python.js';
import { pythonExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { pythonImportConfig } from '../import-resolvers/configs/python.js';
import { PYTHON_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { pythonConfig as pythonFieldConfig } from '../field-extractors/configs/python.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { pythonMethodConfig } from '../method-extractors/configs/python.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { pythonVariableConfig } from '../variable-extractors/configs/python.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { pythonCallConfig } from '../call-extractors/configs/python.js';
import { createPythonCfgVisitor } from '../cfg/visitors/python.js';
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
import { extractDjangoRoutes } from '../route-extractors/django.js';
import { discoverDjangoRootUrls } from '../route-extractors/django-root-discovery.js';

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
  entryPointPatterns: [/^app$/, /^(get|post|put|delete|patch)_/i, /^api_/, /^view_/],
  astFrameworkPatterns: [
    {
      framework: 'fastapi',
      entryPointMultiplier: 3.0,
      reason: 'fastapi-decorator',
      patterns: ['@app.get', '@app.post', '@app.put', '@app.delete', '@router.get'],
    },
    {
      framework: 'flask',
      entryPointMultiplier: 2.8,
      reason: 'flask-decorator',
      patterns: ['@app.route', '@blueprint.route'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: PYTHON_QUERIES,
  typeConfig: pythonConfig,
  exportChecker: pythonExportChecker,
  importResolver: createImportResolver(pythonImportConfig),
  mroStrategy: 'c3',
  callExtractor: createCallExtractor(pythonCallConfig),
  fieldExtractor: createFieldExtractor(pythonFieldConfig),
  methodExtractor: createMethodExtractor(pythonMethodConfig),
  variableExtractor: createVariableExtractor(pythonVariableConfig),
  classExtractor: createClassExtractor(pythonClassConfig),
  descriptionExtractor: pythonDescriptionExtractor,
  builtInNames: BUILT_INS,
  // Django routing is whole-repo and cross-file (manage.py → settings →
  // ROOT_URLCONF → root urls.py, then include()s across files), so it runs as
  // a main-thread pass (see parse-impl's cross-file route extraction) rather
  // than the worker's single-file `isRouteFile` path. `reader` lets discovery
  // and extraction resolve any repo-relative file regardless of parse chunking.
  discoverRootRouteFiles: (files, contentMap, reader) =>
    discoverDjangoRootUrls(files, contentMap, reader),
  extractRoutes: (tree, filePath, reader, parser) =>
    parser ? extractDjangoRoutes(tree, filePath, parser, reader) : [],
  labelOverride: pythonFunctionDefinitionLabel,

  // ── RFC #909 Ring 3: scope-based resolution hooks (RFC §5) ──────────
  // Python is the first migration. See ./python/index.ts for the
  // full per-hook rationale and the canonical capture vocabulary in
  // ./python/query.ts (PYTHON_SCOPE_QUERY constant).
  emitScopeCaptures: emitPythonScopeCaptures,
  cfgVisitor: createPythonCfgVisitor(),
  interpretImport: interpretPythonImport,
  interpretTypeBinding: interpretPythonTypeBinding,
  bindingScopeFor: pythonBindingScopeFor,
  importOwningScope: pythonImportOwningScope,
  mergeBindings: (_scope, bindings) => pythonMergeBindings(bindings),
  receiverBinding: pythonReceiverBinding,
  arityCompatibility: pythonArityCompatibility,
  resolveImportTarget: resolvePythonImportTarget,
});
