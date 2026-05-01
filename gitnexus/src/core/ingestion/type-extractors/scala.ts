import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  ConstructorBindingScanner,
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
} from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'val_definition',
  'var_definition',
]);

const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  const pattern = node.childForFieldName('pattern');
  const typeNode = node.childForFieldName('type');
  if (!pattern || !typeNode) return;
  const varName = extractVarName(pattern);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

const extractParameter: ParameterExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type !== 'parameter' && node.type !== 'class_parameter') return;
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'val_definition') return undefined;
  const pattern = node.childForFieldName('pattern');
  const value = node.childForFieldName('value');
  if (!pattern || !value) return undefined;
  const varName = extractVarName(pattern);
  if (!varName) return undefined;

  if (value.type === 'call_expression') {
    const funcNode = value.childForFieldName('function');
    if (funcNode) {
      const calleeName = funcNode.text;
      if (calleeName) return { varName, calleeName };
    }
  }
  if (value.type === 'instance_expression') {
    const typeNode = value.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    if (typeNode) return { varName, calleeName: typeNode.text };
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: new Set(['for_expression']),
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
};
