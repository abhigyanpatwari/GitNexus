import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ClassNameLookup,
  ConstructorBindingScanner,
  ReturnTypeExtractor,
  PendingAssignmentExtractor,
  ForLoopExtractor,
} from './types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  extractCalleeName,
  resolveIterableElementType,
  extractElementTypeFromString,
} from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment_expression', // For constructor inference: $x = new User()
  'property_declaration', // PHP 7.4+ typed properties: private UserRepo $repo;
  'method_declaration', // PHPDoc @param on class methods
  'function_definition', // PHPDoc @param on top-level functions
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
  const parts = type
    .split('|')
    .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed');
  if (parts.length !== 1) return undefined;
  type = parts[0];
  // Strip namespace: \App\Models\User → User
  const segments = type.split('\\');
  type = segments[segments.length - 1];
  // Skip uninformative types
  if (
    type === 'mixed' ||
    type === 'void' ||
    type === 'self' ||
    type === 'static' ||
    type === 'object'
  )
    return undefined;
  // Extract element type from generic: Collection<User> → User
  // PHPDoc generics encode the element type in angle brackets. Since PHP's Strategy B
  // uses the scopeEnv value directly as the element type, we must store the inner type,
  // not the container name. This mirrors how User[] → User is handled by the [] strip above.
  const genericMatch = type.match(/^(\w+)\s*</);
  if (genericMatch) {
    const elementType = extractElementTypeFromString(type);
    return elementType ?? undefined;
  }
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
/** Regex to extract PHPDoc @var annotations: `@var Type` */
const PHPDOC_VAR_RE = /@var\s+(\S+)/;

/**
 * Extract the element type for a class property from its PHPDoc @var annotation or
 * PHP 7.4+ native type. Walks backward from the property_declaration node to find
 * an immediately preceding comment containing @var.
 *
 * Returns the normalized element type (e.g. User[] → User, Collection<User> → User).
 * Returns undefined when no usable type annotation is found.
 */
const extractClassPropertyElementType = (propDecl: SyntaxNode): string | undefined => {
  // Strategy 1: PHPDoc @var annotation on a preceding comment sibling
  let sibling = propDecl.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = PHPDOC_VAR_RE.exec(sibling.text);
      if (match) return normalizePhpType(match[1]);
    } else if (sibling.isNamed && !SKIP_NODE_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  // Strategy 2: PHP 7.4+ native type field — skip generic 'array' since element type is unknown
  const typeNode = propDecl.childForFieldName('type');
  if (!typeNode) return undefined;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'array') return undefined;
  return typeName;
};

/**
 * Scan a class body for a property_declaration matching the given property name,
 * and extract its element type. The class body is the `declaration_list` child of
 * a `class_declaration` node.
 *
 * Used as Strategy C in extractForLoopBinding for `$this->property` iterables
 * where Strategy A (resolveIterableElementType) and Strategy B (scopeEnv lookup)
 * both fail to find the type.
 */
const findClassPropertyElementType = (
  propName: string,
  classNode: SyntaxNode,
): string | undefined => {
  const declList =
    classNode.childForFieldName('body') ??
    (classNode.namedChild(classNode.namedChildCount - 1)?.type === 'declaration_list'
      ? classNode.namedChild(classNode.namedChildCount - 1)
      : null); // fallback: last named child, only if it's a declaration_list
  if (!declList) return undefined;
  for (let i = 0; i < declList.namedChildCount; i++) {
    const child = declList.namedChild(i);
    if (child?.type !== 'property_declaration') continue;
    // Check if any property_element has a variable_name matching '$propName'
    for (let j = 0; j < child.namedChildCount; j++) {
      const elem = child.namedChild(j);
      if (elem?.type !== 'property_element') continue;
      const varNameNode = elem.firstNamedChild; // variable_name node
      if (varNameNode?.text === '$' + propName) {
        return extractClassPropertyElementType(child);
      }
    }
  }
  return undefined;
};

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
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
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
const extractInitializer: InitializerExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
  _classNames: ClassNameLookup,
): void => {
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
  const resolvedType =
    typeName === 'self' || typeName === 'static' || typeName === 'parent'
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
  if (!varName) return;
  // Don't overwrite PHPDoc-derived types (e.g. @param User[] $users → User)
  // with the less-specific AST type annotation (e.g. array).
  if (env.has(varName)) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (typeName) env.set(varName, typeName);
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
 * Normalize a PHPDoc return type for storage in the SymbolTable.
 * Unlike normalizePhpType (which strips User[] → User for scopeEnv), this preserves
 * array notation so lookupRawReturnType can extract element types for for-loop resolution.
 *   \App\Models\User[] → User[]
 *   ?User → User
 *   Collection<User> → Collection<User>  (preserved for extractElementTypeFromString)
 */
const normalizePhpReturnType = (raw: string): string | undefined => {
  // Strip nullable prefix: ?User[] → User[]
  let type = raw.startsWith('?') ? raw.slice(1) : raw;
  // Strip union with null/false/void: User[]|null → User[]
  const parts = type
    .split('|')
    .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed');
  if (parts.length !== 1) return undefined;
  type = parts[0];
  // Strip namespace: \App\Models\User[] → User[]
  const segments = type.split('\\');
  type = segments[segments.length - 1];
  // Skip uninformative types
  if (
    type === 'mixed' ||
    type === 'void' ||
    type === 'self' ||
    type === 'static' ||
    type === 'object' ||
    type === 'array'
  )
    return undefined;
  if (/^\w+(\[\])?$/.test(type) || /^\w+\s*</.test(type)) return type;
  return undefined;
};

/**
 * Extract return type from PHPDoc `@return Type` annotation preceding a method.
 * Walks backwards through preceding siblings looking for comment nodes.
 * Preserves array notation (e.g., User[]) for for-loop element type extraction.
 */
const extractReturnType: ReturnTypeExtractor = (node) => {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = PHPDOC_RETURN_RE.exec(sibling.text);
      if (match) return normalizePhpReturnType(match[1]);
    } else if (sibling.isNamed && !SKIP_NODE_TYPES.has(sibling.type)) break;
    sibling = sibling.previousSibling;
  }
  return undefined;
};

/** PHP: $alias = $user → assignment_expression with variable_name left/right.
 *  PHP TypeEnv stores variables WITH $ prefix ($user → User), so we keep $ in lhs/rhs. */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'assignment_expression') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'variable_name') return undefined;
  const lhs = left.text;
  if (!lhs || scopeEnv.has(lhs)) return undefined;
  if (right.type === 'variable_name') {
    const rhs = right.text;
    if (rhs) return { kind: 'copy', lhs, rhs };
  }
  // member_access_expression RHS → fieldAccess ($a->field)
  if (right.type === 'member_access_expression') {
    const obj = right.childForFieldName('object');
    const name = right.childForFieldName('name');
    if (obj?.type === 'variable_name' && name) {
      return { kind: 'fieldAccess', lhs, receiver: obj.text, field: name.text };
    }
  }
  // function_call_expression RHS → callResult (bare function calls only)
  if (right.type === 'function_call_expression') {
    const funcNode = right.childForFieldName('function');
    if (funcNode?.type === 'name') {
      return { kind: 'callResult', lhs, callee: funcNode.text };
    }
  }
  // member_call_expression RHS → methodCallResult ($a->method())
  if (right.type === 'member_call_expression') {
    const obj = right.childForFieldName('object');
    const name = right.childForFieldName('name');
    if (obj?.type === 'variable_name' && name) {
      return { kind: 'methodCallResult', lhs, receiver: obj.text, method: name.text };
    }
  }
  return undefined;
};

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['foreach_statement']);

/** Extract element type from a PHP type annotation AST node.
 *  PHP has limited AST-level container types — `array` is a primitive_type with no generic args.
 *  Named types (e.g., `Collection`) are returned as-is (container descriptor lookup handles them). */
const extractPhpElementTypeFromTypeNode = (_typeNode: SyntaxNode): string | undefined => {
  // PHP AST type nodes don't carry generic parameters (array<User> is PHPDoc-only).
  // primitive_type 'array' and named_type 'Collection' don't encode element types.
  return undefined;
};

/** Walk up from a foreach to the enclosing function and search parameter type annotations.
 *  PHP parameter type hints are limited (array, ClassName) — this extracts element type when possible. */
const findPhpParamElementType = (
  iterableName: string,
  startNode: SyntaxNode,
): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (current.type === 'method_declaration' || current.type === 'function_definition') {
      const paramsNode = current.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param || param.type !== 'simple_parameter') continue;
          const nameNode = param.childForFieldName('name');
          if (nameNode?.text !== iterableName) continue;
          const typeNode = param.childForFieldName('type');
          if (typeNode) return extractPhpElementTypeFromTypeNode(typeNode);
        }
      }
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * PHP: foreach ($users as $user) — extract loop variable binding.
 *
 * AST structure (from tree-sitter-php grammar):
 *   foreach_statement — no named fields for iterable/value (only 'body')
 *     children[0]: expression (iterable, e.g. $users)
 *     children[1]: expression (simple value) OR pair ($key => $value)
 *       pair children: expression (key), expression (value)
 *
 * PHP's PHPDoc @param normalizes `User[]` → `User` in the env, so the iterable's
 * stored type IS the element type. We first try resolveIterableElementType (for
 * constructor-binding cases that retain container types), then fall back to direct
 * scopeEnv lookup (for PHPDoc-normalized types).
 */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
  if (node.type !== 'foreach_statement') return;

  // Collect non-body named children: first is the iterable, second is value or pair
  const children: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child !== node.childForFieldName('body')) {
      children.push(child);
    }
  }
  if (children.length < 2) return;

  const iterableNode = children[0];
  const valueOrPair = children[1];

  // Determine the loop variable node
  let loopVarNode: SyntaxNode;
  if (valueOrPair.type === 'pair') {
    // $key => $value — the value is the last named child of the pair
    const lastChild = valueOrPair.namedChild(valueOrPair.namedChildCount - 1);
    if (!lastChild) return;
    // Handle by_ref: foreach ($arr as $k => &$v)
    loopVarNode =
      lastChild.type === 'by_ref' ? (lastChild.firstNamedChild ?? lastChild) : lastChild;
  } else {
    // Simple: foreach ($users as $user) or foreach ($users as &$user)
    loopVarNode =
      valueOrPair.type === 'by_ref' ? (valueOrPair.firstNamedChild ?? valueOrPair) : valueOrPair;
  }

  const varName = extractVarName(loopVarNode);
  if (!varName) return;

  // Get iterable variable name (PHP vars include $ prefix)
  let iterableName: string | undefined;
  let callExprElementType: string | undefined;
  if (iterableNode.type === 'variable_name') {
    iterableName = iterableNode.text;
  } else if (iterableNode?.type === 'member_access_expression') {
    const name = iterableNode.childForFieldName('name');
    // PHP properties are stored in scopeEnv with $ prefix ($users), but
    // member_access_expression.name returns without $ (users). Add $ to match.
    if (name) iterableName = '$' + name.text;
  } else if (iterableNode?.type === 'function_call_expression') {
    // foreach (getUsers() as $user) — resolve via return type lookup
    const calleeName = extractCalleeName(iterableNode);
    if (calleeName) {
      const rawReturn = returnTypeLookup.lookupRawReturnType(calleeName);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  } else if (iterableNode?.type === 'member_call_expression') {
    // foreach ($this->getUsers() as $user) — resolve via return type lookup
    const methodName = iterableNode.childForFieldName('name');
    if (methodName) {
      const rawReturn = returnTypeLookup.lookupRawReturnType(methodName.text);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  }
  if (!iterableName && !callExprElementType) return;

  // If we resolved the element type from a call expression, bind and return early
  if (callExprElementType) {
    scopeEnv.set(varName, callExprElementType);
    return;
  }

  // Strategy A: try resolveIterableElementType (handles constructor-binding container types)
  const elementType = resolveIterableElementType(
    iterableName,
    node,
    scopeEnv,
    declarationTypeNodes,
    scope,
    extractPhpElementTypeFromTypeNode,
    findPhpParamElementType,
    undefined,
  );
  if (elementType) {
    scopeEnv.set(varName, elementType);
    return;
  }

  // Strategy B: direct scopeEnv lookup — PHP normalizePhpType strips User[] → User,
  // so the iterable's stored type is already the element type from PHPDoc annotations.
  const iterableType = scopeEnv.get(iterableName);
  if (iterableType) {
    scopeEnv.set(varName, iterableType);
    return;
  }

  // Strategy C: $this->property — scan the enclosing class body for the property
  // declaration and extract its element type from @var PHPDoc or native type.
  // This handles the common PHP pattern where the property type is declared on the
  // class body (/** @var User[] */ private $users) but the foreach is in a method
  // whose scopeEnv does not contain the property type.
  if (iterableNode?.type === 'member_access_expression') {
    const obj = iterableNode.childForFieldName('object');
    if (obj?.text === '$this') {
      const nameNode = iterableNode.childForFieldName('name');
      const propName = nameNode?.text;
      if (propName) {
        const classNode = findEnclosingClass(iterableNode);
        if (classNode) {
          const elementType = findClassPropertyElementType(propName, classNode);
          if (elementType) scopeEnv.set(varName, elementType);
        }
      }
    }
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractReturnType,
  extractForLoopBinding,
  extractPendingAssignment,
};
