import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner, ReturnTypeExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName, hasTypeAnnotation, unwrapAwait, extractCalleeName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'lexical_declaration',
  'variable_declaration',
  'function_declaration',   // JSDoc @param on function declarations
  'method_definition',      // JSDoc @param on class methods
]);

const normalizeJsDocType = (raw: string): string | undefined => {
  let type = raw.trim();
  // Strip JSDoc nullable/non-nullable prefixes: ?User → User, !User → User
  if (type.startsWith('?') || type.startsWith('!')) type = type.slice(1);
  // Strip union with null/undefined/void: User|null → User
  const parts = type.split('|').map(p => p.trim()).filter(p =>
    p !== 'null' && p !== 'undefined' && p !== 'void'
  );
  if (parts.length !== 1) return undefined; // ambiguous union
  type = parts[0];
  // Strip module: prefix — module:models.User → models.User
  if (type.startsWith('module:')) type = type.slice(7);
  // Take last segment of dotted path: models.User → User
  const segments = type.split('.');
  type = segments[segments.length - 1];
  // Strip generic wrapper: Promise<User> → Promise (base type, not inner)
  const genericMatch = type.match(/^(\w+)\s*</);
  if (genericMatch) type = genericMatch[1];
  // Simple identifier check
  if (/^\w+$/.test(type)) return type;
  return undefined;
};

/** Regex to extract JSDoc @param annotations: `@param {Type} name` */
const JSDOC_PARAM_RE = /@param\s*\{([^}]+)\}\s+\[?(\w+)[\]=]?[^\s]*/g;

/**
 * Collect JSDoc @param type bindings from comment nodes preceding a function/method.
 * Returns a map of paramName → typeName.
 */
const collectJsDocParams = (funcNode: SyntaxNode): Map<string, string> => {
  const commentTexts: string[] = [];
  let sibling = funcNode.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      commentTexts.unshift(sibling.text);
    } else if (sibling.isNamed && sibling.type !== 'decorator') {
      break;
    }
    sibling = sibling.previousSibling;
  }
  if (commentTexts.length === 0) return new Map();

  const params = new Map<string, string>();
  const commentBlock = commentTexts.join('\n');
  JSDOC_PARAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSDOC_PARAM_RE.exec(commentBlock)) !== null) {
    const typeName = normalizeJsDocType(match[1]);
    const paramName = match[2];
    if (typeName) {
      params.set(paramName, typeName);
    }
  }
  return params;
};

/**
 * TypeScript: const x: Foo = ..., let x: Foo
 * Also: JSDoc @param annotations on function/method definitions (for .js files).
 */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // JSDoc @param on functions/methods — pre-populate env with param types
  if (node.type === 'function_declaration' || node.type === 'method_definition') {
    const jsDocParams = collectJsDocParams(node);
    for (const [paramName, typeName] of jsDocParams) {
      if (!env.has(paramName)) env.set(paramName, typeName);
    }
    return;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const typeAnnotation = declarator.childForFieldName('type');
    if (!nameNode || !typeAnnotation) continue;
    const varName = extractVarName(nameNode);
    const typeName = extractSimpleTypeName(typeAnnotation);
    if (varName && typeName) env.set(varName, typeName);
  }
};

/** TypeScript: required_parameter / optional_parameter → name: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    nameNode = node.childForFieldName('pattern') ?? node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  } else {
    // Generic fallback
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** TypeScript: const x = new User() — infer type from new_expression */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ClassNameLookup): void => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (declarator?.type !== 'variable_declarator') continue;
    // Only activate when there is no explicit type annotation — extractDeclaration already
    // handles the annotated case and this function is called as a fallback.
    if (declarator.childForFieldName('type') !== null) continue;
    let valueNode = declarator.childForFieldName('value');
    // Unwrap `new User() as T`, `new User()!`, and double-cast `new User() as unknown as T`
    while (valueNode?.type === 'as_expression' || valueNode?.type === 'non_null_expression') {
      valueNode = valueNode.firstNamedChild;
    }
    if (valueNode?.type !== 'new_expression') continue;
    const constructorNode = valueNode.childForFieldName('constructor');
    if (!constructorNode) continue;
    const nameNode = declarator.childForFieldName('name');
    if (!nameNode) continue;
    const varName = extractVarName(nameNode);
    const typeName = extractSimpleTypeName(constructorNode);
    if (varName && typeName) env.set(varName, typeName);
  }
};

/**
 * TypeScript/JavaScript: const user = getUser() — variable_declarator with call_expression value.
 * Only matches unannotated declarators; annotated ones are handled by extractDeclaration.
 * await is unwrapped: const user = await fetchUser() → callee = 'fetchUser'.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'variable_declarator') return undefined;
  if (hasTypeAnnotation(node)) return undefined;
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  const value = unwrapAwait(node.childForFieldName('value'));
  if (!value || value.type !== 'call_expression') return undefined;
  const calleeName = extractCalleeName(value);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
};

/** Regex to extract @returns or @return from JSDoc comments: `@returns {Type}` */
const JSDOC_RETURN_RE = /@returns?\s*\{([^}]+)\}/;

/**
 * Minimal sanitization for JSDoc return types — preserves generic wrappers
 * (e.g. `Promise<User>`) so that extractReturnTypeName in call-processor
 * can apply WRAPPER_GENERICS unwrapping. Unlike normalizeJsDocType (which
 * strips generics), this only strips JSDoc-specific syntax markers.
 */
const sanitizeReturnType = (raw: string): string | undefined => {
  let type = raw.trim();
  // Strip JSDoc nullable/non-nullable prefixes: ?User → User, !User → User
  if (type.startsWith('?') || type.startsWith('!')) type = type.slice(1);
  // Strip module: prefix — module:models.User → models.User
  if (type.startsWith('module:')) type = type.slice(7);
  // Reject unions (ambiguous)
  if (type.includes('|')) return undefined;
  if (!type) return undefined;
  return type;
};

/**
 * Extract return type from JSDoc `@returns {Type}` or `@return {Type}` annotation
 * preceding a function/method definition. Walks backwards through preceding siblings
 * looking for comment nodes containing the annotation.
 */
const extractReturnType: ReturnTypeExtractor = (node) => {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = JSDOC_RETURN_RE.exec(sibling.text);
      if (match) return sanitizeReturnType(match[1]);
    } else if (sibling.isNamed && sibling.type !== 'decorator') break;
    sibling = sibling.previousSibling;
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractReturnType,
};
