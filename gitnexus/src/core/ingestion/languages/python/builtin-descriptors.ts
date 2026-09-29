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

export type BuiltinDescriptor = 'classmethod' | 'staticmethod' | 'property';

const BUILTIN_DESCRIPTORS: ReadonlySet<string> = new Set<BuiltinDescriptor>([
  'classmethod',
  'staticmethod',
  'property',
]);

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
  const useSite = fnNode.parent?.type === 'decorated_definition' ? fnNode.parent : fnNode;
  return !descriptorBindings(fnNode)
    .get(expression)
    ?.some((b) => isVisibleAt(b, useSite));
}

interface NameBinding {
  readonly node: SyntaxNode;
  /** `global` / `nonlocal` rebind at a time the syntax cannot place. */
  readonly anyTime: boolean;
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

/** Is `node` the `field` child of its parent? */
function isField(node: SyntaxNode, field: string): boolean {
  return node.parent?.childForFieldName(field)?.id === node.id;
}

/**
 * Does this identifier bind its name, as CPython's symbol table would record
 * it? Plain reads and `from builtins import <name>` (which binds the builtin
 * itself) do not.
 */
function bindingOf(identifier: SyntaxNode): NameBinding | null {
  let node = identifier;
  let parent = node.parent;
  while (parent !== null && TARGET_WRAPPERS.has(parent.type)) {
    node = parent;
    parent = node.parent;
  }
  if (parent === null) return null;
  const binding = { node: identifier, anyTime: false };
  switch (parent.type) {
    case 'assignment':
    case 'augmented_assignment':
    case 'for_statement':
    case 'for_in_clause':
      return isField(node, 'left') ? binding : null;
    case 'named_expression':
    case 'function_definition':
    case 'class_definition':
    case 'default_parameter':
    case 'typed_default_parameter':
      return isField(node, 'name') ? binding : null;
    case 'as_pattern':
    case 'aliased_import':
      return isField(node, 'alias') ? binding : null;
    case 'typed_parameter':
      return node.type === 'identifier' ? binding : null;
    case 'parameters':
    case 'lambda_parameters':
    case 'delete_statement':
      return binding;
    case 'global_statement':
    case 'nonlocal_statement':
      return { node: identifier, anyTime: true };
    case 'type':
      return parent.parent?.type === 'type_parameter' ||
        (parent.parent?.type === 'type_alias_statement' && isField(parent, 'left'))
        ? binding
        : null;
    case 'dotted_name': {
      const owner = parent.parent;
      // `import a.b` binds `a`; `case name:` captures a single name.
      if (owner?.type === 'import_statement')
        return parent.firstNamedChild?.id === node.id ? binding : null;
      if (owner?.type === 'case_pattern') return parent.namedChildCount === 1 ? binding : null;
      if (owner?.type !== 'import_from_statement' || !isField(parent, 'name')) return null;
      return owner.childForFieldName('module_name')?.text === 'builtins' ? null : binding;
    }
    default:
      return null;
  }
}

const bindingsByTree = new WeakMap<object, ReadonlyMap<string, readonly NameBinding[]>>();

/** Every binding of a builtin descriptor name in the file, computed once per tree. */
function descriptorBindings(node: SyntaxNode): ReadonlyMap<string, readonly NameBinding[]> {
  const tree = node.tree;
  const cached = bindingsByTree.get(tree);
  if (cached !== undefined) return cached;
  const bindings = new Map<string, NameBinding[]>();
  const add = (name: string, binding: NameBinding) => {
    const list = bindings.get(name);
    if (list === undefined) bindings.set(name, [binding]);
    else list.push(binding);
  };
  for (const found of tree.rootNode.descendantsOfType(['identifier', 'wildcard_import'])) {
    if (found.type === 'wildcard_import') {
      // `from m import *` may bind any public name at that point.
      for (const name of BUILTIN_DESCRIPTORS) add(name, { node: found, anyTime: false });
      continue;
    }
    if (!BUILTIN_DESCRIPTORS.has(found.text)) continue;
    const binding = bindingOf(found);
    if (binding !== null) add(found.text, binding);
  }
  bindingsByTree.set(tree, bindings);
  return bindings;
}

/**
 * The scope that owns names bound at `node`: a function or lambda body, a
 * class body, a comprehension, or the module (`null`). A walrus target skips
 * comprehensions, as PEP 572 binds it in the enclosing scope.
 */
function scopeOf(node: SyntaxNode, skipComprehensions = false): SyntaxNode | null {
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

/** Did `binding` run before `use` in the same scope, or can a loop repeat it first? */
function runsBefore(binding: SyntaxNode, use: SyntaxNode, scope: SyntaxNode | null): boolean {
  if (binding.startIndex < use.startIndex) return true;
  for (let loop = use.parent; loop !== null && loop.id !== scope?.id; loop = loop.parent) {
    if (
      (loop.type === 'for_statement' || loop.type === 'while_statement') &&
      binding.startIndex >= loop.startIndex &&
      binding.endIndex <= loop.endIndex
    ) {
      return true;
    }
  }
  return false;
}

/** Is `binding` in effect when CPython evaluates a decorator at `use`? */
function isVisibleAt(binding: NameBinding, use: SyntaxNode): boolean {
  if (binding.anyTime) return true;
  const bindingScope = scopeOf(binding.node, binding.node.parent?.type === 'named_expression');
  // The chain of scopes the decorator's name lookup can reach, innermost first.
  const chain: (SyntaxNode | null)[] = [scopeOf(use)];
  while (chain[chain.length - 1] !== null) chain.push(scopeOf(chain[chain.length - 1]!));
  const index = chain.findIndex((scope) => scope?.id === bindingScope?.id);
  if (index < 0) return false;
  // A binding anywhere in a function makes the name local to it, so the
  // decorator never reaches the builtin (it reads the local or raises).
  if (bindingScope !== null && !(bindingScope.type === 'class_definition')) return true;
  // An enclosing class body is not visible to a nested scope.
  if (bindingScope !== null) return index === 0 && runsBefore(binding.node, use, bindingScope);
  // A class body inside a function runs only when that function is called,
  // after the whole module has executed.
  const deferred = chain.some((scope) => scope !== null && FUNCTION_SCOPES.has(scope.type));
  return deferred || runsBefore(binding.node, use, null);
}
