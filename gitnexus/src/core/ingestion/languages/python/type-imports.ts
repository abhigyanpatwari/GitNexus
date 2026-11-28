import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import type { TypeImportAttribution } from '../../language-provider.js';
import { createParserForLanguage } from '../../../tree-sitter/parser-loader.js';
import { parseSourceSafe, ParseTimeoutError } from '../../../tree-sitter/safe-parse.js';
import { splitImportStatement } from './import-decomposer.js';
import { interpretPythonImport } from './interpret.js';
import { resolvePythonImportTarget, isPythonImportedModule } from './import-target.js';
import { pythonLiteralAll } from './module-accessors.js';
import { walkNamedNodes } from '../rename-tree-sitter.js';

type Node = Parser.SyntaxNode;

export type PythonBindingKind =
  | 'import'
  | 'definition'
  | 'parameter'
  | 'assignment'
  /** `x: T` declares a local without binding a value. */
  | 'annotation'
  | 'other';

export interface PythonBinding {
  readonly name: string;
  /** The identifier that receives the value. */
  readonly node: Node;
  readonly kind: PythonBindingKind;
  /** The import, definition, assignment or other statement that binds the name. */
  readonly statement: Node;
  /** Bound inside a branch, loop, handler, `with` or `match` instead of the scope body itself. */
  readonly conditional: boolean;
  /** Decorated definition, whose name may be bound to a wrapper. */
  readonly decorated?: boolean;
  /** A plain `import a.b` binds the package `a` without naming an alias. */
  readonly plainModule?: boolean;
}

export interface PythonScope {
  readonly node: Node;
  readonly kind: 'module' | 'function' | 'class' | 'comprehension';
  readonly parent: PythonScope | undefined;
  /** Names of the enclosing `def` and `class` statements, outermost first. */
  readonly path: readonly string[];
  readonly bindings: Map<string, PythonBinding[]>;
  readonly declared: Map<string, 'global' | 'nonlocal'>;
  /** The next scope a free name continues to; class bodies are not enclosing scopes. */
  readonly outer: PythonScope | undefined;
  /** The nearest scope that is not a comprehension (where `:=` binds). */
  readonly owner: PythonScope;
  readonly module: PythonScope;
}

export interface PythonVisit {
  readonly scope: PythonScope;
  /** Tree depth from the root, carried down instead of read through `.parent`. */
  readonly depth: number;
  /** The node is the value of an annotation (`x: T`, `-> T`). */
  readonly annotation: boolean;
  /** The node sits in a branch, loop, handler, `with` or `match` of its scope. */
  readonly conditional: boolean;
}

const TARGET = 1;
const CONDITIONAL = 2;
const DECORATED = 4;
const ANNOTATION = 8;

const BRANCHES = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'match_statement',
  'case_clause',
]);
const TARGET_WRAPPERS = new Set([
  'pattern_list',
  'tuple_pattern',
  'list_pattern',
  'list_splat_pattern',
  'dictionary_splat_pattern',
  'as_pattern_target',
  'expression_list',
  'parenthesized_expression',
  'tuple',
  'list',
  'list_splat',
  'case_pattern',
  'union_pattern',
  'splat_pattern',
  'dict_pattern',
  'as_pattern',
  // `type X = ...` names its alias through a `type` node.
  'type',
]);
const COMPREHENSIONS = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);

interface Pending {
  readonly node: Node;
  readonly scope: PythonScope;
  readonly flags: number;
  readonly depth: number;
  readonly kind?: PythonBindingKind;
  readonly statement?: Node;
  /** Set for a parameter list: the scope that evaluates defaults and annotations. */
  readonly outer?: PythonScope;
}

function newScope(
  node: Node,
  kind: PythonScope['kind'],
  parent: PythonScope | undefined,
  name?: string,
): PythonScope {
  const path = parent?.path ?? [];
  // Chain lookups are fixed when the scope is created, so no walk climbs them.
  const owner = kind === 'comprehension' && parent ? parent.owner : undefined;
  const module = parent?.module;
  const scope: PythonScope = {
    node,
    kind,
    parent,
    path: name === undefined ? path : [...path, name],
    bindings: new Map(),
    declared: new Map(),
    outer: parent && (parent.kind === 'class' ? parent.outer : parent),
    get owner() {
      return owner ?? scope;
    },
    get module() {
      return module ?? scope;
    },
  };
  return scope;
}

/**
 * Walk a Python tree once, top-down, recording the names each scope binds
 * (Language Reference 4.2). Scope, branch and annotation context travel down
 * an explicit stack, so the walk is linear and never reads `.parent`, which
 * tree-sitter computes by descending from the root.
 *
 * `visit` sees every named node in source order; returning `false` skips the
 * node's children and `'stop'` ends the walk.
 */
export function walkPythonScopes(
  root: Node,
  visit?: (node: Node, at: PythonVisit) => boolean | 'stop' | void,
): PythonScope {
  const module = newScope(root, 'module', undefined);
  const bind = (
    scope: PythonScope,
    node: Node,
    kind: PythonBindingKind,
    statement: Node,
    flags: number,
    extra?: Partial<PythonBinding>,
  ) => {
    const name = node.text;
    const declared = scope.declared.get(name);
    const owner =
      declared === 'global'
        ? scope.module
        : declared === 'nonlocal'
          ? (scope.outer ?? scope)
          : scope;
    const binding: PythonBinding = {
      name,
      node,
      kind,
      statement,
      conditional: (flags & CONDITIONAL) !== 0,
      ...((flags & DECORATED) !== 0 && { decorated: true }),
      ...extra,
    };
    const list = owner.bindings.get(name);
    if (list) list.push(binding);
    else owner.bindings.set(name, [binding]);
  };
  const stack: Pending[] = [{ node: root, scope: module, flags: 0, depth: 0 }];
  const push = (entry: Pending) => stack.push(entry);
  // Children are pushed last-first so they are visited in source order.
  const pushChildren = (
    node: Node,
    scope: PythonScope,
    flags: number,
    depth: number,
    extra?: Pick<Pending, 'kind' | 'statement'>,
  ) => {
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--)
      push({ node: children[i], scope, flags, depth: depth + 1, ...extra });
  };
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const { node, scope, depth } = entry;
    let flags = entry.flags;
    if (entry.outer) {
      // A parameter list: names bind in the function, the rest runs outside.
      const seen = visit?.(node, { scope, depth, annotation: false, conditional: false });
      if (seen === 'stop') break;
      if (seen === false) continue;
      const outer = entry.outer;
      const params = node.namedChildren;
      for (const param of params) {
        const name =
          param.type === 'identifier'
            ? param
            : (param.childForFieldName('name') ??
              (param.firstNamedChild?.type === 'identifier'
                ? param.firstNamedChild
                : param.firstNamedChild?.firstNamedChild));
        if (name?.type === 'identifier') bind(scope, name, 'parameter', param, 0);
      }
      for (let i = params.length - 1; i >= 0; i--) {
        for (const [field, extra] of [
          ['value', 0],
          ['type', ANNOTATION],
        ] as const) {
          const child = params[i].childForFieldName(field);
          if (child) push({ node: child, scope: outer, flags: extra, depth: depth + 2 });
        }
      }
      continue;
    }
    const seen = visit?.(node, {
      scope,
      depth,
      annotation: (flags & ANNOTATION) !== 0,
      conditional: (flags & CONDITIONAL) !== 0,
    });
    if (seen === 'stop') break;
    if (seen === false) continue;
    const type = node.type;
    if ((flags & TARGET) !== 0) {
      if (type === 'identifier') {
        bind(scope, node, entry.kind ?? 'other', entry.statement ?? node, flags);
        continue;
      }
      if (type === 'class_pattern' || type === 'keyword_pattern') {
        // The class name and keyword are references; nested patterns capture.
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 1; i--)
          push({ ...entry, node: children[i], depth: depth + 1 });
        if (type === 'class_pattern' && node.firstNamedChild)
          push({ node: node.firstNamedChild, scope, flags: flags & ~TARGET, depth: depth + 1 });
        continue;
      }
      if (type === 'dotted_name') {
        // `case x:` captures; `case Color.RED:` compares a value.
        const only = node.namedChildCount === 1 ? node.firstNamedChild : null;
        if (only) push({ ...entry, node: only, depth: depth + 1 });
        else pushChildren(node, scope, flags & ~TARGET, depth);
        continue;
      }
      if (TARGET_WRAPPERS.has(type)) {
        pushChildren(node, scope, flags, depth, { kind: entry.kind, statement: entry.statement });
        continue;
      }
      // An attribute or subscript target reads its object.
      flags &= ~TARGET;
    }
    switch (type) {
      case 'identifier':
      case 'comment':
        continue;
      case 'assignment':
      case 'augmented_assignment': {
        const right = node.childForFieldName('right');
        const annotated = node.childForFieldName('type');
        if (right) push({ node: right, scope, flags, depth: depth + 1 });
        if (annotated)
          push({ node: annotated, scope, flags: flags | ANNOTATION, depth: depth + 1 });
        const left = node.childForFieldName('left');
        if (left)
          push({
            node: left,
            scope,
            flags: flags | TARGET,
            depth: depth + 1,
            kind: right || type === 'augmented_assignment' ? 'assignment' : 'annotation',
            statement: node,
          });
        continue;
      }
      case 'named_expression': {
        const value = node.childForFieldName('value');
        if (value) push({ node: value, scope, flags, depth: depth + 1 });
        const name = node.childForFieldName('name');
        if (name) bind(scope.owner, name, 'assignment', node, flags);
        continue;
      }
      case 'for_statement': {
        for (const field of ['alternative', 'body'] as const) {
          const child = node.childForFieldName(field);
          if (child) push({ node: child, scope, flags: flags | CONDITIONAL, depth: depth + 1 });
        }
        const right = node.childForFieldName('right');
        if (right) push({ node: right, scope, flags, depth: depth + 1 });
        const left = node.childForFieldName('left');
        if (left)
          push({
            node: left,
            scope,
            flags: flags | TARGET | CONDITIONAL,
            depth: depth + 1,
            kind: 'other',
            statement: node,
          });
        continue;
      }
      case 'as_pattern': {
        // `with a as b`, `except E as e`.
        const alias = node.childForFieldName('alias');
        for (const child of node.namedChildren.reverse()) {
          if (alias && child.id === alias.id)
            push({
              node: child,
              scope,
              flags: flags | TARGET | CONDITIONAL,
              depth: depth + 1,
              kind: 'other',
              statement: node,
            });
          else push({ node: child, scope, flags, depth: depth + 1 });
        }
        continue;
      }
      case 'case_clause': {
        for (const child of node.namedChildren.reverse()) {
          const target = child.type === 'case_pattern' ? TARGET : 0;
          push({
            node: child,
            scope,
            flags: flags | CONDITIONAL | target,
            depth: depth + 1,
            ...(target && { kind: 'other' as const, statement: node }),
          });
        }
        continue;
      }
      case 'import_statement':
      case 'import_from_statement': {
        const plain = type === 'import_statement';
        for (const child of node.namedChildren) {
          if (
            type === 'import_from_statement' &&
            child.id === node.childForFieldName('module_name')?.id
          )
            continue;
          if (child.type === 'aliased_import') {
            const alias = child.childForFieldName('alias');
            if (alias) bind(scope, alias, 'import', node, flags);
          } else if (child.type === 'dotted_name' && child.firstNamedChild) {
            bind(scope, child.firstNamedChild, 'import', node, flags, {
              ...(plain && { plainModule: true }),
            });
          }
        }
        continue;
      }
      case 'global_statement':
      case 'nonlocal_statement':
        for (const name of node.namedChildren) {
          if (name.type === 'identifier')
            scope.declared.set(name.text, type === 'global_statement' ? 'global' : 'nonlocal');
        }
        continue;
      case 'delete_statement':
        pushChildren(node, scope, flags | TARGET, depth, { kind: 'other', statement: node });
        continue;
      case 'decorated_definition':
        for (const child of node.namedChildren.reverse()) {
          const decorated = child.type === 'decorator' ? 0 : DECORATED;
          push({ node: child, scope, flags: flags | decorated, depth: depth + 1 });
        }
        continue;
      case 'function_definition':
      case 'class_definition':
      case 'lambda': {
        const name = node.childForFieldName('name');
        const isClass = type === 'class_definition';
        if (name) bind(scope, name, 'definition', node, flags);
        const inner = newScope(
          node,
          isClass ? 'class' : 'function',
          scope,
          type === 'lambda' ? undefined : (name?.text ?? ''),
        );
        const body = node.childForFieldName('body');
        if (body) push({ node: body, scope: inner, flags: 0, depth: depth + 1 });
        const returns = node.childForFieldName('return_type');
        if (returns) push({ node: returns, scope, flags: flags | ANNOTATION, depth: depth + 1 });
        const bases = node.childForFieldName('superclasses');
        if (bases) push({ node: bases, scope, flags, depth: depth + 1 });
        const params = node.childForFieldName('parameters');
        if (params) push({ node: params, scope: inner, flags: 0, depth: depth + 1, outer: scope });
        const typeParams = node.childForFieldName('type_parameters');
        if (typeParams) push({ node: typeParams, scope: inner, flags: 0, depth: depth + 1 });
        continue;
      }
      case 'type_alias_statement': {
        const right = node.childForFieldName('right');
        if (right) push({ node: right, scope, flags: flags | ANNOTATION, depth: depth + 1 });
        const left = node.childForFieldName('left');
        if (left)
          push({
            node: left,
            scope,
            flags: flags | TARGET,
            depth: depth + 1,
            kind: 'other',
            statement: node,
          });
        continue;
      }
      case 'keyword_argument': {
        const value = node.childForFieldName('value');
        if (value) push({ node: value, scope, flags, depth: depth + 1 });
        continue;
      }
      case 'attribute': {
        const object = node.childForFieldName('object');
        if (object) push({ node: object, scope, flags, depth: depth + 1 });
        continue;
      }
      case 'type':
        pushChildren(node, scope, flags | ANNOTATION, depth);
        continue;
    }
    if (COMPREHENSIONS.has(type)) {
      const inner = newScope(node, 'comprehension', scope);
      let first = true;
      const order: Pending[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'for_in_clause') {
          const seen = visit?.(child, {
            scope: inner,
            depth: depth + 1,
            annotation: false,
            conditional: true,
          });
          if (seen === 'stop') return module;
          if (seen === false) continue;
          // Only the first iterable is evaluated in the enclosing scope.
          const right = child.childForFieldName('right');
          const left = child.childForFieldName('left');
          if (left)
            order.push({
              node: left,
              scope: inner,
              flags: TARGET,
              depth: depth + 2,
              kind: 'other',
              statement: child,
            });
          if (right)
            order.push({ node: right, scope: first ? scope : inner, flags: 0, depth: depth + 2 });
          first = false;
        } else order.push({ node: child, scope: inner, flags: 0, depth: depth + 1 });
      }
      for (let i = order.length - 1; i >= 0; i--) push(order[i]);
      continue;
    }
    pushChildren(node, scope, BRANCHES.has(type) ? flags | CONDITIONAL : flags, depth);
  }
  return module;
}

export type PythonResolution = { scope: PythonScope; bindings: readonly PythonBinding[] } | null;

/**
 * Resolve a name read in `scope` to the bindings of the scope that owns it
 * (LEGB, class bodies excluded from enclosing lookups). Order of execution
 * is ignored: every binding in the owning scope is returned. Results are
 * memoised per scope, so resolving many reads stays linear.
 */
export function pythonNameResolver() {
  const memo = new Map<PythonScope, Map<string, PythonResolution>>();
  const resolve = (scope: PythonScope, name: string): PythonResolution => {
    const chain: PythonScope[] = [];
    let result: PythonResolution | undefined;
    for (let current: PythonScope | undefined = scope; current; ) {
      const cached = memo.get(current)?.get(name);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      chain.push(current);
      const declared = current.declared.get(name);
      if (declared === 'global' && current.module !== current) {
        current = current.module;
        continue;
      }
      const bindings = declared === 'nonlocal' ? undefined : current.bindings.get(name);
      if (bindings?.length) {
        result = { scope: current, bindings };
        break;
      }
      current = current.outer;
    }
    result ??= null;
    for (const visited of chain) {
      // A class scope only answers for reads in its own body.
      if (visited !== scope && visited.kind === 'class') continue;
      let names = memo.get(visited);
      if (!names) memo.set(visited, (names = new Map()));
      names.set(name, result);
    }
    return result;
  };
  return resolve;
}

/** `a.b.c` for an identifier or a chain of attributes on one, else undefined. */
export function pythonDottedName(node: Node | null | undefined, limit = 32): string | undefined {
  const parts: string[] = [];
  let current = node;
  while (current?.type === 'parenthesized_expression' && current.namedChildCount === 1)
    current = current.firstNamedChild;
  while (current?.type === 'attribute') {
    const attribute = current.childForFieldName('attribute');
    if (!attribute || parts.length >= limit) return undefined;
    parts.push(attribute.text);
    current = current.childForFieldName('object');
    while (current?.type === 'parenthesized_expression' && current.namedChildCount === 1)
      current = current.firstNamedChild;
  }
  if (current?.type !== 'identifier') return undefined;
  parts.push(current.text);
  return parts.reverse().join('.');
}

// Imports that cannot name the owner module are bound without being decoded.
const maxDecodedImports = 2048;
const maxImportDepth = 64;

function moduleStem(ownerPath: string): string | undefined {
  const parts = ownerPath.replace(/\\/g, '/').split('/');
  const base = parts.at(-1)?.replace(/\.py$/i, '');
  return base === '__init__' ? parts.at(-2) : base;
}

async function importsClass(
  root: Node,
  fromFile: string,
  importedPaths: ReadonlySet<string>,
  owner: string,
  className: string,
  wildcardExport: () => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  if (root.hasError) return undefined;
  const context = { fromFile, allFilePaths: importedPaths };
  const stem = moduleStem(owner);
  // Receivers that name the owner module, per (import statement, bound root).
  const aliases = new Map<string, Set<string>>();
  const receivers = new Set<string>();
  const key = (statement: Node, root: string) => statement.id + '\0' + root;
  const uses: { receiver: string; scope: PythonScope }[] = [];
  const reflective: { receiver: string; scope: PythonScope }[] = [];
  let decoded = 0;
  let named = false;
  let wildcard = false;
  let uncertain = false;
  let typeMention = false;
  walkPythonScopes(root, (node, at) => {
    const type = node.type;
    if (type === 'import_statement' || type === 'import_from_statement') {
      const text = node.text;
      const relative = node.childForFieldName('module_name')?.text.startsWith('.') ?? false;
      // The walker still records the names every import binds.
      if (stem !== undefined && !relative && !text.includes(stem)) return;
      // The decomposer climbs ancestors per statement; keep that work bounded.
      if (++decoded > maxDecodedImports || at.depth > maxImportDepth) {
        uncertain = true;
        return;
      }
      for (const match of splitImportStatement(node)) {
        const imp = interpretPythonImport(match);
        if (!imp) continue;
        let alias: string | undefined;
        if (imp.kind === 'named' || imp.kind === 'alias') {
          if (
            imp.importedName === className &&
            resolvePythonImportTarget({ ...imp, targetIncludesImportedName: true }, context) ===
              owner
          )
            named = true;
          else if (
            resolvePythonImportTarget(imp, context) === owner &&
            isPythonImportedModule(imp, owner, fromFile)
          )
            alias = imp.localName;
        } else if (imp.kind === 'namespace' && resolvePythonImportTarget(imp, context) === owner) {
          alias = imp.explicitAlias ? imp.localName : imp.targetRaw;
        } else if (imp.kind === 'wildcard' && resolvePythonImportTarget(imp, context) === owner) {
          wildcard = true;
        }
        if (!alias) continue;
        receivers.add(alias);
        const id = key(node, alias.split('.')[0]);
        const set = aliases.get(id);
        if (set) set.add(alias);
        else aliases.set(id, new Set([alias]));
      }
      return;
    }
    if (type === 'attribute') {
      const attribute = node.childForFieldName('attribute');
      if (
        attribute &&
        attribute.endIndex - attribute.startIndex === className.length &&
        attribute.text === className
      ) {
        const receiver = pythonDottedName(node.childForFieldName('object'));
        if (receiver) uses.push({ receiver, scope: at.scope });
        else if (at.annotation) typeMention = true;
      }
      return;
    }
    if (type === 'string_content' && at.annotation && node.text.includes(className)) {
      typeMention = true;
      return;
    }
    if (type === 'call') {
      // getattr(module, ...) can read the class without naming it.
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'getattr') {
        const receiver = pythonDottedName(node.childForFieldName('arguments')?.firstNamedChild);
        if (receiver) reflective.push({ receiver, scope: at.scope });
      }
    }
  });
  if (named) return true;
  const resolve = pythonNameResolver();
  // A qualified use is the owner's class only when its receiver resolves to
  // an import of the owner module. Shadowed and unbound receivers are unknown.
  const admitted = (receiver: string, scope: PythonScope): boolean | undefined => {
    const head = receiver.split('.')[0];
    const resolution = resolve(scope, head);
    if (!resolution) return undefined;
    let matched = false;
    for (const binding of resolution.bindings) {
      if (binding.kind !== 'import') return undefined;
      const names = aliases.get(key(binding.statement, head));
      if (names?.has(receiver)) matched = true;
      else if (!names && !binding.plainModule) return undefined;
    }
    return matched || undefined;
  };
  for (const use of uses) {
    if (!receivers.has(use.receiver)) continue;
    if (admitted(use.receiver, use.scope)) return true;
    uncertain = true;
  }
  // A string annotation or reflective lookup can name the class at runtime.
  if (receivers.size && (typeMention || reflective.some((use) => receivers.has(use.receiver))))
    uncertain = true;
  if (wildcard) {
    const exported = await wildcardExport();
    if (exported !== false) return exported;
  }
  return uncertain ? undefined : false;
}

// Module-level code that can rebind `__all__` or the module namespace at
// runtime. Checked before any literal `__all__` or default-export rule.
function dynamicModuleNamespace(root: Node): boolean {
  // A mention in prose does not bind the export list.
  const skipDocstring = (node: Node) => {
    if (node.type !== 'expression_statement') return false;
    const value = node.firstNamedChild;
    return (
      value?.type === 'string' &&
      !value.namedChildren.some((child) => child.type === 'interpolation')
    );
  };
  for (const node of walkNamedNodes(root, skipDocstring)) {
    if (
      node.type === 'string_content' &&
      node.endIndex - node.startIndex === 7 &&
      node.text === '__all__'
    )
      return true;
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier') continue;
      const length = fn.endIndex - fn.startIndex;
      if (length === 4 && (fn.text === 'exec' || fn.text === 'eval')) return true;
      // globals()/vars() written through: `globals()[k] = v`, `globals().update(d)`.
      if ((length === 7 && fn.text === 'globals') || (length === 4 && fn.text === 'vars')) {
        if (!node.childForFieldName('arguments')?.namedChildCount) return true;
      }
    }
  }
  return false;
}

export const createPythonTypeImportClassifier: TypeImportAttribution['createClassifier'] = async ({
  ownerPath,
  name: className,
  readOwner,
}) => {
  const parser = await createParserForLanguage(SupportedLanguages.Python);
  const parseRoot = (source: string) => {
    try {
      return parseSourceSafe(parser, source).rootNode;
    } catch (error) {
      if (error instanceof ParseTimeoutError) return undefined;
      throw error;
    }
  };
  let wildcard: Promise<boolean | undefined> | undefined;
  const wildcardExport = async () => {
    const source = await readOwner();
    if (!source) return undefined;
    const root = parseRoot(source);
    if (!root || root.hasError) return undefined;
    if (dynamicModuleNamespace(root)) return undefined;
    if (!source.includes('__all__')) return !className.startsWith('_');
    const names = pythonLiteralAll(root);
    if (names !== undefined) return names.includes(className);
    // An identifier can refer to a list whose contents we cannot establish.
    for (const node of walkNamedNodes(root)) {
      if (
        node.type === 'identifier' &&
        node.endIndex - node.startIndex === 7 &&
        node.text === '__all__'
      )
        return undefined;
    }
    return !className.startsWith('_');
  };
  return (filePath, source, resolvedImports) => {
    const root = parseRoot(source);
    return root
      ? importsClass(
          root,
          filePath,
          resolvedImports,
          ownerPath,
          className,
          () => (wildcard ??= wildcardExport()),
        )
      : undefined;
  };
};
