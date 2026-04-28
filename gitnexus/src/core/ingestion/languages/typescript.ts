/**
 * TypeScript and JavaScript language providers.
 *
 * Both languages share the same type extraction config (typescriptConfig),
 * export checker (tsExportChecker), and named binding extractor
 * (extractTsNamedBindings). They differ in file extensions, tree-sitter
 * queries (TypeScript grammar has interface/type nodes), and language ID.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import {
  typescriptClassConfig,
  javascriptClassConfig,
} from '../class-extractors/configs/typescript-javascript.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import {
  typescriptImportConfig,
  javascriptImportConfig,
} from '../import-resolvers/configs/typescript-javascript.js';
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { TYPESCRIPT_QUERIES, JAVASCRIPT_QUERIES } from '../tree-sitter-queries.js';
import { typescriptFieldExtractor } from '../field-extractors/typescript.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javascriptConfig } from '../field-extractors/configs/typescript-javascript.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import {
  typescriptMethodConfig,
  javascriptMethodConfig,
} from '../method-extractors/configs/typescript-javascript.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import {
  typescriptVariableConfig,
  javascriptVariableConfig,
} from '../variable-extractors/configs/typescript-javascript.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import {
  typescriptCallConfig,
  javascriptCallConfig,
} from '../call-extractors/configs/typescript-javascript.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import {
  emitTsScopeCaptures,
  interpretTsImport,
  interpretTsTypeBinding,
  tsBindingScopeFor,
  tsImportOwningScope,
  tsReceiverBinding,
  typescriptMergeBindings,
  typescriptArityCompatibility,
  resolveTsImportTarget,
} from './typescript/index.js';

/**
 * TypeScript/JavaScript: arrow_function and function_expression get their name
 * from the parent variable_declarator (e.g. `const foo = () => {}`).
 */
const tsExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') return null;

  const parent = node.parent;
  if (parent?.type !== 'variable_declarator') return null;

  let nameNode = parent.childForFieldName?.('name');
  if (!nameNode) {
    for (let i = 0; i < parent.childCount; i++) {
      const c = parent.child(i);
      if (c?.type === 'identifier') {
        nameNode = c;
        break;
      }
    }
  }
  return { funcName: nameNode?.text ?? null, label: 'Function' };
};

export const BUILT_INS: ReadonlySet<string> = new Set([
  'console',
  'log',
  'warn',
  'error',
  'info',
  'debug',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'JSON',
  'parse',
  'stringify',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'resolve',
  'reject',
  'then',
  'catch',
  'finally',
  'Math',
  'Date',
  'RegExp',
  'Error',
  'require',
  'import',
  'export',
  'fetch',
  'Response',
  'Request',
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'useRef',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  'createElement',
  'createContext',
  'createRef',
  'forwardRef',
  'memo',
  'lazy',
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'slice',
  'splice',
  'concat',
  'join',
  'split',
  'push',
  'pop',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'keys',
  'values',
  'entries',
  'assign',
  'freeze',
  'seal',
  'hasOwnProperty',
  'toString',
  'valueOf',
]);

export const typescriptProvider = defineLanguage({
  id: SupportedLanguages.TypeScript,
  extensions: ['.ts', '.tsx'],
  treeSitterQueries: TYPESCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: createImportResolver(typescriptImportConfig),
  namedBindingExtractor: extractTsNamedBindings,
  callExtractor: createCallExtractor(typescriptCallConfig),
  fieldExtractor: typescriptFieldExtractor,
  methodExtractor: createMethodExtractor({
    ...typescriptMethodConfig,
    extractFunctionName: tsExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(typescriptVariableConfig),
  classExtractor: createClassExtractor(typescriptClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.TypeScript),
  builtInNames: BUILT_INS,

  // ── RFC #909 Ring 3: scope-based resolution hooks (RFC §5) ──────────
  // TypeScript is the third migration after Python and C#. See
  // ./typescript/index.ts for the full per-hook rationale and the
  // canonical capture vocabulary in ./typescript/query.ts
  // (TYPESCRIPT_SCOPE_QUERY constant).
  emitScopeCaptures: emitTsScopeCaptures,
  interpretImport: interpretTsImport,
  interpretTypeBinding: interpretTsTypeBinding,
  bindingScopeFor: tsBindingScopeFor,
  importOwningScope: tsImportOwningScope,
  // Merge precedence is decided from BindingRef origin + declaration
  // space only. The central finalizer already calls this per (scope,
  // name), so the Scope object itself intentionally does not affect
  // TypeScript declaration merging.
  mergeBindings: (_scope, bindings) => typescriptMergeBindings(bindings),
  receiverBinding: tsReceiverBinding,
  arityCompatibility: typescriptArityCompatibility,
  resolveImportTarget: resolveTsImportTarget,
});

export const javascriptProvider = defineLanguage({
  id: SupportedLanguages.JavaScript,
  extensions: ['.js', '.jsx'],
  treeSitterQueries: JAVASCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: createImportResolver(javascriptImportConfig),
  namedBindingExtractor: extractTsNamedBindings,
  callExtractor: createCallExtractor(javascriptCallConfig),
  fieldExtractor: createFieldExtractor(javascriptConfig),
  methodExtractor: createMethodExtractor({
    ...javascriptMethodConfig,
    extractFunctionName: tsExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(javascriptVariableConfig),
  classExtractor: createClassExtractor(javascriptClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.JavaScript),
  builtInNames: BUILT_INS,
});
