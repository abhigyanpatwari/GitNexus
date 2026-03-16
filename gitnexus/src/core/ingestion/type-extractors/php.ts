import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner, ReturnTypeExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName, extractCalleeName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment_expression',   // For constructor inference: $x = new User()
  'property_declaration',    // PHP 7.4+ typed properties: private UserRepo $repo;
  'method_declaration',      // PHPDoc @param on class methods
  'function_definition',     // PHPDoc @param on top-level functions
]);

/** Walk up the AST to find the enclosing class declaration. */
const findEnclosingClass = (node: SyntaxNode): SyntaxNode | null => {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration') return current;
    current = current.parent;
  }
  return null;
};

/**
 * Resolve PHP self/static/parent to the actual class name.
 * - self/static → enclosing class name
 * - parent → superclass from base_clause
 */
const resolvePhpKeyword = (keyword: string, node: SyntaxNode): string | undefined => {
  if (keyword === 'self' || keyword === 'static') {
    const cls = findEnclosingClass(node);
    if (!cls) return undefined;
    const nameNode = cls.childForFieldName('name');
    return nameNode?.text;
  }
  if (keyword === 'parent') {
    const cls = findEnclosingClass(node);
    if (!cls) return undefined;
    // base_clause contains the parent class name
    for (let i = 0; i < cls.namedChildCount; i++) {
      const child = cls.namedChild(i);
      if (child?.type === 'base_clause') {
        const parentName = child.firstNamedChild;
        if (parentName) return extractSimpleTypeName(parentName);
      }
    }
    return undefined;
  }
  return undefined;
};

const normalizePhpType = (raw: string): string | undefined => {
  // Strip nullable prefix: ?User → User
  let type = raw.startsWith('?') ? raw.slice(1) : raw;
  // Strip array suffix: User[] → User
  type = type.replace(/\[\]$/, '');
  // Strip union with null/false/void: User|null → User
  const parts = type.split('|').filter(p => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed');
  if (parts.length !== 1) return undefined;
  type = parts[0];
  // Strip namespace: \App\Models\User → User
  const segments = type.split('\\');
  type = segments[segments.length - 1];
  // Skip uninformative types
  if (type === 'mixed' || type === 'void' || type === 'self' || type === 'static' || type === 'object') return undefined;
  if (/^\w+$/.test(type)) return type;
  return undefined;
};

/** Node types to skip when walking backwards to find doc-comments.
 *  PHP 8+ attributes (#[Route(...)]) appear as named siblings between PHPDoc and method. */
const SKIP_NODE_TYPES: ReadonlySet<string> = new Set(['attribute_list', 'attribute']);

/** Regex to extract PHPDoc @param annotations: `@param Type $name` (standard order) */
const PHPDOC_PARAM_RE = /@param\s+(\S+)\s+\$(\w+)/g;
/** Alternate PHPDoc order: `@param $name Type` (name first) */
const PHPDOC_PARAM_ALT_RE = /@param\s+\$(\w+)\s+(\S+)/g;

/**
 * Collect PHPDoc @param type bindings from comment nodes preceding a method/function.
 * Returns a map of paramName → typeName (without $ prefix).
 */
const collectPhpDocParams = (methodNode: SyntaxNode): Map<string, string> => {
  const commentTexts: string[] = [];
  let sibling = methodNode.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      commentTexts.unshift(sibling.text);
    } else if (sibling.isNamed && !SKIP_NODE_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  if (commentTexts.length === 0) return new Map();

  const params = new Map<string, string>();
  const commentBlock = commentTexts.join('\n');
  PHPDOC_PARAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHPDOC_PARAM_RE.exec(commentBlock)) !== null) {
    const typeName = normalizePhpType(match[1]);
    const paramName = match[2]; // without $ prefix
    if (typeName) {
      // Store with $ prefix to match how PHP variables appear in the env
      params.set('$' + paramName, typeName);
    }
  }

  // Also check alternate PHPDoc order: @param $name Type
  PHPDOC_PARAM_ALT_RE.lastIndex = 0;
  while ((match = PHPDOC_PARAM_ALT_RE.exec(commentBlock)) !== null) {
    const paramName = match[1];
    if (params.has('$' + paramName)) continue; // standard format takes priority
    const typeName = normalizePhpType(match[2]);
    if (typeName) {
      params.set('$' + paramName, typeName);
    }
  }
  return params;
};

/**
 * PHP: typed class properties (PHP 7.4+): private UserRepo $repo;
 * Also: PHPDoc @param annotations on method/function definitions.
 */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // PHPDoc @param on methods/functions — pre-populate env with param types
  if (node.type === 'method_declaration' || node.type === 'function_definition') {
    const phpDocParams = collectPhpDocParams(node);
    for (const [paramName, typeName] of phpDocParams) {
      if (!env.has(paramName)) env.set(paramName, typeName);
    }
    return;
  }

  if (node.type !== 'property_declaration') return;

  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;

  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName) return;

  // The variable name is inside property_element > variable_name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'property_element') {
      const varNameNode = child.firstNamedChild; // variable_name
      if (varNameNode) {
        const varName = extractVarName(varNameNode);
        if (varName) env.set(varName, typeName);
      }
      break;
    }
  }
};

/** PHP: $x = new User() — infer type from object_creation_expression */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ClassNameLookup): void => {
  if (node.type !== 'assignment_expression') return;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  if (right.type !== 'object_creation_expression') return;
  // The class name is the first named child of object_creation_expression
  // (tree-sitter-php uses 'name' or 'qualified_name' nodes here)
  const ctorType = right.firstNamedChild;
  if (!ctorType) return;
  const typeName = extractSimpleTypeName(ctorType);
  if (!typeName) return;
  // Resolve PHP self/static/parent to actual class names
  const resolvedType = (typeName === 'self' || typeName === 'static' || typeName === 'parent')
    ? resolvePhpKeyword(typeName, node)
    : typeName;
  if (!resolvedType) return;
  const varName = extractVarName(left);
  if (varName) env.set(varName, resolvedType);
};

/** PHP: simple_parameter → type $name */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'simple_parameter') {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** PHP: $x = SomeFactory() or $x = $this->getUser() — bind variable to call return type */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'assignment_expression') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'variable_name') return undefined;
  // Skip object_creation_expression (new User()) — handled by extractInitializer
  if (right.type === 'object_creation_expression') return undefined;
  // Handle both standalone function calls and method calls ($this->getUser())
  if (right.type === 'function_call_expression') {
    const calleeName = extractCalleeName(right);
    if (!calleeName) return undefined;
    return { varName: left.text, calleeName };
  }
  if (right.type === 'member_call_expression') {
    const methodName = right.childForFieldName('name');
    if (!methodName) return undefined;
    // When receiver is $this/self/static, qualify with enclosing class for disambiguation
    const receiver = right.childForFieldName('object');
    const receiverText = receiver?.text;
    let receiverClassName: string | undefined;
    if (receiverText === '$this' || receiverText === 'self' || receiverText === 'static') {
      const cls = findEnclosingClass(node);
      const clsName = cls?.childForFieldName('name');
      if (clsName) receiverClassName = clsName.text;
    }
    return { varName: left.text, calleeName: methodName.text, receiverClassName };
  }
  return undefined;
};

/** Regex to extract PHPDoc @return annotations: `@return User` */
const PHPDOC_RETURN_RE = /@return\s+(\S+)/;

/**
 * Extract return type from PHPDoc `@return Type` annotation preceding a method.
 * Walks backwards through preceding siblings looking for comment nodes.
 */
const extractReturnType: ReturnTypeExtractor = (node) => {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = PHPDOC_RETURN_RE.exec(sibling.text);
      if (match) return normalizePhpType(match[1]);
    } else if (sibling.isNamed && !SKIP_NODE_TYPES.has(sibling.type)) break;
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
