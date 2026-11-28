import type Parser from 'tree-sitter';
import path from 'node:path';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ExtractedRouteRequireBinding } from '../../language-provider.js';
import {
  EMPTY_ROUTE_GROUP_CONTEXT,
  extendRouteGroupContext,
  isPhpRouteFile,
  type ComposedRouteGroupContext,
} from './route-group.js';
import { splitNamespaceUseDeclaration } from './import-decomposer.js';
import {
  findRouteGroupClosureBody,
  buildUseAliasMap,
  foldPhpStringLiteral,
  getRouterCallArguments,
  getRouterCallMethodName,
  isPhpRouterGroupCall,
  parseRouteGroupArrayArgs,
} from '../../route-extractors/laravel.js';

export type ExtractedPhpRouteRequireBinding = ExtractedRouteRequireBinding;

export function shouldExtractPhpRouterRequireBindings(content: string): boolean {
  return /\b(require|include)(_once)?\b/i.test(content);
}

function isPhpIncludeKeyword(name: string | undefined): boolean {
  if (!name) return false;
  switch (name.toLowerCase()) {
    case 'require':
    case 'require_once':
    case 'include':
    case 'include_once':
      return true;
    default:
      return false;
  }
}

const INCLUDE_EXPRESSION_TYPES = new Set([
  'include_expression',
  'require_expression',
  'include_once_expression',
  'require_once_expression',
]);

/** The path argument when `node` is a require/include, else `undefined`. */
function requireArgument(node: SyntaxNode): SyntaxNode | null | undefined {
  if (INCLUDE_EXPRESSION_TYPES.has(node.type)) {
    return node.namedChildren?.find((c: SyntaxNode) => c.type !== 'comment') ?? null;
  }
  if (node.type === 'function_call_expression') {
    const name =
      getRouterCallMethodName(node) ?? node.children?.find((c) => c.type === 'name')?.text;
    if (!isPhpIncludeKeyword(name)) return undefined;
    return (
      getRouterCallArguments(node)?.children?.find((c) => c.type === 'argument')?.children?.[0] ??
      null
    );
  }
  return undefined;
}

function isOnceRequire(node: SyntaxNode): boolean {
  if (node.type === 'include_once_expression' || node.type === 'require_once_expression') {
    return true;
  }
  const name = getRouterCallMethodName(node)?.toLowerCase();
  return name === 'require_once' || name === 'include_once';
}

function resolveRequirePath(hostRelPath: string, expr: SyntaxNode | null): string | null {
  if (!expr) return null;
  const hostDir = path.posix.dirname(hostRelPath);
  const resolved = foldPhpStringLiteral(expr, (node) =>
    node.type === 'name' && node.text.toUpperCase() === '__DIR__' ? hostDir : undefined,
  );
  if (!resolved) return null;
  return path.posix.normalize(resolved.replace(/\\/g, '/')).replace(/^\.\//, '');
}

/** Bodies that do not run when the code around them runs. */
const DEFERRED_SCOPE_TYPES = new Set([
  'anonymous_function',
  'arrow_function',
  'function_definition',
  'method_declaration',
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

/**
 * Hard exits skip the rest of the enclosing block and everything after it.
 * `break` / `continue` only skip later statements in the same loop or switch body.
 */
const HARD_EXIT_NODE_TYPES = new Set(['return_statement', 'throw_expression', 'exit_statement']);
const LOOP_LOCAL_EXIT_NODE_TYPES = new Set(['break_statement', 'continue_statement']);
const LOOP_OR_SWITCH_TYPES = new Set([
  'for_statement',
  'foreach_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
]);

/**
 * Children of these run, in order, whenever the node runs. Anything else
 * (if, loops, `&&`, `?:`, try body, catch) may skip a child, so a require
 * below it is not proof that the file ran.
 */
const MUST_RUN_CONTAINER_TYPES = new Set([
  'program',
  'compound_statement',
  'expression_statement',
  'parenthesized_expression',
  'namespace_definition',
  'do_statement',
  'finally_clause',
  'assignment_expression',
  'function_call_expression',
  'scoped_call_expression',
  'member_call_expression',
  'arguments',
  'argument',
]);

const SHORT_CIRCUIT_OPERATORS = new Set(['&&', '||', 'and', 'or', '??']);

function catchTypeText(catchClause: SyntaxNode): string {
  const chunks: string[] = [];
  const walk = (node: SyntaxNode) => {
    if (node.type === 'name' || node.type === 'namespace_name') chunks.push(node.text);
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of catchClause.children ?? []) {
    if (child.type === 'variable_name') break;
    walk(child);
  }
  return chunks.join('');
}

function namespaceHasName(node: SyntaxNode): boolean {
  return (node.children ?? []).some(
    (child) => child.type === 'namespace_name' || child.type === 'name',
  );
}

/**
 * `\Throwable` is always the global type. Unqualified `Throwable` is global
 * only when no named namespace is in effect at the catch.
 */
function inNamedNamespace(node: SyntaxNode): boolean {
  let root: SyntaxNode = node;
  while (root.parent) root = root.parent;
  let named = false;
  const visit = (current: SyntaxNode): boolean => {
    if (current === node) return true;
    if (current.type === 'namespace_definition') {
      const hasName = namespaceHasName(current);
      const braced = (current.children ?? []).some(
        (child) => child.type === 'compound_statement' || child.type === 'declaration_list',
      );
      if (braced) {
        const previous = named;
        named = hasName;
        for (const child of current.children ?? []) {
          if (visit(child)) return true;
        }
        named = previous;
        return false;
      }
      named = hasName;
    }
    for (const child of current.children ?? []) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return named;
}

function catchIsUniversalThrowable(catchClause: SyntaxNode): boolean {
  const raw = catchTypeText(catchClause);
  const bare = raw.replace(/^\\+/, '');
  // PHP class names are case-insensitive: `catch (throwable)` is `\Throwable`.
  if (bare.toLowerCase() === 'throwable') {
    if (raw.startsWith('\\') || !inNamedNamespace(catchClause)) return true;
    return importsGlobalThrowable(catchClause, bare);
  }
  return importsGlobalThrowable(catchClause, bare);
}

function namespaceIsBraced(node: SyntaxNode): boolean {
  return (node.children ?? []).some(
    (child) => child.type === 'compound_statement' || child.type === 'declaration_list',
  );
}

/** `use` declarations that apply to this catch: the braced namespace, or the current semicolon-namespace segment. */
function useDeclarationsForCatch(catchClause: SyntaxNode): SyntaxNode[] {
  for (let current: SyntaxNode | null = catchClause.parent; current; current = current.parent) {
    if (current.type === 'namespace_definition' && namespaceIsBraced(current)) {
      const uses: SyntaxNode[] = [];
      const stack = [...(current.children ?? [])];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.type === 'namespace_definition') continue;
        if (node.type === 'namespace_use_declaration') uses.push(node);
        else for (const child of node.children ?? []) stack.push(child);
      }
      return uses;
    }
  }
  let root: SyntaxNode = catchClause;
  while (root.parent) root = root.parent;
  const segment: SyntaxNode[] = [];
  const walk = (current: SyntaxNode): boolean => {
    if (current === catchClause) return true;
    if (current.type === 'namespace_definition') {
      if (!namespaceIsBraced(current)) segment.length = 0;
      return false;
    }
    if (current.type === 'namespace_use_declaration') segment.push(current);
    for (const child of current.children ?? []) {
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);
  return segment;
}

/** `use Throwable;` (or an alias of it) inside this namespace binds the catch type. */
function importsGlobalThrowable(catchClause: SyntaxNode, localName: string): boolean {
  if (!localName || localName.includes('\\')) return false;
  for (const useNode of useDeclarationsForCatch(catchClause)) {
    for (const match of splitNamespaceUseDeclaration(useNode)) {
      if (match['@import.symbol-kind']?.text !== 'type') continue;
      const local = match['@import.alias']?.text ?? match['@import.name']?.text;
      if (local?.toLowerCase() !== localName.toLowerCase()) continue;
      const source = (match['@import.source']?.text ?? '').replace(/^\\+/, '');
      if (source.toLowerCase() === 'throwable') return true;
    }
  }
  return false;
}

/** `exit` and `die` end the request without running `finally`. `return` does not. */
function nodeEndsRequest(node: SyntaxNode): boolean {
  if (node.type === 'exit_statement') return true;
  if (node.type === 'function_call_expression') {
    const name = (node.children ?? []).find((child) => child.type === 'name')?.text;
    return name?.toLowerCase() === 'die';
  }
  if (node.type === 'expression_statement') {
    const named = (node.children ?? []).filter((child) => child.isNamed);
    return named.length === 1 && named[0]?.type === 'name' && named[0].text.toLowerCase() === 'die';
  }
  return false;
}

function subtreeEndsRequest(root: SyntaxNode): boolean {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (DEFERRED_SCOPE_TYPES.has(current.type)) continue;
    if (nodeEndsRequest(current)) return true;
    for (const child of current.children ?? []) stack.push(child);
  }
  return false;
}

function exitSkipsFinally(tryNode: SyntaxNode): boolean {
  return (tryNode.children ?? []).some(
    (child) => child.type !== 'finally_clause' && subtreeEndsRequest(child),
  );
}

function tryCatchesAllThrows(tryNode: SyntaxNode): boolean {
  return (tryNode.children ?? []).some(
    (child) => child.type === 'catch_clause' && catchIsUniversalThrowable(child),
  );
}

/** A throw is definitely caught only by an enclosing universal Throwable catch. */
function throwIsDefinitelyCaught(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'catch_clause' || current.type === 'finally_clause') {
      while (current && current.type !== 'try_statement') current = current.parent;
      current = current?.parent ?? null;
      continue;
    }
    if (current.type === 'try_statement' && tryCatchesAllThrows(current)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Nodes that can skip later siblings. `break` / `continue` of level N pass
 * through N - 1 loops, then stop: the loop they finish is not an exit, so
 * statements after that loop still run.
 */
function collectMayExit(root: SyntaxNode): Set<number> {
  const mayExit = new Set<number>();
  const hard = new Set<number>();
  /** Remaining `break` / `continue` levels to carry outward. A loop consumes one. */
  const breakLevels = new Map<number, number>();
  const stack: { node: SyntaxNode; done: boolean }[] = [{ node: root, done: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children ?? [];
    if (!frame.done) {
      stack.push({ node: frame.node, done: true });
      for (const child of children) stack.push({ node: child, done: false });
      continue;
    }
    if (LOOP_LOCAL_EXIT_NODE_TYPES.has(frame.node.type)) {
      mayExit.add(frame.node.id);
      breakLevels.set(frame.node.id, loopExitLevels(frame.node));
      continue;
    }
    if (HARD_EXIT_NODE_TYPES.has(frame.node.type)) {
      mayExit.add(frame.node.id);
      if (!(frame.node.type === 'throw_expression' && throwIsDefinitelyCaught(frame.node))) {
        hard.add(frame.node.id);
      }
      continue;
    }
    let childHard = false;
    let childLocal = false;
    let pendingBreak = 0;
    for (const child of children) {
      if (DEFERRED_SCOPE_TYPES.has(child.type)) continue;
      if (hard.has(child.id)) childHard = true;
      const levels = breakLevels.get(child.id) ?? 0;
      if (levels > pendingBreak) pendingBreak = levels;
      else if (mayExit.has(child.id) && levels === 0) childLocal = true;
    }
    if (LOOP_OR_SWITCH_TYPES.has(frame.node.type)) {
      if (pendingBreak > 1) {
        mayExit.add(frame.node.id);
        breakLevels.set(frame.node.id, pendingBreak - 1);
      }
      if (childHard) {
        mayExit.add(frame.node.id);
        hard.add(frame.node.id);
      }
      continue;
    }
    if (childHard) {
      mayExit.add(frame.node.id);
      hard.add(frame.node.id);
    } else if (pendingBreak > 0) {
      mayExit.add(frame.node.id);
      breakLevels.set(frame.node.id, pendingBreak);
    } else if (
      childLocal &&
      !(frame.node.type === 'try_statement' && tryCatchesAllThrows(frame.node))
    ) {
      mayExit.add(frame.node.id);
    }
  }
  return mayExit;
}

/** A statement that always leaves the block, so later siblings never run. */
const UNCONDITIONAL_EXIT_TYPES = new Set([
  'break_statement',
  'continue_statement',
  'return_statement',
  'throw_expression',
  'exit_statement',
]);

function loopExitLevels(node: SyntaxNode): number {
  const literal = (node.children ?? []).find((child) => child.type === 'integer');
  if (!literal) return 1;
  const levels = Number(literal.text);
  return Number.isFinite(levels) && levels > 0 ? levels : 1;
}

/** Later siblings are unreachable only inside a straight-line block. */
const SEQUENTIAL_BLOCK_TYPES = new Set([
  'program',
  'compound_statement',
  'namespace_definition',
  'declaration_list',
]);

/** An `exit` or `die` on the straight-line path, ignoring conditional branches. */
function straightLineEndsRequest(node: SyntaxNode): boolean {
  if (DEFERRED_SCOPE_TYPES.has(node.type)) return false;
  if (nodeEndsRequest(node)) return true;
  const sequential =
    MUST_RUN_CONTAINER_TYPES.has(node.type) ||
    node.type === 'try_statement' ||
    SEQUENTIAL_BLOCK_TYPES.has(node.type);
  if (!sequential) return false;
  for (const child of node.children ?? []) {
    if (child.type === 'catch_clause' || child.type === 'finally_clause') continue;
    if (straightLineEndsRequest(child)) return true;
  }
  return false;
}

function statementExitsUnconditionally(node: SyntaxNode): boolean {
  if (node.type === 'goto_statement') return false;
  if (node.type === 'try_statement') return straightLineEndsRequest(node);
  if (UNCONDITIONAL_EXIT_TYPES.has(node.type)) return true;
  if (node.type !== 'expression_statement') return false;
  const inner = (node.children ?? []).find((child) => child.type !== ';');
  return inner?.type === 'throw_expression';
}

/**
 * A forward `goto` skips statements between itself and its label. The label
 * and everything after it still run. Backward gotos are loops, not skips.
 */
function forwardGotoSkipRanges(root: SyntaxNode): { from: number; to: number }[] {
  const gotos: SyntaxNode[] = [];
  const labels: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'goto_statement') gotos.push(current);
    else if (current.type === 'named_label_statement') labels.push(current);
    for (const child of current.children ?? []) stack.push(child);
  }
  const functionScope = (node: SyntaxNode): SyntaxNode | null => {
    let current: SyntaxNode | null = node;
    while (current) {
      if (
        current.type === 'function_definition' ||
        current.type === 'anonymous_function' ||
        current.type === 'arrow_function' ||
        current.type === 'method_declaration'
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  };
  const ranges: { from: number; to: number }[] = [];
  for (const gotoNode of gotos) {
    const name = (gotoNode.children ?? []).find((child) => child.type === 'name')?.text;
    if (!name) continue;
    const scope = functionScope(gotoNode);
    let label: SyntaxNode | null = null;
    for (const candidate of labels) {
      if (candidate.startIndex <= gotoNode.endIndex) continue;
      const labelName = (candidate.children ?? []).find((child) => child.type === 'name')?.text;
      if (labelName !== name || functionScope(candidate) !== scope) continue;
      if (!label || candidate.startIndex < label.startIndex) label = candidate;
    }
    if (label) ranges.push({ from: gotoNode.endIndex, to: label.startIndex });
  }
  return ranges;
}

function skippedByForwardGoto(node: SyntaxNode, ranges: { from: number; to: number }[]): boolean {
  return ranges.some((range) => node.startIndex >= range.from && node.endIndex <= range.to);
}

interface WalkFrame {
  node: SyntaxNode;
  /** Composed router-group context, or null outside any group. */
  group: ComposedRouteGroupContext | null;
  mustRun: boolean;
  /** Inside a function or other body that does not run when the file loads. */
  deferred: boolean;
}

/**
 * Every require of a route file, with the router-group context it runs under.
 * The resolver decides which contexts survive; this only records facts.
 */
export function extractPhpRouterRequireBindings(
  tree: Parser.Tree,
  hostFilePath: string,
): ExtractedRouteRequireBinding[] {
  const bindings: ExtractedRouteRequireBinding[] = [];
  const relHost = hostFilePath.replace(/\\/g, '/');
  const mayExit = collectMayExit(tree.rootNode);
  const gotoSkips = forwardGotoSkipRanges(tree.rootNode);
  const useAliases = buildUseAliasMap(tree.rootNode);

  const pushChildren = (frame: WalkFrame, children: readonly SyntaxNode[]) => {
    const { node, group, mustRun } = frame;
    const isTry = node.type === 'try_statement';
    let childMustRun = mustRun && (isTry || MUST_RUN_CONTAINER_TYPES.has(node.type));
    const finallyRuns = mustRun && !(isTry && exitSkipsFinally(node));
    const shortCircuitLeft =
      node.type === 'binary_expression' &&
      SHORT_CIRCUIT_OPERATORS.has((node.children ?? []).find((child) => !child.isNamed)?.text ?? '')
        ? (node.children ?? []).find((child) => child.isNamed)
        : undefined;
    const alwaysEvaluated =
      node.type === 'conditional_expression'
        ? (node.children ?? []).find((child) => child.isNamed)
        : node.type === 'return_statement'
          ? (node.children ?? []).find((child) => child.isNamed && child.type !== 'return')
          : undefined;
    const ordered: WalkFrame[] = [];
    for (const child of children) {
      // `exit` / `die` skips `finally`, so requires there are not possible loads.
      if (isTry && child.type === 'finally_clause' && !finallyRuns) continue;
      // Try/catch bodies may skip. `finally` runs once the try is reached,
      // except when `exit` or `die` in the try or catch ends the request first.
      // The `if` condition runs whenever the `if` is reached. The body and
      // `elseif` conditions do not.
      const runs = skippedByForwardGoto(child, gotoSkips)
        ? false
        : isTry && child.type === 'finally_clause'
          ? finallyRuns
          : isTry && child.type === 'catch_clause'
            ? false
            : (node.type === 'if_statement' || node.type === 'while_statement') &&
                child.type === 'parenthesized_expression'
              ? mustRun
              : child === shortCircuitLeft || child === alwaysEvaluated
                ? mustRun
                : childMustRun;
      ordered.push({ node: child, group, mustRun: runs, deferred: frame.deferred });
      if (SEQUENTIAL_BLOCK_TYPES.has(node.type) && statementExitsUnconditionally(child)) break;
      if (!isTry || child.type !== 'finally_clause') {
        if (mayExit.has(child.id)) childMustRun = false;
      }
    }
    for (let i = ordered.length - 1; i >= 0; i--) walk.push(ordered[i]);
  };

  const walk: WalkFrame[] = [{ node: tree.rootNode, group: null, mustRun: true, deferred: false }];
  while (walk.length > 0) {
    const frame = walk.pop()!;
    const { node, group, mustRun, deferred } = frame;

    const arg = requireArgument(node);
    if (arg !== undefined) {
      const requiredPath = resolveRequirePath(relHost, arg);
      if (requiredPath && isPhpRouteFile(requiredPath)) {
        const ctx = group ?? EMPTY_ROUTE_GROUP_CONTEXT;
        bindings.push({
          filePath: relHost,
          requiredPath,
          prefix: ctx.prefix,
          namespace: ctx.namespace,
          namespaceResets: ctx.namespaceResets,
          middleware: [...ctx.middleware],
          namePrefix: ctx.namePrefix,
          controller: ctx.controller,
          lineNumber: node.startPosition.row,
          column: node.startPosition.column,
          once: isOnceRequire(node),
          appliesContext: group !== null,
          unguarded: mustRun,
          deferred,
        });
      }
      continue;
    }

    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const body = findRouteGroupClosureBody(argsNode);
      if (body) {
        const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
        if (groupCtx.controller && !groupCtx.controller.includes('\\')) {
          const imported = useAliases.get(groupCtx.controller);
          if (imported) groupCtx.controller = imported.replace(/\./g, '\\');
        }
        const inner = extendRouteGroupContext(
          group ?? EMPTY_ROUTE_GROUP_CONTEXT,
          groupCtx,
          'lumen',
        );
        // Lumen runs the group closure immediately, so it inherits mustRun.
        walk.push({ node: body, group: inner, mustRun, deferred });
      }
      continue;
    }

    if (DEFERRED_SCOPE_TYPES.has(node.type)) {
      // Runs later, if at all, and under whatever group is active then.
      pushChildren({ node, group: null, mustRun: false, deferred: true }, node.children ?? []);
      continue;
    }

    pushChildren(frame, node.children ?? []);
  }

  return bindings;
}
