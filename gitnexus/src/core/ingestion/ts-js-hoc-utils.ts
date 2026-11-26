import path from 'node:path';

import type { SyntaxNode } from './utils/ast-helpers.js';
import { decodeIdentifierEscapes } from './utils/ecmascript-literals.js';

// Member-expression callees that should never classify a callback-wrapped
// binding as a top-level Function. This covers callback-taking Array methods
// plus a few value-returning methods that share the same AST shape.
export const ARRAY_METHOD_HOC_BLOCKLIST = [
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'flatMap',
  'sort',
  'splice',
  'slice',
  'concat',
  'fill',
  'copyWithin',
  'join',
  'flat',
  'at',
  'entries',
  'keys',
  'values',
  'indexOf',
  'lastIndexOf',
  'includes',
  'pop',
  'push',
  'shift',
  'unshift',
  'reverse',
  'reduceRight',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
  'then',
  'catch',
  'finally',
  'from',
] as const;

export const ARRAY_METHOD_HOC_BLOCKLIST_SET: ReadonlySet<string> = new Set(
  ARRAY_METHOD_HOC_BLOCKLIST,
);

// Identifier-callee default exports stay intentionally conservative: only a
// few obvious callback-taking built-ins are suppressed here. Framework HOCs
// like defineEventHandler still pass through and are named from the module.
export const DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST = [
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
] as const;

export const DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET: ReadonlySet<string> = new Set(
  DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST,
);

export const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'flatMap',
  'sort',
]);

export function buildNotAnyOfPredicate(captureName: string, values: readonly string[]): string {
  return `(#not-any-of? @${captureName} ${values.map((value) => `"${value}"`).join(' ')})`;
}

export const ARRAY_METHOD_NOT_ANY_OF_PREDICATE = buildNotAnyOfPredicate(
  'callee',
  ARRAY_METHOD_HOC_BLOCKLIST,
);

// `#not-any-of?` cannot share a query with another `#not-any-of?` on a
// different capture: the earlier predicate is ignored. Pair-HOC rules already
// use `#not-any-of? @callee`, so the identifier blocklist is `#not-eq?`
// chains on `@hoc` instead. Same names, same capture.
export const DEFAULT_EXPORT_IDENTIFIER_NOT_ANY_OF_PREDICATE =
  DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST.map((value) => `(#not-eq? @hoc "${value}")`).join('\n  ');

/**
 * Wrapper chains (outermost first) a callable initializer may sit under and
 * still bind the declared name: `const F = (fn)`, `fn as T`, `fn satisfies T`,
 * and the parenthesized arrow an `as` / `satisfies` needs
 * (`((p) => …) as FC`). JavaScript has only the parentheses.
 */
export const TS_INITIALIZER_WRAPPERS: readonly (readonly string[])[] = [
  ['parenthesized_expression'],
  ['as_expression'],
  ['satisfies_expression'],
  ['as_expression', 'parenthesized_expression'],
  ['satisfies_expression', 'parenthesized_expression'],
];
export const JS_INITIALIZER_WRAPPERS: readonly (readonly string[])[] = [
  ['parenthesized_expression'],
];

/**
 * Declaration patterns for a callable initializer under one wrapper chain: a
 * function / arrow / generator expression, or one HOC call around an inline
 * function (`forwardRef((p, r) => …) as FC`). The same shapes the plain
 * `variable_declarator` rules declare as Functions; nested HOCs stay out,
 * as there. `name` / `fn` / `definition` are the query's own capture names
 * (`fn` and `definition` may be empty). `exportVariants` adds the
 * `export_statement` forms the definition queries use so an exported binding's
 * `@definition.const` twin is claimed by the Function (#2687).
 */
export function wrappedCallableDeclarationQueries(
  chains: readonly (readonly string[])[],
  captures: {
    readonly name: string;
    readonly fn: string;
    readonly definition: string;
    readonly exportVariants?: boolean;
  },
): string {
  const fn = `[(arrow_function) (function_expression)]${captures.fn}`;
  const values: { value: string; predicate?: string }[] = [
    { value: `[(arrow_function) (function_expression) (generator_function)]${captures.fn}` },
    { value: `(call_expression function: (identifier) arguments: (arguments ${fn}))` },
    {
      value: `(call_expression function: (member_expression property: (property_identifier) @callee) arguments: (arguments ${fn}))`,
      predicate: ARRAY_METHOD_NOT_ANY_OF_PREDICATE,
    },
  ];
  const patterns: string[] = [];
  for (const chain of chains)
    for (const { value, predicate } of values)
      for (const declaration of ['lexical_declaration', 'variable_declaration']) {
        const wrapped = chain.reduceRight((inner, wrapper) => `(${wrapper} ${inner})`, value);
        const pattern = `(${declaration}\n  (variable_declarator\n    name: (identifier) ${captures.name}\n    value: ${wrapped})${predicate ? `\n  ${predicate}` : ''})`;
        patterns.push(`${pattern}${captures.definition}`);
        if (captures.exportVariants)
          patterns.push(`(export_statement\n  declaration: ${pattern})${captures.definition}`);
      }
  return patterns.join('\n\n');
}

export function deriveDefaultExportHocName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  // Use individual path.posix helpers instead of path.posix.parse() to avoid
  // triggering the require-safe-parse ESLint rule (which treats any .parse()
  // call in src/core/ as a potential unsafe tree-sitter direct-parse).
  const ext = path.posix.extname(normalized);
  const name = path.posix.basename(normalized, ext);
  const dir = path.posix.dirname(normalized);

  if (name === 'index') {
    const parent = path.posix.basename(dir);
    if (parent !== '' && parent !== '.' && parent !== '/') return parent;
  }

  return name || 'default';
}

export function isDefaultExportHocFunctionNode(node: SyntaxNode): boolean {
  const args = node.parent;
  if (args === null || args.type !== 'arguments') return false;

  const callExpr = args.parent;
  if (callExpr === null || callExpr.type !== 'call_expression') return false;

  return callExpr.parent?.type === 'export_statement';
}

export function isBlockedDefaultExportHoc(node: SyntaxNode): boolean {
  if (!isDefaultExportHocFunctionNode(node)) return false;

  const callExpr = node.parent?.parent;
  if (callExpr === null || callExpr?.type !== 'call_expression') return false;

  const callee = callExpr.childForFieldName?.('function');
  if (callee?.type === 'identifier' && DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET.has(callee.text))
    return true;
  // `memo(Card, (a, b) => …)`: the wrapper publishes the local `Card`; the
  // inline function is a helper argument (a comparator), not the export.
  let root: SyntaxNode = callExpr;
  while (root.parent !== null) root = root.parent;
  return wrappedDefaultLocal(callExpr, root) !== undefined;
}

/** Expression wrappers that leave the exported value unchanged. */
const TRANSPARENT_EXPRESSIONS: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
]);

/** `(x)`, `x as T`, `x satisfies T`, `x!` → `x`. */
export function unwrapTransparentExpression(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (TRANSPARENT_EXPRESSIONS.has(current.type) && current.namedChildren[0] !== undefined)
    current = current.namedChildren[0];
  return current;
}

/** Wrappers that return a component standing in for their first argument. */
const COMPONENT_WRAPPERS: ReadonlySet<string> = new Set(['memo', 'forwardRef', 'observer']);
/** Factories whose result is such a wrapper: `connect(mapState)(Card)`. */
const HOC_FACTORIES: ReadonlySet<string> = new Set(['connect', 'compose', 'inject']);
const HOC_NAME = /^with[A-Z]/;

/** `memo`, `React.memo` → `memo`; anything else has no static name. */
function calleeName(callee: SyntaxNode | null): string | undefined {
  const node = callee?.type === 'member_expression' ? callee.childForFieldName('property') : callee;
  return node?.type === 'identifier' || node?.type === 'property_identifier'
    ? decodeIdentifierEscapes(node.text)
    : undefined;
}

/**
 * Does this callee return a wrapped version of its first argument? Known
 * wrappers (`memo`, `React.memo`, `forwardRef`, `observer`), `withX` HOCs, and
 * the HOC a known factory returns (`connect(m)(Card)`, `withStyles(s)(Card)`).
 * Any other call may build a value from the argument (`createElement(Card)`,
 * `createApp(config)(App)`), which is not the argument itself.
 */
function isComponentWrapperCallee(callee: SyntaxNode | null): boolean {
  if (callee?.type === 'call_expression') {
    const factory = calleeName(callee.childForFieldName('function'));
    return factory !== undefined && (HOC_FACTORIES.has(factory) || HOC_NAME.test(factory));
  }
  const name = calleeName(callee);
  return name !== undefined && (COMPONENT_WRAPPERS.has(name) || HOC_NAME.test(name));
}

function callArguments(call: SyntaxNode): SyntaxNode[] | undefined {
  const args = call.childForFieldName('arguments');
  if (args?.type !== 'arguments') return undefined;
  return args.namedChildren.filter((arg) => arg.type !== 'comment');
}

/**
 * Follow first arguments through component wrappers and `as` / `satisfies` /
 * parentheses / `!`: `(memo(forwardRef(x)) as T)` → `x`. Undefined at any
 * other call, which may build a different value.
 */
function unwrapComponentWrappers(node: SyntaxNode): SyntaxNode | undefined {
  let current = unwrapTransparentExpression(node);
  while (current.type === 'call_expression') {
    if (!isComponentWrapperCallee(current.childForFieldName('function'))) return undefined;
    const [first] = callArguments(current) ?? [];
    if (first === undefined) return undefined;
    current = unwrapTransparentExpression(first);
  }
  return current;
}

const CALLABLE_DECLARATIONS: ReadonlySet<string> = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);
const CALLABLE_VALUES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'class',
]);

/**
 * Is `name` a top-level function or class: declared directly, or bound to a
 * function or class expression, bare or inside component wrappers
 * (`const Field = forwardRef((p, r) => …)`)? Any other initializer
 * (`createStore(() => …)`, `{ … }`) is a value, not the component.
 */
function declaresTopLevelCallable(root: SyntaxNode, name: string): boolean {
  return root.namedChildren.some((stmt) => {
    const declaration =
      stmt.type === 'export_statement' ? stmt.childForFieldName('declaration') : stmt;
    if (declaration === null) return false;
    if (CALLABLE_DECLARATIONS.has(declaration.type))
      return decodeIdentifierEscapes(declaration.childForFieldName('name')?.text ?? '') === name;
    if (declaration.type !== 'lexical_declaration' && declaration.type !== 'variable_declaration')
      return false;
    return declaration.namedChildren.some((declarator) => {
      const binding = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      return (
        binding?.type === 'identifier' &&
        decodeIdentifierEscapes(binding.text) === name &&
        value !== null &&
        CALLABLE_VALUES.has(unwrapComponentWrappers(value)?.type ?? '')
      );
    });
  });
}

/**
 * The top-level function or class a wrapper call exports: `memo(Card)`,
 * `React.memo(Card, areEqual)`, `memo(forwardRef(Card))` and
 * `connect(mapState)(Card)` all name `Card`, the first argument unwrapped
 * through nested component wrappers (`isComponentWrapperCallee`). An inline
 * first argument is not a name: the synthesized HOC default above owns it.
 */
export function wrappedDefaultLocal(call: SyntaxNode, root: SyntaxNode): string | undefined {
  const wrapped = unwrapComponentWrappers(call);
  if (wrapped?.type !== 'identifier') return undefined;
  const name = decodeIdentifierEscapes(wrapped.text);
  return declaresTopLevelCallable(root, name) ? name : undefined;
}

// Core check on a call expression: does it register a callback with a built-in
// that never stores the callback as a named callable? Identifier callees
// (timers/microtasks) use the export-default blocklist; member callees use the
// array/promise-method blocklist. Only calls that actually receive a function
// argument qualify.
export function isBlockedCallbackRegistrationCall(
  callExpr: SyntaxNode | null | undefined,
): boolean {
  if (callExpr === null || callExpr === undefined || callExpr.type !== 'call_expression') {
    return false;
  }

  const callee = callExpr.childForFieldName?.('function');
  let blocked = false;
  if (callee?.type === 'identifier') {
    blocked = DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET.has(callee.text);
  } else if (callee?.type === 'member_expression') {
    const property = callee.childForFieldName?.('property');
    blocked =
      property?.type === 'property_identifier' && ARRAY_METHOD_HOC_BLOCKLIST_SET.has(property.text);
  }
  if (!blocked) return false;

  const args = callExpr.childForFieldName?.('arguments');
  return (
    args !== null &&
    args !== undefined &&
    args.namedChildren.some(
      (child) => child.type === 'arrow_function' || child.type === 'function_expression',
    )
  );
}

// Pair-value form: { timer: setTimeout(() => ..., 100) } binds a handle and
// { visible: items.filter(...) } binds a value - neither is a callable. The
// capture emitters enforce the blocklists emit-side so the guarantee does not
// depend on query-predicate sharing behavior in node-tree-sitter 0.21
// (implicit-global stringValues across compiled queries). node is the
// arrow/function captured inside the call's arguments; the registration call
// is two hops up and must sit directly in pair-value position.
export function isBlockedPairCallbackRegistration(node: SyntaxNode): boolean {
  const args = node.parent;
  if (args === null || args.type !== 'arguments') return false;

  const callExpr = args.parent;
  if (callExpr === null || callExpr.type !== 'call_expression') return false;
  if (callExpr.parent?.type !== 'pair') return false;

  return isBlockedCallbackRegistrationCall(callExpr);
}
