import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  ConstructorBindingScanner,
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
} from './types.js';
import { extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_variable_declaration',
  'variable_assignment',
]);

/**
 * Lua: local x = Foo.new(...) or local x = Foo(...)
 * Extract variable name from local_variable_declaration or variable_assignment.
 */
const extractDeclaration: TypeBindingExtractor = (
  _node: SyntaxNode,
  _env: Map<string, string>,
): void => {
  // Lua is dynamically typed — no type annotations to extract
};

const extractParameter: ParameterExtractor = (
  _node: SyntaxNode,
  _env: Map<string, string>,
): void => {
  // Lua is dynamically typed — no parameter type annotations
};

const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'local_variable_declaration') return undefined;

  let varList: SyntaxNode | null = null;
  let exprList: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'variable_list') varList = child;
    if (child?.type === 'expression_list') exprList = child;
  }
  if (!varList || !exprList) return undefined;

  const firstVar = varList.firstNamedChild;
  const firstExpr = exprList.firstNamedChild;
  if (!firstVar || !firstExpr) return undefined;

  const varName = extractVarName(firstVar.childForFieldName?.('name') ?? firstVar);
  if (!varName) return undefined;

  // local obj = ClassName.new(...)
  if (firstExpr.type === 'call') {
    const funcNode = firstExpr.childForFieldName('function');
    if (funcNode?.type === 'variable') {
      const table = funcNode.childForFieldName('table');
      const field = funcNode.childForFieldName('field');
      if (table?.type === 'identifier' && field?.text === 'new') {
        return { varName, calleeName: `${table.text}.new` };
      }
    }
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: new Set(['for_generic_statement']),
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
};
