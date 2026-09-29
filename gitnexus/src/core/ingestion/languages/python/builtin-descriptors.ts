/**
 * Decide whether a method decorator names one of Python's builtin descriptor
 * types, following CPython's evaluation of the decorator expression.
 *
 * A decorator in a class body is evaluated with LOAD_NAME: the class
 * namespace first, then module globals, then builtins, each as bound at the
 * moment the `def` statement runs. Aliases, dotted names and decorator calls
 * have no known descriptor contract without import resolution, so only bare
 * spellings qualify.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';

const BUILTIN_DESCRIPTOR_NAMES = ['classmethod', 'staticmethod', 'property'] as const;

export type BuiltinDescriptor = (typeof BUILTIN_DESCRIPTOR_NAMES)[number];

const BUILTIN_DESCRIPTORS: ReadonlySet<string> = new Set(BUILTIN_DESCRIPTOR_NAMES);

/** Decorator expressions, outermost first. Tree-sitter keeps a trailing
 *  comment inside the decorator node, so read the expression child only. */
export function decoratorNames(fnNode: SyntaxNode): string[] {
  const parent = fnNode.parent;
  if (parent === null || parent.type !== 'decorated_definition') return [];
  const names: string[] = [];
  for (const child of parent.namedChildren) {
    if (child.type !== 'decorator') continue;
    // An empty name matches nothing, so a malformed decorator stays unknown.
    names.push(child.namedChildren.find((part) => part.type !== 'comment')?.text ?? '');
  }
  return names;
}

/** Does `expression` denote a builtin descriptor type (or `kind`) at `fnNode`? */
export function isBuiltinDescriptor(
  fnNode: SyntaxNode,
  expression: string,
  kind?: BuiltinDescriptor,
): boolean {
  if (kind === undefined ? !BUILTIN_DESCRIPTORS.has(expression) : expression !== kind) return false;
  // Decorators are evaluated as the `def` statement runs, so its wrapper is the
  // use site. No statement can rebind the name between stacked decorators.
  const use = fnNode.parent?.type === 'decorated_definition' ? fnNode.parent : fnNode;
  return lookupName(descriptorBindings(fnNode).get(expression) ?? [], use) !== 'shadow';
}

/**
 * The effect a name-binding operation leaves (Language Reference 4.2.1):
 * `builtin` re-imports the builtin object itself, `unbind` is a `del` that
 * makes lookup fall through to the next namespace, and `shadow` binds any
 * other value.
 */
type BindingEffect = 'shadow' | 'builtin' | 'unbind';

interface NameBinding {
  readonly node: SyntaxNode;
  readonly effect: BindingEffect;
  /** Declared `global` / `nonlocal` in the binding function (4.2.2), so it
   *  writes an outer namespace whenever that function is called. */
  readonly redirect: 'global' | 'nonlocal' | null;
}

const FUNCTION_SCOPES = new Set(['function_definition', 'lambda']);
const COMPREHENSIONS = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
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
]);
/** Simple statements whose effect always happens once execution reaches them. */
const SIMPLE_STATEMENTS = new Set([
  'expression_statement',
  'import_statement',
  'import_from_statement',
  'delete_statement',
]);

/** Is `node` the `field` child of its parent? */
function isField(node: SyntaxNode, field: string): boolean {
  return node.parent?.childForFieldName(field)?.id === node.id;
}

/** Does `statement` import from the `builtins` module? */
function importsFromBuiltins(statement: SyntaxNode | null | undefined): boolean {
  return statement?.childForFieldName('module_name')?.text === 'builtins';
}

/**
 * The binding this identifier performs, following the binding constructs of
 * Language Reference 4.2.1, or `null` for a plain read.
 */
function bindingOf(identifier: SyntaxNode): Omit<NameBinding, 'redirect'> | null {
  let node = identifier;
  let parent = node.parent;
  while (parent !== null && TARGET_WRAPPERS.has(parent.type)) {
    node = parent;
    parent = node.parent;
  }
  if (parent === null) return null;
  const shadow = { node: identifier, effect: 'shadow' as const };
  switch (parent.type) {
    case 'assignment':
    case 'augmented_assignment':
    case 'for_statement':
    case 'for_in_clause':
      return isField(node, 'left') ? shadow : null;
    case 'named_expression':
    case 'function_definition':
    case 'class_definition':
    case 'default_parameter':
    case 'typed_default_parameter':
      return isField(node, 'name') ? shadow : null;
    case 'as_pattern':
      return isField(node, 'alias') ? shadow : null;
    case 'aliased_import': {
      if (!isField(node, 'alias')) return null;
      // `from builtins import staticmethod as staticmethod` binds the builtin.
      const source = parent.childForFieldName('name')?.text;
      return importsFromBuiltins(parent.parent) && source === identifier.text
        ? { node: identifier, effect: 'builtin' }
        : shadow;
    }
    case 'typed_parameter':
      return node.type === 'identifier' ? shadow : null;
    case 'parameters':
    case 'lambda_parameters':
      return shadow;
    case 'delete_statement':
      return { node: identifier, effect: 'unbind' };
    case 'type':
      return parent.parent?.type === 'type_parameter' ||
        (parent.parent?.type === 'type_alias_statement' && isField(parent, 'left'))
        ? shadow
        : null;
    case 'dotted_name': {
      const owner = parent.parent;
      // `import a.b` binds `a`; `case name:` captures a single name.
      if (owner?.type === 'import_statement')
        return parent.firstNamedChild?.id === node.id ? shadow : null;
      if (owner?.type === 'case_pattern') return parent.namedChildCount === 1 ? shadow : null;
      if (owner?.type !== 'import_from_statement' || !isField(parent, 'name')) return null;
      return importsFromBuiltins(owner) ? { node: identifier, effect: 'builtin' } : shadow;
    }
    default:
      return null;
  }
}

const bindingsByTree = new WeakMap<object, ReadonlyMap<string, readonly NameBinding[]>>();

/** Every binding of a builtin descriptor name in the file, in source order. */
function descriptorBindings(node: SyntaxNode): ReadonlyMap<string, readonly NameBinding[]> {
  const tree = node.tree;
  const cached = bindingsByTree.get(tree);
  if (cached !== undefined) return cached;
  // `global x` / `nonlocal x` bind nothing themselves; they redirect the
  // declaring scope's own bindings of `x` to an outer namespace.
  const redirected = new Map<string, 'global' | 'nonlocal'>();
  for (const statement of tree.rootNode.descendantsOfType([
    'global_statement',
    'nonlocal_statement',
  ])) {
    const scope = scopeOf(statement)?.id;
    const kind = statement.type === 'global_statement' ? 'global' : 'nonlocal';
    for (const name of statement.namedChildren) redirected.set(`${name.text}@${scope}`, kind);
  }
  const bindings = new Map<string, NameBinding[]>();
  const add = (name: string, binding: NameBinding) => {
    const list = bindings.get(name);
    if (list === undefined) bindings.set(name, [binding]);
    else list.push(binding);
  };
  for (const found of tree.rootNode.descendantsOfType(['identifier', 'wildcard_import'])) {
    if (found.type === 'wildcard_import') {
      // `from m import *` binds every public name m defines. Unless m is
      // `builtins`, whether that includes a descriptor name is unknown here.
      const effect = importsFromBuiltins(found.parent) ? 'builtin' : 'shadow';
      for (const name of BUILTIN_DESCRIPTORS) add(name, { node: found, effect, redirect: null });
      continue;
    }
    if (!BUILTIN_DESCRIPTORS.has(found.text)) continue;
    const binding = bindingOf(found);
    if (binding === null) continue;
    const redirect = redirected.get(`${found.text}@${scopeOf(found)?.id}`) ?? null;
    add(found.text, { ...binding, redirect });
  }
  addHelperCalls(tree.rootNode, bindings);
  bindingsByTree.set(tree, bindings);
  return bindings;
}

/**
 * A bare module-level call to a same-file helper that always restores a
 * descriptor name through `global` runs that restore at the call. Record it
 * there as a module binding, so the call's position orders it.
 */
function addHelperCalls(root: SyntaxNode, bindings: Map<string, NameBinding[]>): void {
  // Helper function name -> descriptor name -> the restore its call performs.
  const helpers = new Map<string, Map<string, BindingEffect>>();
  for (const [name, list] of bindings) {
    const byHelper = new Map<number, { fn: SyntaxNode; globals: NameBinding[] }>();
    for (const binding of list) {
      if (binding.redirect !== 'global') continue;
      const fn = scopeOf(binding.node);
      if (fn === null) continue;
      const entry = byHelper.get(fn.id);
      if (entry === undefined) byHelper.set(fn.id, { fn, globals: [binding] });
      else entry.globals.push(binding);
    }
    for (const { fn, globals } of byHelper.values()) {
      const effect = restoreOnCall(fn, globals);
      const helper = fn.childForFieldName('name')?.text;
      if (effect === null || helper === undefined) continue;
      if (!helpers.has(helper)) helpers.set(helper, new Map());
      helpers.get(helper)?.set(name, effect);
    }
  }
  if (helpers.size === 0) return;
  // A call only denotes the helper when its `def` is the name's one binding.
  if (root.descendantsOfType('wildcard_import').length > 0) return;
  const bindingCounts = new Map<string, number>();
  for (const found of root.descendantsOfType('identifier')) {
    if (!helpers.has(found.text) || bindingOf(found) === null) continue;
    bindingCounts.set(found.text, (bindingCounts.get(found.text) ?? 0) + 1);
  }
  for (const [helper, count] of bindingCounts) if (count > 1) helpers.delete(helper);
  for (const statement of root.namedChildren) {
    // Only a call that is the whole statement surely runs when reached.
    if (statement.type !== 'expression_statement' || statement.namedChildCount !== 1) continue;
    const call = statement.firstNamedChild;
    const callee = call?.type === 'call' ? call.childForFieldName('function') : null;
    if (callee?.type !== 'identifier') continue;
    for (const [name, effect] of helpers.get(callee.text) ?? []) {
      const list = bindings.get(name) ?? [];
      list.push({ node: callee, effect, redirect: null });
      list.sort((a, b) => a.node.startIndex - b.node.startIndex);
    }
  }
}

/**
 * The restore a call to `fn` always performs on a module global, or `null`.
 * `fn` must be a plain module-level `def` whose body runs on call (not a
 * generator or coroutine), and every `global` binding of the name in it must
 * be a restore in a simple statement that no earlier `return` can skip.
 */
function restoreOnCall(fn: SyntaxNode, globals: readonly NameBinding[]): BindingEffect | null {
  if (fn.type !== 'function_definition' || fn.parent?.type !== 'module') return null;
  if (fn.children.some((child) => child.type === 'async')) return null;
  const body = fn.childForFieldName('body');
  const [first] = globals;
  if (body === null || first === undefined) return null;
  let effect: BindingEffect = first.effect;
  for (const binding of globals) {
    const statement = statementIn(binding.node, body);
    if (
      binding.effect === 'shadow' ||
      statement === null ||
      !SIMPLE_STATEMENTS.has(statement.type)
    ) {
      return null;
    }
    effect = binding.effect;
  }
  const escapes = body
    .descendantsOfType(['yield', 'return_statement'])
    .some(
      (node) =>
        scopeOf(node)?.id === fn.id &&
        (node.type === 'yield' || node.startIndex < first.node.startIndex),
    );
  return escapes ? null : effect;
}

/**
 * The scope that owns names bound at `node`: a function or lambda body, a
 * class body, a comprehension, or the module (`null`). A walrus target skips
 * comprehensions, as PEP 572 binds it in the enclosing scope.
 */
function scopeOf(node: SyntaxNode): SyntaxNode | null {
  const skipComprehensions = node.parent?.type === 'named_expression';
  let child = node;
  for (let parent = node.parent; parent !== null; child = parent, parent = parent.parent) {
    if (FUNCTION_SCOPES.has(parent.type)) {
      if (isField(child, 'body') || isField(child, 'parameters')) return parent;
    } else if (parent.type === 'class_definition') {
      if (isField(child, 'body')) return parent;
    } else if (COMPREHENSIONS.has(parent.type) && !skipComprehensions) {
      return parent;
    }
  }
  return null;
}

/** The statement containing `node` that sits directly in `body`. */
function statementIn(node: SyntaxNode, body: SyntaxNode): SyntaxNode | null {
  let current = node;
  while (current.parent !== null && current.parent.id !== body.id) current = current.parent;
  return current.parent === null ? null : current;
}

/** Does `outer` span `node`? */
function contains(outer: SyntaxNode, node: SyntaxNode): boolean {
  return node.startIndex >= outer.startIndex && node.endIndex <= outer.endIndex;
}

/** Can `binding` run before `use` in the same scope, including an earlier
 *  iteration of an enclosing loop? */
function mayRunBefore(binding: SyntaxNode, use: SyntaxNode, scope: SyntaxNode | null): boolean {
  if (binding.startIndex < use.startIndex) return true;
  for (let loop = use.parent; loop !== null && loop.id !== scope?.id; loop = loop.parent) {
    if (
      (loop.type === 'for_statement' || loop.type === 'while_statement') &&
      contains(loop, binding)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * What a module, class or function namespace holds for the name when
 * execution reaches `use`. A `shadow` that may have run wins. A restoring
 * effect (`builtin`, `unbind`) counts only when it is a simple statement
 * directly in the scope body that runs before `use`, so it runs exactly once
 * in order.
 */
function namespaceState(
  bindings: readonly NameBinding[],
  scope: SyntaxNode | null,
  use: SyntaxNode,
): BindingEffect {
  const body = scope === null ? null : scope.childForFieldName('body');
  let state: BindingEffect = 'unbind';
  for (const binding of bindings) {
    if (binding.redirect !== null || scopeOf(binding.node)?.id !== scope?.id) continue;
    if (!mayRunBefore(binding.node, use, scope)) continue;
    if (binding.effect === 'shadow') {
      state = 'shadow';
      continue;
    }
    const statement = statementIn(binding.node, body ?? binding.node.tree.rootNode);
    const ordered = binding.node.startIndex < use.startIndex;
    if (ordered && statement !== null && SIMPLE_STATEMENTS.has(statement.type)) {
      state = binding.effect;
    }
  }
  return state;
}

/**
 * Resolve the decorator name at `use` as a class body does (Language
 * Reference 4.2.2): the class namespace first, then the innermost enclosing
 * function that binds the name, then module globals, then builtins.
 */
function lookupName(bindings: readonly NameBinding[], use: SyntaxNode): BindingEffect {
  // Enclosing scopes, innermost first, ending with the module (`null`).
  const chain: (SyntaxNode | null)[] = [];
  for (let scope = scopeOf(use); scope !== null; scope = scopeOf(scope)) chain.push(scope);
  chain.push(null);

  const classScope = chain[0]?.type === 'class_definition' ? chain[0] : null;
  if (classScope !== null) {
    const state = namespaceState(bindings, classScope, use);
    if (state !== 'unbind') return state;
  }

  const functions = chain.filter(
    (scope): scope is SyntaxNode => scope !== null && FUNCTION_SCOPES.has(scope.type),
  );
  for (const fn of functions) {
    const owned = bindings.some(
      (binding) => binding.redirect === null && scopeOf(binding.node)?.id === fn.id,
    );
    if (!owned) continue;
    // A nested function can rebind this cell whenever it is called; that
    // order is not modelled, so assume it ran.
    const rebound = bindings.some(
      (binding) =>
        binding.effect === 'shadow' &&
        binding.redirect === 'nonlocal' &&
        contains(fn, binding.node),
    );
    if (rebound) return 'shadow';
    // Any binding makes the name local to this function, so the class body
    // reads that cell. An unbound cell raises NameError, not the builtin.
    return namespaceState(bindings, fn, use) === 'builtin' ? 'builtin' : 'shadow';
  }

  // A class body inside a function runs whenever that function is called,
  // which can be any time after its top-level statement starts. Module state
  // is therefore read at that statement, and any later module override may
  // also have run first.
  const deferred = functions.length > 0;
  const moduleUse = deferred ? (statementIn(use, use.tree.rootNode) ?? use) : use;
  for (const binding of bindings) {
    if (binding.effect !== 'shadow') continue;
    // A nested function can rebind an enclosing function's cell whenever it
    // is called; that order is not modelled, so assume it ran.
    if (binding.redirect === 'nonlocal') {
      const outer = functions[functions.length - 1];
      if (outer !== undefined && contains(outer, binding.node)) return 'shadow';
    }
    if (binding.redirect === 'global') {
      // The function can only be called once the top-level statement that
      // defines it has run. Whether a call happens is unknown, so a rebinding
      // one is assumed. A restore counts only at a proven call site (see
      // `addHelperCalls`).
      const top = statementIn(binding.node, binding.node.tree.rootNode);
      if (deferred || (top !== null && mayRunBefore(top, use, null))) return 'shadow';
    }
  }
  if (deferred) {
    const laterOverride = bindings.some(
      (binding) =>
        binding.effect === 'shadow' &&
        binding.redirect === null &&
        scopeOf(binding.node) === null &&
        binding.node.startIndex > moduleUse.startIndex,
    );
    if (laterOverride) return 'shadow';
  }
  return namespaceState(bindings, null, moduleUse);
}
