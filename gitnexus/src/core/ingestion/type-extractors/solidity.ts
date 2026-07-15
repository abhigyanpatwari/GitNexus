/**
 * Solidity type extraction — minimal MVP.
 * Explicit type annotations on parameters and state variables are the
 * primary signal; inference grows in later phases.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageTypeConfig } from './types.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'state_variable_declaration',
  'variable_declaration',
  'variable_declaration_statement',
]);

const extractSolidityDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const name = nameNode.text?.trim();
  const typeName = typeNode.text?.trim();
  if (name && typeName) env.set(name, typeName);
};

const extractSolidityParameter = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type !== 'parameter') return;
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const name = nameNode.text?.trim();
  const typeName = typeNode.text?.trim();
  if (name && typeName) env.set(name, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration: extractSolidityDeclaration,
  extractParameter: extractSolidityParameter,
};
