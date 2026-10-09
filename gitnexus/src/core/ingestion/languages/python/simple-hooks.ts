/**
 * Trivial / no-op-ish hooks for the Python provider. Kept together
 * because each is a few lines and they share a common theme: they exist
 * to make the provider's choice explicit (rather than relying on
 * "absence == default") so reviewers don't have to re-derive the
 * analysis.
 */

import type {
  CaptureMatch,
  NodeLabel,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';
import type { SyntaxNode } from 'tree-sitter';
import { walkToScope } from '../../utils/scope-tree-walk.js';

/** Parsed trees are immutable during ingestion. Keep only block IDs and names
 * in the cache so repeated declaration/receiver classification scans each tree
 * once, without retaining its AST after the tree is released. */
const globalsByTree = new WeakMap<object, ReadonlyMap<number, ReadonlySet<string>>>();

function enclosingPythonCodeBlock(node: SyntaxNode): SyntaxNode | null {
  let enclosing = node.parent;
  while (enclosing !== null) {
    if (
      enclosing.type === 'function_definition' ||
      enclosing.type === 'class_definition' ||
      enclosing.type === 'module'
    ) {
      return enclosing;
    }
    enclosing = enclosing.parent;
  }
  return null;
}

/** `global` belongs to its function or class code block, never to enclosing
 * blocks. It affects every declaration of that name in the same block. */
export function isPythonGlobalDeclaration(node: SyntaxNode, name: string): boolean {
  const owner = enclosingPythonCodeBlock(node);
  if (owner === null || owner.type === 'module') return false;
  let globals = globalsByTree.get(node.tree);
  if (globals === undefined) {
    const byBlock = new Map<number, Set<string>>();
    for (const statement of node.tree.rootNode.descendantsOfType('global_statement')) {
      const block = enclosingPythonCodeBlock(statement);
      if (block === null || block.type === 'module') continue;
      let names = byBlock.get(block.id);
      if (names === undefined) {
        names = new Set();
        byBlock.set(block.id, names);
      }
      for (const identifier of statement.namedChildren) {
        if (identifier.type === 'identifier') names.add(identifier.text);
      }
    }
    globals = byBlock;
    globalsByTree.set(node.tree, globals);
  }
  return globals.get(owner.id)?.has(name) ?? false;
}

export function pythonFunctionDefinitionLabel(
  functionNode: SyntaxNode,
  defaultLabel: NodeLabel,
): NodeLabel {
  if (defaultLabel !== 'Function') return defaultLabel;
  if (enclosingPythonCodeBlock(functionNode)?.type !== 'class_definition') return 'Function';
  const name = functionNode.childForFieldName('name')?.text;
  return name !== undefined && isPythonGlobalDeclaration(functionNode, name)
    ? 'Function'
    : 'Method';
}

// ─── bindingScopeFor ──────────────────────────────────────────────────────

/** Python has no block scope, so the central extractor's "innermost
 *  enclosing scope" default is already correct for ordinary bindings.
 *  Explicit `global` declarations and constructor-injected instance fields
 *  are the exceptions. */
export function pythonBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@declaration.global'] !== undefined) {
    return walkToScope(innermost, tree, 'Module');
  }
  if (decl['@type-binding.instance-field'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }
  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/** Function-local `from x import Y` should attach the binding to the
 *  function scope, not the module. Class-body imports (rare but legal —
 *  `class A: import x` makes `x` a class attribute) attach to the class.
 *  Module-level imports delegate to the central default. */
export function pythonImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Function' || innermost.kind === 'Class') return innermost.id;
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/** Look up `self` or `cls` in the function scope's type bindings.
 *  Returns `null` for free functions (no `self`/`cls`) and for
 *  non-Function scopes. */
export function pythonReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('self') ?? functionScope.typeBindings.get('cls') ?? null;
}
