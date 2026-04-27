/**
 * Lua type extractor configuration.
 *
 * Lua is dynamically typed — there are no explicit type annotations.
 * This extractor provides a minimal implementation that records
 * constructor-call bindings (`local x = Foo.new(...)`) so the pipeline
 * can still emit call edges, but does not attempt type inference.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageTypeConfig } from '../type-extractors/types.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_variable_declaration',
  'assignment_statement',
]);

/**
 * Lua: local x = Foo.new() / local x = Foo()
 * Extracts a constructor-call binding so the pipeline can infer types on
 * the left-hand-side variable. Lua has no explicit type system, so we
 * only record the callee name as a heuristic type hint.
 */
const extractDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  // local x = Foo()  /  local x = Foo.new()
  if (node.type !== 'local_variable_declaration' && node.type !== 'assignment_statement') return;

  // Find the variable name(s) and the rhs expression(s).
  // Tree-sitter-lua: local_variable_declaration has attribute_list + expression_list children.
  const attrList =
    node.type === 'local_variable_declaration'
      ? (node.children.find((c) => c.type === 'attribute_list') ?? null)
      : (node.children.find((c) => c.type === 'variable_list') ?? null);

  const exprList = node.children.find((c) => c.type === 'expression_list') ?? null;
  if (!attrList || !exprList) return;

  // Only handle single-name = single-expression for simplicity.
  const nameNode =
    node.type === 'local_variable_declaration'
      ? attrList.children.find((c) => c.type === 'identifier') ?? null
      : attrList.children.find((c) => c.type === 'identifier') ?? null;

  const exprNode = exprList.children.find((c) => c.isNamed) ?? null;
  if (!nameNode || !exprNode) return;

  // Heuristic: if the RHS is a function call to something ending in .new or a PascalCase name
  if (exprNode.type === 'function_call_expression') {
    const nameField = exprNode.children.find((c) => c.isNamed);
    if (nameField) {
      env.set(nameNode.text, nameField.text);
    }
  }
};

const extractParameter = (_node: SyntaxNode, _env: Map<string, string>): void => {
  // Lua has no type annotations on parameters; no-op.
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
