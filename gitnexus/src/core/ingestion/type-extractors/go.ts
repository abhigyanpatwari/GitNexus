import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'var_declaration',
  'var_spec',
  'short_var_declaration',
]);

/** Go: var x Foo */
const extractGoVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  // Go var_declaration contains var_spec children
  if (node.type === 'var_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const spec = node.namedChild(i);
      if (spec?.type === 'var_spec') extractGoVarDeclaration(spec, env);
    }
    return;
  }

  // var_spec: name type [= value]
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: x := Foo{...} — infer type from composite literal (handles multi-assignment) */
const extractGoShortVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  // Collect LHS names and RHS values (may be expression_lists for multi-assignment)
  const lhsNodes: SyntaxNode[] = [];
  const rhsNodes: SyntaxNode[] = [];

  if (left.type === 'expression_list') {
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c) lhsNodes.push(c);
    }
  } else {
    lhsNodes.push(left);
  }

  if (right.type === 'expression_list') {
    for (let i = 0; i < right.namedChildCount; i++) {
      const c = right.namedChild(i);
      if (c) rhsNodes.push(c);
    }
  } else {
    rhsNodes.push(right);
  }

  // Pair each LHS name with its corresponding RHS value
  const count = Math.min(lhsNodes.length, rhsNodes.length);
  for (let i = 0; i < count; i++) {
    const valueNode = rhsNodes[i];
    if (valueNode.type !== 'composite_literal') continue;
    const typeNode = valueNode.childForFieldName('type');
    if (!typeNode) continue;
    const typeName = extractSimpleTypeName(typeNode);
    if (!typeName) continue;
    const varName = extractVarName(lhsNodes[i]);
    if (varName) env.set(varName, typeName);
  }
};

const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type === 'var_declaration' || node.type === 'var_spec') {
    extractGoVarDeclaration(node, env);
  } else if (node.type === 'short_var_declaration') {
    extractGoShortVarDeclaration(node, env);
  }
};

/** Go: parameter → name type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
