import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner, ReturnTypeExtractor, PendingAssignmentExtractor, PendingAssignment, ForLoopExtractor, PatternBindingExtractor, LiteralTypeInferrer } from './types.js';
import { extractSimpleTypeName, extractVarName, hasTypeAnnotation, unwrapAwait, extractCalleeName, extractElementTypeFromString, extractGenericTypeArgs, resolveIterableElementType, methodToTypeArgPosition, type TypeArgPosition } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'lexical_declaration',
  'variable_declaration',
  'function_declaration',   // JSDoc @param on function declarations
  'method_definition',      // JSDoc @param on class methods
  'public_field_definition', // class field: private users: User[]
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

  // Class field: `private users: User[]` — public_field_definition has name + type fields directly.
  if (node.type === 'public_field_definition') {
    const nameNode = node.childForFieldName('name');
    const typeAnnotation = node.childForFieldName('type');
    if (!nameNode || !typeAnnotation) return;
    const varName = nameNode.text;
    if (!varName) return;
    const typeName = extractSimpleTypeName(typeAnnotation);
    if (typeName) env.set(varName, typeName);
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

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_in_statement',
]);

/** TS function/method node types that carry a parameters list. */
const TS_FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
]);

/**
 * Extract element type from a TypeScript type annotation AST node.
 * Handles:
 *   type_annotation ": User[]"  →  array_type → type_identifier "User"
 *   type_annotation ": Array<User>"  →  generic_type → extractGenericTypeArgs → "User"
 * Falls back to text-based extraction via extractElementTypeFromString.
 */
const extractTsElementTypeFromAnnotation = (typeAnnotation: SyntaxNode, pos: TypeArgPosition = 'last', depth = 0): string | undefined => {
  if (depth > 50) return undefined;
  // Unwrap type_annotation (the node text includes ': ' prefix)
  const inner = typeAnnotation.type === 'type_annotation'
    ? (typeAnnotation.firstNamedChild ?? typeAnnotation)
    : typeAnnotation;

  // readonly User[] — readonly_type wraps array_type: unwrap and recurse
  if (inner.type === 'readonly_type') {
    const wrapped = inner.firstNamedChild;
    if (wrapped) return extractTsElementTypeFromAnnotation(wrapped, pos, depth + 1);
  }

  // User[] — array_type: first named child is the element type
  if (inner.type === 'array_type') {
    const elem = inner.firstNamedChild;
    if (elem) return extractSimpleTypeName(elem);
  }

  // Array<User>, Map<string, User> — generic_type
  // pos determines which type arg: 'first' for keys, 'last' for values
  if (inner.type === 'generic_type') {
    const args = extractGenericTypeArgs(inner);
    if (args.length >= 1) return pos === 'first' ? args[0] : args[args.length - 1];
  }

  // Fallback: strip ': ' prefix from type_annotation text and use string extraction
  const rawText = inner.text;
  return extractElementTypeFromString(rawText, pos);
};

/**
 * Search a statement_block (function body) for a variable_declarator named `iterableName`
 * that has a type annotation, preceding the given `beforeNode`.
 * Returns the element type from the type annotation, or undefined.
 */
const findTsLocalDeclElementType = (
  iterableName: string,
  blockNode: SyntaxNode,
  beforeNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
): string | undefined => {
  for (let i = 0; i < blockNode.namedChildCount; i++) {
    const stmt = blockNode.namedChild(i);
    if (!stmt) continue;
    // Stop when we reach the for-loop itself
    if (stmt === beforeNode || stmt.startIndex >= beforeNode.startIndex) break;
    // Look for lexical_declaration or variable_declaration
    if (stmt.type !== 'lexical_declaration' && stmt.type !== 'variable_declaration') continue;
    for (let j = 0; j < stmt.namedChildCount; j++) {
      const decl = stmt.namedChild(j);
      if (decl?.type !== 'variable_declarator') continue;
      const nameNode = decl.childForFieldName('name');
      if (nameNode?.text !== iterableName) continue;
      const typeAnnotation = decl.childForFieldName('type');
      if (typeAnnotation) return extractTsElementTypeFromAnnotation(typeAnnotation, pos);
    }
  }
  return undefined;
};

/**
 * Walk up the AST from a for-loop node to find the enclosing function scope,
 * then search (1) its parameter list and (2) local declarations in the body
 * for a variable named `iterableName` with a container type annotation.
 * Returns the element type extracted from the annotation, or undefined.
 */
const findTsIterableElementType = (iterableName: string, startNode: SyntaxNode, pos: TypeArgPosition = 'last'): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  // Capture the immediate statement_block parent to search local declarations
  const blockNode = current?.type === 'statement_block' ? current : null;

  while (current) {
    if (TS_FUNCTION_NODE_TYPES.has(current.type)) {
      // Search function parameters
      const paramsNode = current.childForFieldName('parameters')
        ?? current.childForFieldName('formal_parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param) continue;
          const patternNode = param.childForFieldName('pattern') ?? param.childForFieldName('name');
          if (patternNode?.text === iterableName) {
            const typeAnnotation = param.childForFieldName('type');
            if (typeAnnotation) return extractTsElementTypeFromAnnotation(typeAnnotation, pos);
          }
        }
      }
      // Search local declarations in the function body (statement_block)
      if (blockNode) {
        const result = findTsLocalDeclElementType(iterableName, blockNode, startNode, pos);
        if (result) return result;
      }
      break; // stop at the nearest function boundary
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * TypeScript/JavaScript: for (const user of users) where users has a known array type.
 *
 * Both `for...of` and `for...in` use the same `for_in_statement` AST node in tree-sitter.
 * We differentiate by checking for the `of` keyword among the unnamed children.
 *
 * Tier 1c: resolves the element type via three strategies in priority order:
 *   1. declarationTypeNodes — raw type annotation AST node (covers Array<User> from declarations)
 *   2. scopeEnv string — extractElementTypeFromString on the stored type (covers locally annotated vars)
 *   3. AST walk — walks up to the enclosing function's parameters to read User[] annotations directly
 * Only handles `for...of`; `for...in` produces string keys, not element types.
 */
const extractForLoopBinding: ForLoopExtractor = (node, { scopeEnv, declarationTypeNodes, scope, returnTypeLookup }): void => {
  if (node.type !== 'for_in_statement') return;

  // Confirm this is `for...of`, not `for...in`, by scanning unnamed children for the keyword text.
  let isForOf = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text === 'of') {
      isForOf = true;
      break;
    }
  }
  if (!isForOf) return;

  // The iterable is the `right` field — may be identifier, member_expression, or call_expression.
  const rightNode = node.childForFieldName('right');
  let iterableName: string | undefined;
  let methodName: string | undefined;
  let callExprElementType: string | undefined;
  if (rightNode?.type === 'identifier') {
    iterableName = rightNode.text;
  } else if (rightNode?.type === 'member_expression') {
    const prop = rightNode.childForFieldName('property');
    if (prop) iterableName = prop.text;
  } else if (rightNode?.type === 'call_expression') {
    // entries.values() → call_expression > function: member_expression > object + property
    // this.repos.values() → nested member_expression: extract property from inner member
    // getUsers() → call_expression > function: identifier (Phase 7.3 — return-type path)
    const fn = rightNode.childForFieldName('function');
    if (fn?.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (obj?.type === 'identifier') {
        iterableName = obj.text;
      } else if (obj?.type === 'member_expression') {
        // this.repos.values() → obj = this.repos → extract 'repos'
        const innerProp = obj.childForFieldName('property');
        if (innerProp) iterableName = innerProp.text;
      }
      if (prop?.type === 'property_identifier') methodName = prop.text;
    } else if (fn?.type === 'identifier') {
      // Direct function call: for (const user of getUsers())
      const rawReturn = returnTypeLookup.lookupRawReturnType(fn.text);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  }
  if (!iterableName && !callExprElementType) return;

  let elementType: string | undefined;
  if (callExprElementType) {
    elementType = callExprElementType;
  } else {
    // Look up the container's base type name for descriptor-aware resolution
    const containerTypeName = scopeEnv.get(iterableName!);
    const typeArgPos = methodToTypeArgPosition(methodName, containerTypeName);
    elementType = resolveIterableElementType(
      iterableName!, node, scopeEnv, declarationTypeNodes, scope,
      extractTsElementTypeFromAnnotation, findTsIterableElementType,
      typeArgPos,
    );
  }
  if (!elementType) return;

  // The loop variable is the `left` field.
  const leftNode = node.childForFieldName('left');
  if (!leftNode) return;

  // Handle destructured for-of: for (const [k, v] of entries)
  // AST: left = array_pattern directly (no variable_declarator wrapper)
  // Bind the LAST identifier to the element type (value in [key, value] patterns)
  if (leftNode.type === 'array_pattern') {
    const lastChild = leftNode.lastNamedChild;
    if (lastChild?.type === 'identifier') {
      scopeEnv.set(lastChild.text, elementType);
    }
    return;
  }

  if (leftNode.type === 'object_pattern') {
    // Object destructuring (e.g., `for (const { id } of users)`) destructures
    // into fields of the element type. Without field-level resolution, we cannot
    // bind individual properties to their correct types. Skip to avoid false bindings.
    return;
  }

  let loopVarNode: SyntaxNode | null = leftNode;
  // `const user` parses as: left → variable_declarator containing an identifier named `user`
  if (loopVarNode.type === 'variable_declarator') {
    loopVarNode = loopVarNode.childForFieldName('name') ?? loopVarNode.firstNamedChild;
  }
  if (!loopVarNode) return;

  const loopVarName = extractVarName(loopVarNode);
  if (loopVarName) scopeEnv.set(loopVarName, elementType);
};

/** TS/JS: const alias = u → variable_declarator with name/value fields.
 *  Also handles destructuring: `const { a, b } = obj` → N fieldAccess items. */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    if (!nameNode || !valueNode) continue;

    // Object destructuring: `const { address, name } = user`
    // Emits N fieldAccess items — one per destructured binding.
    if (nameNode.type === 'object_pattern' && valueNode.type === 'identifier') {
      const receiver = valueNode.text;
      const items: PendingAssignment[] = [];
      for (let j = 0; j < nameNode.namedChildCount; j++) {
        const prop = nameNode.namedChild(j);
        if (!prop) continue;
        if (prop.type === 'shorthand_property_identifier_pattern') {
          // `const { name } = user` → shorthand: varName = fieldName
          const varName = prop.text;
          if (!scopeEnv.has(varName)) {
            items.push({ kind: 'fieldAccess', lhs: varName, receiver, field: varName });
          }
        } else if (prop.type === 'pair_pattern') {
          // `const { address: addr } = user` → pair_pattern: key=field, value=varName
          const keyNode = prop.childForFieldName('key');
          const valNode = prop.childForFieldName('value');
          if (keyNode && valNode) {
            const fieldName = keyNode.text;
            const varName = valNode.text;
            if (!scopeEnv.has(varName)) {
              items.push({ kind: 'fieldAccess', lhs: varName, receiver, field: fieldName });
            }
          }
        }
      }
      if (items.length > 0) return items;
      continue;
    }

    const lhs = nameNode.text;
    if (scopeEnv.has(lhs)) continue;
    if (valueNode.type === 'identifier') return { kind: 'copy', lhs, rhs: valueNode.text };
    // member_expression RHS → fieldAccess (a.field, this.field)
    if (valueNode.type === 'member_expression') {
      const obj = valueNode.childForFieldName('object');
      const prop = valueNode.childForFieldName('property');
      if (obj && prop?.type === 'property_identifier' &&
          (obj.type === 'identifier' || obj.type === 'this')) {
        return { kind: 'fieldAccess', lhs, receiver: obj.text, field: prop.text };
      }
      continue;
    }
    // Unwrap await: `const user = await fetchUser()` or `await a.getC()`
    const callNode = unwrapAwait(valueNode);
    if (!callNode || callNode.type !== 'call_expression') continue;
    const funcNode = callNode.childForFieldName('function');
    if (!funcNode) continue;
    // Simple call → callResult: getUser()
    if (funcNode.type === 'identifier') {
      return { kind: 'callResult', lhs, callee: funcNode.text };
    }
    // Method call with receiver → methodCallResult: a.getC()
    if (funcNode.type === 'member_expression') {
      const obj = funcNode.childForFieldName('object');
      const prop = funcNode.childForFieldName('property');
      if (obj && prop?.type === 'property_identifier' &&
          (obj.type === 'identifier' || obj.type === 'this')) {
        return { kind: 'methodCallResult', lhs, receiver: obj.text, method: prop.text };
      }
    }
  }
  return undefined;
};

/** Null-check keywords that indicate a null-comparison in binary expressions. */
const NULL_CHECK_KEYWORDS = new Set(['null', 'undefined']);

/**
 * Find the if-body (consequence) block for a null-check binary_expression.
 * Walks up from the binary_expression through parenthesized_expression to if_statement,
 * then returns the consequence block (statement_block).
 *
 * AST structure: if_statement > parenthesized_expression > binary_expression
 *                if_statement > statement_block (consequence)
 */
const findIfConsequenceBlock = (binaryExpr: SyntaxNode): SyntaxNode | undefined => {
  // Walk up to find the if_statement (typically: binary_expression > parenthesized_expression > if_statement)
  let current = binaryExpr.parent;
  while (current) {
    if (current.type === 'if_statement') {
      // The consequence is the first statement_block child of if_statement
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === 'statement_block') return child;
      }
      return undefined;
    }
    // Stop climbing at function/block boundaries — don't cross scope
    if (current.type === 'function_declaration' || current.type === 'function_expression'
      || current.type === 'arrow_function' || current.type === 'method_definition') return undefined;
    current = current.parent;
  }
  return undefined;
};

/** TS instanceof narrowing: `x instanceof User` → bind x to User.
 *  Also handles null-check narrowing: `x !== null`, `x != undefined` etc.
 *  instanceof: first-writer-wins (no prior type binding).
 *  null-check: position-indexed narrowing via narrowingRange. */
const extractPatternBinding: PatternBindingExtractor = (node, scopeEnv, declarationTypeNodes, scope) => {
  if (node.type !== 'binary_expression') return undefined;

  // Check for instanceof first (existing behavior)
  const instanceofOp = node.children.find(c => !c.isNamed && c.text === 'instanceof');
  if (instanceofOp) {
    const left = node.namedChild(0);
    const right = node.namedChild(1);
    if (left?.type !== 'identifier' || right?.type !== 'identifier') return undefined;
    return { varName: left.text, typeName: right.text };
  }

  // Null-check narrowing: x !== null, x != null, x !== undefined, x != undefined
  const op = node.children.find(c => !c.isNamed && (c.text === '!==' || c.text === '!='));
  if (!op) return undefined;

  const left = node.namedChild(0);
  const right = node.namedChild(1);
  if (!left || !right) return undefined;

  // Determine which side is the variable and which is null/undefined
  let varNode: SyntaxNode | undefined;
  let isNullCheck = false;
  if (left.type === 'identifier' && NULL_CHECK_KEYWORDS.has(right.text)) {
    varNode = left;
    isNullCheck = true;
  } else if (right.type === 'identifier' && NULL_CHECK_KEYWORDS.has(left.text)) {
    varNode = right;
    isNullCheck = true;
  }
  if (!isNullCheck || !varNode) return undefined;

  const varName = varNode.text;
  // Look up the variable's resolved type (already stripped of nullable by extractSimpleTypeName)
  const resolvedType = scopeEnv.get(varName);
  if (!resolvedType) return undefined;

  // Check if the original declaration type was nullable by looking at the raw AST type node.
  // extractSimpleTypeName already strips nullable markers, so we need the original to know
  // if narrowing is meaningful (i.e., the variable was declared as nullable).
  const declTypeNode = declarationTypeNodes.get(`${scope}\0${varName}`);
  if (!declTypeNode) return undefined;
  const declText = declTypeNode.text;
  // Only narrow if the original declaration was nullable
  if (!declText.includes('null') && !declText.includes('undefined')) return undefined;

  // Find the if-body block to scope the narrowing
  const ifBody = findIfConsequenceBlock(node);
  if (!ifBody) return undefined;

  return {
    varName,
    typeName: resolvedType,
    narrowingRange: { startIndex: ifBody.startIndex, endIndex: ifBody.endIndex },
  };
};

/** Infer the type of a literal AST node for TypeScript overload disambiguation. */
const inferTsLiteralType: LiteralTypeInferrer = (node) => {
  switch (node.type) {
    case 'number':
      return 'number';
    case 'string':
    case 'template_string':
      return 'string';
    case 'true':
    case 'false':
      return 'boolean';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'regex':
      return 'RegExp';
    default:
      return undefined;
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  patternBindingNodeTypes: new Set(['binary_expression']),
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractReturnType,
  extractForLoopBinding,
  extractPendingAssignment,
  extractPatternBinding,
  inferLiteralType: inferTsLiteralType,
};
