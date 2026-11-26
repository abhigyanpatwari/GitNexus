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

function isInlineFunction(node: SyntaxNode): boolean {
  return node.type === 'arrow_function' || node.type === 'function_expression';
}

/** Timer and array/promise-method callees register or map a callback; they never wrap it. */
function isBlockedWrapperCallee(callee: SyntaxNode | null): boolean {
  if (callee?.type === 'identifier')
    return DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET.has(decodeIdentifierEscapes(callee.text));
  const property =
    callee?.type === 'member_expression' ? callee.childForFieldName('property') : null;
  return (
    property?.type === 'property_identifier' && ARRAY_METHOD_HOC_BLOCKLIST_SET.has(property.text)
  );
}

function callArguments(call: SyntaxNode): SyntaxNode[] | undefined {
  const args = call.childForFieldName('arguments');
  if (args?.type !== 'arguments') return undefined;
  return args.namedChildren.filter((arg) => arg.type !== 'comment');
}

/**
 * `const X = hoc(() => …)` — the HOC-wrapped variable the queries declare as a
 * Function (`forwardRef`, `memo`, `observer`, …).
 */
function isHocWrappedFunction(value: SyntaxNode | null): boolean {
  if (value?.type !== 'call_expression') return false;
  if (isBlockedWrapperCallee(value.childForFieldName('function'))) return false;
  return callArguments(value)?.some(isInlineFunction) ?? false;
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
 * function, class or HOC-wrapped function? A wrapper around anything else
 * (`make(config)`) returns a value the graph cannot attribute to the argument.
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
        (CALLABLE_VALUES.has(value?.type ?? '') || isHocWrappedFunction(value))
      );
    });
  });
}

/**
 * The top-level function or class a wrapper call exports: `memo(Card)`,
 * `React.memo(Card, areEqual)`, `memo(forwardRef(Card))` and
 * `connect(mapState)(Card)` all name `Card`, the first argument unwrapped
 * through nested wrapper calls. An inline first argument is not a name: the
 * synthesized HOC default above owns it.
 */
export function wrappedDefaultLocal(call: SyntaxNode, root: SyntaxNode): string | undefined {
  let current = call;
  while (current.type === 'call_expression') {
    if (isBlockedWrapperCallee(current.childForFieldName('function'))) return undefined;
    const [first] = callArguments(current) ?? [];
    if (first === undefined) return undefined;
    current = unwrapTransparentExpression(first);
  }
  if (current.type !== 'identifier') return undefined;
  const name = decodeIdentifierEscapes(current.text);
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
