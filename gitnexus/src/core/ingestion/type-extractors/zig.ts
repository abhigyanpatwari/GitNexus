import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'variable_declaration',
]);

const extractTypeText = (typeNode: SyntaxNode | null): string | undefined => {
  if (!typeNode) return undefined;
  const typeName = extractSimpleTypeName(typeNode);
  if (typeName) return typeName;
  const raw = typeNode.text?.trim();
  return raw && raw.length < 100 ? raw : undefined;
};

/** Zig: `var cfg: Config = .{}` or `const count: usize = 1` */
const extractDeclaration: TypeBindingExtractor = (node, env) => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;

  const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
  if (!nameNode) return;

  const varName = extractVarName(nameNode);
  const typeName = extractTypeText(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Zig: `fn init(allocator: Allocator, size: usize) void` */
const extractParameter: ParameterExtractor = (node, env) => {
  const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;

  const varName = extractVarName(nameNode);
  const typeName = extractTypeText(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
