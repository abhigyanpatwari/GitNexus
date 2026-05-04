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
import type { AstFrameworkPatternConfig } from '../language-provider.js';
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
 * TypeScript/JavaScript: arrow_function and function_expression are
 * anonymous AST nodes — they take their name from the surrounding
 * declarative context.
 *
 * Recognised contexts:
 *   - `const foo = () => {}` (variable_declarator) → "foo"
 *   - `{ addItem: (item) => ... }` (pair / property_assignment) → "addItem"
 *     Covers Zustand stores, TanStack Query factories, React Context
 *     providers, and most other HOF-heavy idioms (issue #1166).
 *   - `const X = HOC((args) => { ... })` (arguments → call_expression →
 *     variable_declarator) → "X". Covers `React.forwardRef`, `memo`,
 *     `useCallback`, `useMemo`, `observer`, `debounce`, and other HOC
 *     factories that wrap their behaviour-defining arrow. Without this
 *     branch, every shadcn/Radix UI component (`const Button =
 *     React.forwardRef(...)`) registered as an anonymous arrow with
 *     calls inside falling back to File-level attribution. The same
 *     applied to all `useCallback` / `useMemo` callbacks bound to a
 *     const — the sole way to give them a named caller anchor.
 *
 * Returns `null` for funcName when the arrow lives in a context that has
 * no static name — bare call arguments (not bound to a const), computed
 * keys, return-from-arrow positions. The parent walk in
 * findEnclosingFunctionId then continues up to the next named ancestor
 * (or to the file).
 */
const tsExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') return null;

  const parent = node.parent;
  if (!parent) return null;

  if (parent.type === 'variable_declarator') {
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
  }

  // Object property pair: `{ addItem: (item) => ... }`.
  // tree-sitter-typescript uses `pair`; tree-sitter-javascript also exposes
  // `pair`. (Older grammars used `property_assignment`; we accept both.)
  if (parent.type === 'pair' || parent.type === 'property_assignment') {
    const keyNode = parent.childForFieldName?.('key');
    if (!keyNode) return { funcName: null, label: 'Function' };
    if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
      return { funcName: keyNode.text, label: 'Function' };
    }
    if (keyNode.type === 'string') {
      // `"add-item": () => ...` — the literal text inside the quotes.
      const fragment = keyNode.children?.find((c: SyntaxNode) => c.type === 'string_fragment');
      const text = fragment?.text ?? null;
      return { funcName: text, label: 'Function' };
    }
    // computed_property_name (`[ACTION_KEY]`) and other dynamic keys have
    // no static name — fall through anonymous.
    return { funcName: null, label: 'Function' };
  }

  // HOC-wrapped variable declarations: `const Button = forwardRef((p, r) => { ... })`,
  // `const handleClick = useCallback(() => doStuff(), [deps])`,
  // `const Card = React.memo((props) => { ... })`. The arrow's `parent` is
  // `arguments`, grandparent is `call_expression`, great-grandparent is
  // `variable_declarator`. Walk the chain up and take the variable's name
  // — the meaningful identifier the developer wrote on the LHS. Mirrors
  // the four registry-primary patterns in `typescript/query.ts`. The
  // wrapping callee (`forwardRef`, `memo`, `React.memo`, `useCallback`,
  // user-defined HOCs) is intentionally NOT constrained: any function
  // call whose result is bound to a const and whose first/positional
  // argument is an arrow takes the const's name. Chained array-method
  // calls (`const x = arr.find((y) => p(y))`) match too and produce a
  // mostly-harmless `Function:x` (consumed as a value, never invoked),
  // accepted as a small false-positive cost vs. the much larger gain of
  // capturing the React UI-component idiom.
  if (parent.type === 'arguments') {
    const callExpr = parent.parent;
    if (!callExpr || callExpr.type !== 'call_expression') {
      return { funcName: null, label: 'Function' };
    }
    const declarator = callExpr.parent;
    if (!declarator || declarator.type !== 'variable_declarator') {
      return { funcName: null, label: 'Function' };
    }
    const nameNode = declarator.childForFieldName?.('name');
    if (nameNode?.type === 'identifier') {
      return { funcName: nameNode.text, label: 'Function' };
    }
    return { funcName: null, label: 'Function' };
  }

  return { funcName: null, label: 'Function' };
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
  entryPointPatterns: [/^use[A-Z]/],
  astFrameworkPatterns: [
    {
      framework: 'nestjs',
      entryPointMultiplier: 3.2,
      reason: 'nestjs-decorator',
      patterns: ['@Controller', '@Get', '@Post', '@Put', '@Delete', '@Patch'],
    },
    {
      framework: 'expo-router',
      entryPointMultiplier: 2.5,
      reason: 'expo-router-navigation',
      patterns: [
        'router.push',
        'router.replace',
        'router.navigate',
        'useRouter',
        'useLocalSearchParams',
        'useSegments',
        'expo-router',
      ],
    },
  ] satisfies AstFrameworkPatternConfig[],
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
  entryPointPatterns: [/^use[A-Z]/],
  astFrameworkPatterns: [
    {
      framework: 'nestjs',
      entryPointMultiplier: 3.2,
      reason: 'nestjs-decorator',
      patterns: ['@Controller', '@Get', '@Post', '@Put', '@Delete', '@Patch'],
    },
    {
      framework: 'expo-router',
      entryPointMultiplier: 2.5,
      reason: 'expo-router-navigation',
      patterns: [
        'router.push',
        'router.replace',
        'router.navigate',
        'useRouter',
        'useLocalSearchParams',
        'useSegments',
        'expo-router',
      ],
    },
  ] satisfies AstFrameworkPatternConfig[],
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
