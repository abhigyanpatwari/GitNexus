/**
 * Dart type extractor — minimal implementation.
 *
 * Dart has static types but they're in the AST as type annotations.
 * This provides the minimum config needed by the LanguageProvider contract.
 */

import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ConstructorBindingScanner } from './types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { extractSimpleTypeName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'initialized_variable_definition',
  'function_signature',
  'method_signature',
]);

const extractDeclaration: TypeBindingExtractor = (_node, _env) => {
  // Dart type annotations are handled at the AST level.
  // No comment-based type extraction needed.
};

const extractParameter: ParameterExtractor = (_node, _env) => {
  // Dart parameters have inline type annotations in the AST.
};

const extractInitializer: InitializerExtractor = (node, env, classNames) => {
  // Dart: var user = User() — constructor calls without 'new'
  if (node.type !== 'initialized_variable_definition') return;
  const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
  if (!nameNode || nameNode.type !== 'identifier') return;
  const value = node.childForFieldName('value');
  if (!value) return;
  // Check for constructor call: ClassName(args)
  const funcName = value.type === 'selector_expression'
    ? value.firstNamedChild
    : value.type === 'identifier' ? value : null;
  if (!funcName) return;
  const typeName = extractSimpleTypeName(funcName);
  if (typeName && classNames.has(typeName)) {
    env.set(nameNode.text, typeName);
  }
};

const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'initialized_variable_definition') return undefined;
  const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  const value = node.childForFieldName('value');
  if (!value) return undefined;
  const funcName = value.type === 'identifier' ? value : null;
  if (!funcName) return undefined;
  const calleeName = extractSimpleTypeName(funcName);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
};
