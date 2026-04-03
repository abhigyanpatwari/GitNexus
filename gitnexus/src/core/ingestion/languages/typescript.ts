/**
 * TypeScript and JavaScript language providers.
 *
 * Both languages share the same type extraction config (typescriptConfig),
 * export checker (tsExportChecker), and named binding extractor
 * (extractTsNamedBindings). They differ in file extensions, tree-sitter
 * queries (TypeScript grammar has interface/type nodes), and language ID.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { resolveTypescriptImport, resolveJavascriptImport } from '../import-resolvers/standard.js';
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
  importResolver: resolveTypescriptImport,
  namedBindingExtractor: extractTsNamedBindings,
  fieldExtractor: typescriptFieldExtractor,
  methodExtractor: createMethodExtractor(typescriptMethodConfig),
  builtInNames: BUILT_INS,
});

export const javascriptProvider = defineLanguage({
  id: SupportedLanguages.JavaScript,
  extensions: ['.js', '.jsx'],
  treeSitterQueries: JAVASCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: resolveJavascriptImport,
  namedBindingExtractor: extractTsNamedBindings,
  fieldExtractor: createFieldExtractor(javascriptConfig),
  methodExtractor: createMethodExtractor(javascriptMethodConfig),
  builtInNames: BUILT_INS,
});
