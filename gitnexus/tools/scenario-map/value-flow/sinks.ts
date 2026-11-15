/**
 * Sink classification of the value-flow check (U10, R9, KTD11 walk rules 2–4, design §5.3a step 3).
 * Pure: it reads one production module's Babel AST and asks an injected callee resolver (the
 * TypeScript checker in a real run, checker.ts) what each call reaches, so it is unit-testable
 * without a PDG or a checker.
 *
 * {@link walkUp} starts at an expression that carries a differing value (a reference to a tracked
 * binding, or a repo call whose result carries it) and climbs to the consuming expression. Each
 * consumer is one sink, classified in the design's order (the first class that applies wins):
 *  - `repo-code`: an operator (arithmetic, comparison, logical, template), a branch or switch
 *    test, or an argument of a repo function in the pair's mutated production files (KTD7); the
 *    walk recurses into that function (pdg-walk.ts) and continues with the call's result when the
 *    callee returns the value. Arithmetic, logical and template results carry a derived value, so
 *    the climb continues (`(x * 10).toFixed(1)` reaches `toFixed`); comparisons and branches end it;
 *  - `table-read`: a key read of a supported row-deletion table (design §5.4: a module-level
 *    object literal, `new Set([...])` or `new Map([...])` that row deletion supports, see
 *    row-deletion.ts `scanSupportedTables`) through `T[v]`, `v in T`, `T.has(v)` or `T.get(v)`,
 *    and the read-back of a value stored in a local built-in container (`m.get(k)` after
 *    `m.set(k, v)`, which continues with the read value);
 *  - `pass-through`: the value is returned, or stored into a local built-in container (`push`,
 *    `unshift`, `Map.set`, `Set.add`); the container is then walked as a derived binding;
 *  - `opaque`: a call declared in a library (`lib.*.d.ts`, `@types/node`, `node_modules`), and any
 *    regex use (`RegExp` methods and constructor, `String` `match`/`matchAll`/`search`, and
 *    `replace`/`replaceAll`/`split` with a regex argument);
 *  - `unknown`: anything the walk cannot follow: a repo function outside the mutated files, an
 *    unresolved callee or dynamic dispatch, the receiver of a repo method, a key read of an object
 *    that is not a supported table, a store into a property or into module state, a value thrown,
 *    yielded, spread into a call or captured by a closure.
 * New bindings derived from the value (`const y = v * 2`, `const { ratio } = opts`, `x = v`,
 * `for (const e of v)`) are returned for the walk to follow under their own name (KTD11 rule 3).
 *
 * The statement rule (KTD11 rule 2): {@link statementClass} gives a statement the worst class of
 * its sinks, so one opaque or unknown use vetoes the whole statement whatever its other uses are:
 * `if (path.extname(v) === '.ts')` is vetoed by `path.extname` although `===` is repo code.
 *
 * Library only; pdg-walk.ts drives it.
 */
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';

/** The design's sink classes, in the order they apply. */
export type SinkClass = 'repo-code' | 'table-read' | 'pass-through' | 'opaque' | 'unknown';

export interface SinkLocation {
  /** Repo path of the production module. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
}

export interface Sink {
  class: SinkClass;
  /** The consumer: `arithmetic *`, `comparison <`, `call add`, `Math.round`, `return` … */
  what: string;
  /** Why an opaque or unknown sink is one (`regex`, `library`, …); empty for the clean classes. */
  reason: string;
  location: SinkLocation;
}

/**
 * Where the checker places a callee's declaration: a repo `.ts` source (`repo`), a repo
 * declaration file such as `gitnexus-shared/dist/*.d.ts` (`declaration`), a library
 * (`lib.*.d.ts`, `@types/node`, `node_modules`), or nowhere (`unresolved`).
 */
export type CalleeOrigin = 'repo' | 'declaration' | 'library' | 'unresolved';

export interface CalleeInfo {
  origin: CalleeOrigin;
  /** Display name: `Math.round`, `ReadonlySet.has`, `parseInt`, `add`. */
  name: string;
  /** The declaring container (`Math`, `String`, `ReadonlySet`); null for a free function. */
  container: string | null;
  /** Repo path of the declaration for repo and declaration callees; null otherwise. */
  file: string | null;
  /** UTF-16 end offset of the declaration in `file` (repo callees): locates the function. */
  declarationEnd: number | null;
  /** The declaration is a class: a `new` call reaches its constructor. */
  isClass: boolean;
  /** Why an unresolved callee did not resolve. */
  reason: string;
}

/** One call or `new` site as the resolver sees it. */
export interface CallSite {
  node: t.CallExpression | t.NewExpression | t.OptionalCallExpression;
  /** The identifier naming the callee (`f()`, `o.m()`, `new C()`); null for any other callee. */
  name: t.Identifier | null;
}

export type ResolveCallee = (site: CallSite) => CalleeInfo;

/** Row-deletion support of a module-level table binding (row-deletion.ts `scanSupportedTables`). */
export interface TableSupport {
  supported: boolean;
  /** Why row deletion refuses the table; empty when supported. */
  constructs: string[];
}

export interface ClassifyContext {
  /** Repo path of the module. */
  file: string;
  /** The function being walked; reaching its body or boundary ends the climb. */
  fn: NodePath<t.Function>;
  resolve: ResolveCallee;
  /** True for a repo path inside the pair's mutated production files (KTD7). */
  inScope: (repoPath: string) => boolean;
  /** Module-level table bindings of the module by name. */
  tables: ReadonlyMap<string, TableSupport>;
}

/** A binding derived from the value, to be walked under its own name (KTD11 rule 3). */
export interface DerivedBinding {
  name: string;
  binding: Binding;
  /** `container`: a built-in container the value was stored into. */
  kind: 'value' | 'container';
  /** 1-based lines of the defining statement; the PDG's def line falls inside. */
  lines: { start: number; end: number };
}

/** A call into a repo function of the mutated files that the walk recurses into (rule 5). */
export interface RepoCall {
  call: NodePath<t.CallExpression | t.NewExpression | t.OptionalCallExpression>;
  callee: CalleeInfo;
  /** Argument position of the value. */
  argIndex: number;
}

export interface WalkUpResult {
  sinks: Sink[];
  derived: DerivedBinding[];
  calls: RepoCall[];
  /** The value reaches the walked function's return. */
  returns: boolean;
}

const ARITHMETIC: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '|',
  '&',
  '^',
  '<<',
  '>>',
  '>>>',
]);
const COMPARISON: ReadonlySet<string> = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  'instanceof',
]);
const WRAPPERS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
  'AwaitExpression',
]);
/** Built-in containers whose storage and read-back methods are exempt from `opaque`. */
const CONTAINERS: ReadonlySet<string> = new Set([
  'Array',
  'ReadonlyArray',
  'Map',
  'ReadonlyMap',
  'WeakMap',
  'Set',
  'ReadonlySet',
  'WeakSet',
]);
const STORE_METHODS: ReadonlySet<string> = new Set(['push', 'unshift', 'set', 'add']);
/** Read-back methods of a container: the read value continues. */
const READ_BACK_METHODS: ReadonlySet<string> = new Set(['get', 'at']);
/** Membership methods: a boolean, so the climb ends. */
const MEMBERSHIP_METHODS: ReadonlySet<string> = new Set(['has']);
const REGEX_CONTAINERS: ReadonlySet<string> = new Set(['RegExp', 'RegExpConstructor']);
const REGEX_STRING_METHODS: ReadonlySet<string> = new Set(['match', 'matchAll', 'search']);
const REGEX_ARGUMENT_METHODS: ReadonlySet<string> = new Set(['replace', 'replaceAll', 'split']);

// ── Aggregation ────────────────────────────────────────────────────────────

const SEVERITY: Record<SinkClass, number> = {
  'repo-code': 0,
  'table-read': 0,
  'pass-through': 0,
  unknown: 1,
  opaque: 2,
};

/** The statement rule: the worst class of a statement's sinks (null without sinks). */
export function statementClass(sinks: readonly Sink[]): SinkClass | null {
  let worst: SinkClass | null = null;
  for (const sink of sinks) {
    if (worst === null || SEVERITY[sink.class] > SEVERITY[worst]) worst = sink.class;
  }
  return worst;
}

/** `veto` when any sink is opaque, else `unknown` when any is unknown, else `clean`. */
export function verdictOf(sinks: readonly Sink[]): 'clean' | 'veto' | 'unknown' {
  const worst = statementClass(sinks);
  if (worst === 'opaque') return 'veto';
  if (worst === 'unknown') return 'unknown';
  return 'clean';
}

// ── Helpers ────────────────────────────────────────────────────────────────

const locationOf = (node: t.Node, file: string): SinkLocation => ({
  file,
  line: node.loc?.start.line ?? 0,
  column: node.loc?.start.column ?? 0,
});

/** The innermost statement (not a block) around a path. */
export function statementOf(path: NodePath): NodePath<t.Statement> | null {
  let current: NodePath | null = path;
  while (current !== null) {
    if (current.isStatement() && !current.isBlockStatement()) return current;
    if (current.isFunction()) return null;
    current = current.parentPath;
  }
  return null;
}

function linesOf(path: NodePath): { start: number; end: number } {
  const statement = statementOf(path) ?? path;
  return {
    start: statement.node.loc?.start.line ?? 0,
    end: statement.node.loc?.end.line ?? 0,
  };
}

/** The identifier naming a call's callee, else null. */
export function calleeIdentifier(
  node: t.CallExpression | t.NewExpression | t.OptionalCallExpression,
): t.Identifier | null {
  let callee: t.Node = node.callee;
  while (WRAPPERS.has(callee.type)) callee = (callee as t.TSAsExpression).expression;
  if (t.isIdentifier(callee)) return callee;
  if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && !callee.computed) {
    return t.isIdentifier(callee.property) ? callee.property : null;
  }
  return null;
}

/** The object of a member callee (`o` in `o.m()`), else null. */
function calleeObject(node: t.CallExpression | t.OptionalCallExpression): t.Node | null {
  const callee = node.callee;
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) return callee.object;
  return null;
}

const methodName = (info: CalleeInfo): string => info.name.slice(info.name.lastIndexOf('.') + 1);

/** True for an opaque call that is a regex use. */
function isRegexUse(info: CalleeInfo, site: t.Node): boolean {
  if (info.container !== null && REGEX_CONTAINERS.has(info.container)) return true;
  if (info.container === null && info.name === 'RegExp') return true;
  if (info.container !== 'String') return false;
  const method = methodName(info);
  if (REGEX_STRING_METHODS.has(method)) return true;
  if (!REGEX_ARGUMENT_METHODS.has(method) || !t.isCallExpression(site)) return false;
  return site.arguments.some(
    (argument) =>
      t.isRegExpLiteral(argument) ||
      (t.isNewExpression(argument) && t.isIdentifier(argument.callee, { name: 'RegExp' })),
  );
}

/** A module-level identifier's table support, else null when it names no table. */
function tableSupportOf(node: t.Node, path: NodePath, ctx: ClassifyContext): TableSupport | null {
  let current = node;
  while (WRAPPERS.has(current.type)) current = (current as t.TSAsExpression).expression;
  if (!t.isIdentifier(current)) return null;
  const binding = path.scope.getBinding(current.name);
  if (binding === undefined || binding.scope.path.type !== 'Program') return null;
  return ctx.tables.get(current.name) ?? null;
}

/** The Babel binding a pattern's identifiers declare, one per name. */
function patternBindings(
  pattern: t.Node,
  at: NodePath,
): { name: string; binding: Binding | undefined }[] {
  const names = Object.keys(t.getBindingIdentifiers(pattern));
  return names.map((name) => ({ name, binding: at.scope.getBinding(name) }));
}

// ── The climb ──────────────────────────────────────────────────────────────

/**
 * Climbs from an expression that carries the value to its consumers. `kind` is `container` when
 * the start is a reference to a local built-in container the value was stored into.
 */
export function walkUp(
  start: NodePath,
  ctx: ClassifyContext,
  kind: 'value' | 'container' = 'value',
): WalkUpResult {
  const result: WalkUpResult = { sinks: [], derived: [], calls: [], returns: false };
  const sink = (cls: SinkClass, what: string, at: t.Node, reason = ''): void => {
    result.sinks.push({ class: cls, what, reason, location: locationOf(at, ctx.file) });
  };
  const derive = (
    pattern: t.Node,
    at: NodePath,
    derivedKind: DerivedBinding['kind'] = 'value',
  ): void => {
    for (const { name, binding } of patternBindings(pattern, at)) {
      if (binding === undefined) {
        sink('unknown', `assignment to ${name}`, at.node, 'binding not found');
        continue;
      }
      if (!isInside(binding.scope.path, ctx.fn)) {
        sink('unknown', `assignment to ${name}`, at.node, 'stored outside the function');
        continue;
      }
      result.derived.push({ name, binding, kind: derivedKind, lines: linesOf(at) });
    }
  };

  let current: NodePath = start;
  let carrying: 'value' | 'container' = kind;
  for (;;) {
    const parentPath: NodePath | null = current.parentPath;
    if (parentPath === null) {
      sink('unknown', 'no consumer', current.node, 'outside any function');
      return result;
    }
    const node = current.node;
    const parent = parentPath.node;

    if (WRAPPERS.has(parent.type)) {
      current = parentPath;
      continue;
    }

    if (carrying === 'container') {
      const handled = containerUse(current, parentPath, ctx, sink);
      if (handled === 'end') return result;
      carrying = 'value';
      if (handled !== 'value') {
        current = handled;
        continue;
      }
    }

    if (t.isBinaryExpression(parent)) {
      if (parent.operator === 'in') {
        if (parent.left !== node) {
          sink('unknown', 'in', parent, 'membership test on the value');
          return result;
        }
        const table = tableSupportOf(parent.right, parentPath, ctx);
        tableRead(table, 'in', parent, sink);
        return result;
      }
      if (COMPARISON.has(parent.operator)) {
        sink('repo-code', `comparison ${parent.operator}`, parent);
        return result;
      }
      if (ARITHMETIC.has(parent.operator)) {
        sink('repo-code', `arithmetic ${parent.operator}`, parent);
        current = parentPath;
        continue;
      }
      sink('unknown', `operator ${parent.operator}`, parent, 'unsupported operator');
      return result;
    }
    if (t.isLogicalExpression(parent)) {
      sink('repo-code', `logical ${parent.operator}`, parent);
      current = parentPath;
      continue;
    }
    if (t.isConditionalExpression(parent)) {
      if (parent.test === node) {
        sink('repo-code', 'branch', parent);
        return result;
      }
      current = parentPath;
      continue;
    }
    if (t.isUnaryExpression(parent)) {
      if (parent.operator === '!' || parent.operator === 'typeof') {
        sink('repo-code', `unary ${parent.operator}`, parent);
        return result;
      }
      if (parent.operator === 'void') return result;
      if (parent.operator === 'delete') {
        sink('unknown', 'delete', parent, 'unsupported operator');
        return result;
      }
      sink('repo-code', `arithmetic ${parent.operator}`, parent);
      current = parentPath;
      continue;
    }
    if (t.isUpdateExpression(parent)) {
      sink('repo-code', `update ${parent.operator}`, parent);
      return result;
    }
    if (t.isTemplateLiteral(parent)) {
      sink('repo-code', 'template', parent);
      current = parentPath;
      continue;
    }
    if (t.isSequenceExpression(parent)) {
      if (parent.expressions[parent.expressions.length - 1] !== node) return result;
      current = parentPath;
      continue;
    }
    if (t.isArrayExpression(parent) || t.isObjectExpression(parent)) {
      current = parentPath;
      continue;
    }
    if (t.isObjectProperty(parent)) {
      if (t.isObjectPattern(parentPath.parent)) {
        sink('unknown', 'pattern', parent, 'unsupported pattern position');
        return result;
      }
      // `{ k: v }` and `{ [v]: x }`: the object carries the value.
      const objectPath = parentPath.parentPath;
      if (objectPath === null) return result;
      current = objectPath;
      continue;
    }
    if (t.isSpreadElement(parent)) {
      const holder = parentPath.parentPath;
      if (holder === null || !(holder.isArrayExpression() || holder.isObjectExpression())) {
        sink('unknown', 'spread', parent, 'spread into a call');
        return result;
      }
      current = holder;
      continue;
    }
    if (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) {
      if (parent.object === node) {
        const outer = parentPath.parent;
        const called =
          (t.isCallExpression(outer) || t.isOptionalCallExpression(outer)) &&
          outer.callee === parent;
        if (called) {
          const info = ctx.resolve({ node: outer, name: calleeIdentifier(outer) });
          if (info.origin === 'library') {
            const regex = isRegexUse(info, outer);
            sink('opaque', info.name, outer, regex ? 'regex' : 'library');
            return result;
          }
          sink('unknown', info.name, outer, receiverReason(info, ctx));
          return result;
        }
        const assigned = t.isAssignmentExpression(outer) && outer.left === parent;
        if (assigned || t.isUpdateExpression(outer)) {
          sink('unknown', 'property write', parent, 'the value is written into');
          return result;
        }
        // A property read of the value (`opts.ratio`, `name.length`) carries a derived value.
        current = parentPath;
        continue;
      }
      // `obj[v]`: a key read.
      const table = tableSupportOf(parent.object, parentPath, ctx);
      tableRead(table, 'key read', parent, sink);
      return result;
    }
    if (
      t.isCallExpression(parent) ||
      t.isNewExpression(parent) ||
      t.isOptionalCallExpression(parent)
    ) {
      const callPath = parentPath as NodePath<
        t.CallExpression | t.NewExpression | t.OptionalCallExpression
      >;
      if (parent.callee === node) {
        sink('unknown', 'call', parent, 'the value is called');
        return result;
      }
      const argIndex = parent.arguments.indexOf(node as t.Expression);
      if (argIndex < 0) {
        sink('unknown', 'call', parent, 'unsupported argument position');
        return result;
      }
      const info = ctx.resolve({ node: parent, name: calleeIdentifier(parent) });
      const outcome = argumentUse(info, callPath, argIndex, ctx, sink, derive);
      if (outcome === 'recurse') result.calls.push({ call: callPath, callee: info, argIndex });
      return result;
    }
    if (t.isTaggedTemplateExpression(parent)) {
      sink('unknown', 'tagged template', parent, 'unsupported consumer');
      return result;
    }
    if (t.isVariableDeclarator(parent)) {
      if (parent.init !== node) {
        sink('unknown', 'declarator', parent, 'unsupported position');
        return result;
      }
      derive(parent.id, parentPath);
      return result;
    }
    if (t.isAssignmentExpression(parent)) {
      if (parent.right !== node) {
        sink('unknown', 'assignment', parent, 'the value is assigned to');
        return result;
      }
      if (parent.operator !== '=') sink('repo-code', `arithmetic ${parent.operator}`, parent);
      if (t.isMemberExpression(parent.left) || t.isOptionalMemberExpression(parent.left)) {
        sink('unknown', 'property write', parent, 'stored into a property');
        return result;
      }
      derive(parent.left, parentPath);
      return result;
    }
    if (t.isReturnStatement(parent)) {
      sink('pass-through', 'return', parent);
      result.returns = true;
      return result;
    }
    if (t.isFunction(parent)) {
      if (parentPath === ctx.fn && t.isArrowFunctionExpression(parent) && parent.body === node) {
        sink('pass-through', 'return', node);
        result.returns = true;
        return result;
      }
      sink('unknown', 'function', parent, 'captured or defaulted by a function');
      return result;
    }
    if (
      (t.isIfStatement(parent) ||
        t.isWhileStatement(parent) ||
        t.isDoWhileStatement(parent) ||
        t.isForStatement(parent)) &&
      parent.test === node
    ) {
      sink('repo-code', 'branch', parent);
      return result;
    }
    if (t.isSwitchStatement(parent) && parent.discriminant === node) {
      sink('repo-code', 'switch', parent);
      return result;
    }
    if (t.isSwitchCase(parent) && parent.test === node) {
      sink('repo-code', 'comparison case', parent);
      return result;
    }
    if (t.isForOfStatement(parent) && parent.right === node) {
      const left = parent.left;
      const pattern = t.isVariableDeclaration(left) ? left.declarations[0]?.id : left;
      if (pattern === undefined || t.isMemberExpression(pattern)) {
        sink('unknown', 'for…of', parent, 'unsupported loop target');
        return result;
      }
      derive(pattern, parentPath);
      return result;
    }
    if (t.isExpressionStatement(parent)) return result;
    sink('unknown', parent.type, parent, 'unsupported consumer');
    return result;
  }
}

/** True when `inner` is `outer` or inside it. */
function isInside(inner: NodePath, outer: NodePath): boolean {
  let current: NodePath | null = inner;
  while (current !== null) {
    if (current === outer || current.node === outer.node) return true;
    current = current.parentPath;
  }
  return false;
}

function receiverReason(info: CalleeInfo, ctx: ClassifyContext): string {
  if (info.origin === 'unresolved') return `unresolved callee: ${info.reason}`;
  if (info.origin === 'declaration') return 'declaration file only';
  if (info.origin === 'repo' && info.file !== null && !ctx.inScope(info.file)) {
    return `repo code outside the mutated files: ${info.file}`;
  }
  return 'receiver of a repo method';
}

function tableRead(
  table: TableSupport | null,
  what: string,
  at: t.Node,
  sink: (cls: SinkClass, what: string, at: t.Node, reason?: string) => void,
): void {
  if (table === null) sink('unknown', what, at, 'not a supported table');
  else if (table.supported) sink('table-read', what, at);
  else sink('unknown', what, at, `unsupported table: ${table.constructs.join(', ')}`);
}

/**
 * The value as a call argument. Returns `recurse` for a repo call of the mutated files, which the
 * walk descends into (its continuation is the caller's business).
 */
function argumentUse(
  info: CalleeInfo,
  callPath: NodePath<t.CallExpression | t.NewExpression | t.OptionalCallExpression>,
  argIndex: number,
  ctx: ClassifyContext,
  sink: (cls: SinkClass, what: string, at: t.Node, reason?: string) => void,
  derive: (pattern: t.Node, at: NodePath, kind?: DerivedBinding['kind']) => void,
): 'recurse' | 'done' {
  const call = callPath.node;
  if (call.arguments.slice(0, argIndex + 1).some((argument) => t.isSpreadElement(argument))) {
    sink('unknown', info.name, call, 'argument position after a spread');
    return 'done';
  }
  if (info.origin === 'repo' && info.file !== null) {
    if (!ctx.inScope(info.file)) {
      sink('unknown', info.name, call, `repo code outside the mutated files: ${info.file}`);
      return 'done';
    }
    sink('repo-code', `call ${info.name}`, call);
    return 'recurse';
  }
  if (info.origin === 'declaration') {
    sink('unknown', info.name, call, 'declaration file only');
    return 'done';
  }
  if (info.origin === 'unresolved') {
    sink('unknown', info.name, call, `unresolved callee: ${info.reason}`);
    return 'done';
  }
  // Library callee: the table-read and storage exemptions apply before `opaque`.
  const method = methodName(info);
  const object =
    t.isCallExpression(call) || t.isOptionalCallExpression(call) ? calleeObject(call) : null;
  const isContainer = info.container !== null && CONTAINERS.has(info.container);
  if (isContainer && object !== null && argIndex === 0) {
    if (MEMBERSHIP_METHODS.has(method) || READ_BACK_METHODS.has(method)) {
      tableRead(tableSupportOf(object, callPath, ctx), info.name, call, sink);
      return 'done';
    }
  }
  if (isContainer && object !== null && STORE_METHODS.has(method)) {
    let target: t.Node = object;
    while (WRAPPERS.has(target.type)) target = (target as t.TSAsExpression).expression;
    if (!t.isIdentifier(target)) {
      sink('unknown', info.name, call, 'stored into an untracked container');
      return 'done';
    }
    sink('pass-through', info.name, call);
    if (callPath.scope.getBinding(target.name)?.kind === 'param') {
      sink('unknown', info.name, call, 'stored into a container of the caller');
      return 'done';
    }
    derive(target, callPath, 'container');
    return 'done';
  }
  sink('opaque', info.name, call, isRegexUse(info, call) ? 'regex' : 'library');
  return 'done';
}

/**
 * A reference to a container the value was stored into: read-back methods continue with the read
 * value, membership tests and further stores end, anything else is a value use.
 */
function containerUse(
  current: NodePath,
  parentPath: NodePath,
  ctx: ClassifyContext,
  sink: (cls: SinkClass, what: string, at: t.Node, reason?: string) => void,
): NodePath | 'end' | 'value' {
  const parent = parentPath.node;
  if (!(t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent))) return 'value';
  if (parent.object !== current.node) return 'value';
  const outer = parentPath.parent;
  const called =
    (t.isCallExpression(outer) || t.isOptionalCallExpression(outer)) && outer.callee === parent;
  if (!called) {
    if (parent.computed) {
      // `stored[i]`: a read-back of an element.
      sink('table-read', 'element read-back', parent);
      return parentPath;
    }
    return 'value';
  }
  const callPath = parentPath.parentPath;
  if (callPath === null) return 'value';
  const info = ctx.resolve({ node: outer, name: calleeIdentifier(outer) });
  const method = methodName(info);
  if (info.origin !== 'library' || info.container === null || !CONTAINERS.has(info.container)) {
    return 'value';
  }
  if (READ_BACK_METHODS.has(method)) {
    sink('table-read', `${info.name} read-back`, outer);
    return callPath;
  }
  if (MEMBERSHIP_METHODS.has(method)) {
    sink('table-read', `${info.name} read-back`, outer);
    return 'end';
  }
  if (STORE_METHODS.has(method)) return 'end';
  return 'value';
}
