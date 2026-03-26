import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner, PendingAssignmentExtractor, ForLoopExtractor, LiteralTypeInferrer, ConstructorTypeDetector, DeclaredTypeUnwrapper } from './types.js';
import { extractSimpleTypeName, extractVarName, resolveIterableElementType, methodToTypeArgPosition, type TypeArgPosition } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'declaration',
]);

/** Smart pointer factory function names that create a typed object. */
const SMART_PTR_FACTORIES = new Set([
  'make_shared', 'make_unique', 'make_shared_for_overwrite',
]);

/** Smart pointer wrapper type names. When the declared type is a smart pointer,
 *  the inner template type is extracted for virtual dispatch comparison. */
const SMART_PTR_WRAPPERS = new Set(['shared_ptr', 'unique_ptr', 'weak_ptr']);

/** Extract the first type name from a template_argument_list child.
 *  Unwraps type_descriptor wrappers common in tree-sitter-cpp ASTs.
 *  Returns undefined if no template arguments or no type found. */
export const extractFirstTemplateTypeArg = (parentNode: SyntaxNode): string | undefined => {
  const templateArgs = parentNode.children.find((c: any) => c.type === 'template_argument_list');
  if (!templateArgs?.firstNamedChild) return undefined;
  let argNode: any = templateArgs.firstNamedChild;
  if (argNode.type === 'type_descriptor') {
    const inner = argNode.childForFieldName('type');
    if (inner) argNode = inner;
  }
  return extractSimpleTypeName(argNode) ?? undefined;
};

/** C++: Type x = ...; Type* x; Type& x; */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName) return;

  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;

  // init_declarator: Type x = value
  const nameNode = declarator.type === 'init_declarator'
    ? declarator.childForFieldName('declarator')
    : declarator;
  if (!nameNode) return;

  // Handle pointer/reference declarators
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild
    : nameNode;
  if (!finalName) return;

  const varName = extractVarName(finalName);
  if (varName) env.set(varName, typeName);
};

/** C++: auto x = new User(); auto x = User(); */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;

  // Only handle auto/placeholder — typed declarations are handled by extractDeclaration
  const typeText = typeNode.text;
  if (
    typeText !== 'auto' &&
    typeText !== 'decltype(auto)' &&
    typeNode.type !== 'placeholder_type_specifier'
  ) return;

  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;

  // Must be an init_declarator (i.e., has an initializer value)
  if (declarator.type !== 'init_declarator') return;

  const value = declarator.childForFieldName('value');
  if (!value) return;

  // Resolve the variable name, unwrapping pointer/reference declarators
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return;
  const finalName =
    nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
      ? nameNode.firstNamedChild
      : nameNode;
  if (!finalName) return;
  const varName = extractVarName(finalName);
  if (!varName) return;

  // auto x = new User() — new_expression
  if (value.type === 'new_expression') {
    const ctorType = value.childForFieldName('type');
    if (ctorType) {
      const typeName = extractSimpleTypeName(ctorType);
      if (typeName) env.set(varName, typeName);
    }
    return;
  }

  // auto x = User() — call_expression where function is a type name
  // tree-sitter-cpp may parse the constructor name as type_identifier or identifier.
  // For plain identifiers, verify against known class names from the file's AST
  // to distinguish constructor calls (User()) from function calls (getUser()).
  if (value.type === 'call_expression') {
    const func = value.childForFieldName('function');
    if (!func) return;
    if (func.type === 'type_identifier') {
      const typeName = func.text;
      if (typeName) env.set(varName, typeName);
    } else if (func.type === 'identifier') {
      const text = func.text;
      if (text && classNames.has(text)) env.set(varName, text);
    } else {
      // auto x = std::make_shared<Dog>() — smart pointer factory via template_function.
      // AST: call_expression > function: qualified_identifier > template_function
      //   or: call_expression > function: template_function (unqualified)
      const templateFunc = func.type === 'template_function'
        ? func
        : (func.type === 'qualified_identifier' || func.type === 'scoped_identifier')
          ? func.namedChildren.find((c: any) => c.type === 'template_function') ?? null
          : null;
      if (templateFunc) {
        const nameNode = templateFunc.firstNamedChild;
        if (nameNode) {
          const funcName = (nameNode.type === 'qualified_identifier' || nameNode.type === 'scoped_identifier')
            ? nameNode.lastNamedChild?.text ?? ''
            : nameNode.text;
          if (SMART_PTR_FACTORIES.has(funcName)) {
            const typeName = extractFirstTemplateTypeArg(templateFunc);
            if (typeName) env.set(varName, typeName);
          }
        }
      }
    }
    return;
  }

  // auto x = User{} — compound_literal_expression (brace initialization)
  // AST: compound_literal_expression > type_identifier + initializer_list
  if (value.type === 'compound_literal_expression') {
    const typeId = value.firstNamedChild;
    const typeName = typeId ? extractSimpleTypeName(typeId) : undefined;
    if (typeName) env.set(varName, typeName);
  }
};

/** C/C++: parameter_declaration → type declarator */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter_declaration') {
    typeNode = node.childForFieldName('type');
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      nameNode = declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator'
        ? declarator.firstNamedChild
        : declarator;
    }
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** C/C++: auto x = User() where function is an identifier (not type_identifier) */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  const typeText = typeNode.text;
  if (typeText !== 'auto' && typeText !== 'decltype(auto)' && typeNode.type !== 'placeholder_type_specifier') return undefined;
  const declarator = node.childForFieldName('declarator');
  if (!declarator || declarator.type !== 'init_declarator') return undefined;
  const value = declarator.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  if (!func) return undefined;
  if (func.type === 'qualified_identifier' || func.type === 'scoped_identifier') {
    const last = func.lastNamedChild;
    if (!last) return undefined;
    const nameNode = declarator.childForFieldName('declarator');
    if (!nameNode) return undefined;
    const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
      ? nameNode.firstNamedChild : nameNode;
    if (!finalName) return undefined;
    return { varName: finalName.text, calleeName: last.text };
  }
  if (func.type !== 'identifier') return undefined;
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return undefined;
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild : nameNode;
  if (!finalName) return undefined;
  const varName = finalName.text;
  if (!varName) return undefined;
  return { varName, calleeName: func.text };
};

/** C++: auto alias = user → declaration with auto type + init_declarator where value is identifier */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  // Only handle auto — typed declarations already resolved by extractDeclaration
  const typeText = typeNode.text;
  if (typeText !== 'auto' && typeText !== 'decltype(auto)'
    && typeNode.type !== 'placeholder_type_specifier') return undefined;
  const declarator = node.childForFieldName('declarator');
  if (!declarator || declarator.type !== 'init_declarator') return undefined;
  const value = declarator.childForFieldName('value');
  if (!value) return undefined;
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return undefined;
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild : nameNode;
  if (!finalName) return undefined;
  const lhs = extractVarName(finalName);
  if (!lhs || scopeEnv.has(lhs)) return undefined;
  if (value.type === 'identifier') return { kind: 'copy', lhs, rhs: value.text };
  // field_expression RHS → fieldAccess (a.field)
  if (value.type === 'field_expression') {
    const obj = value.firstNamedChild;
    const field = value.lastNamedChild;
    if (obj?.type === 'identifier' && field?.type === 'field_identifier') {
      return { kind: 'fieldAccess', lhs, receiver: obj.text, field: field.text };
    }
  }
  // call_expression RHS
  if (value.type === 'call_expression') {
    const funcNode = value.childForFieldName('function');
    if (funcNode?.type === 'identifier') {
      return { kind: 'callResult', lhs, callee: funcNode.text };
    }
    // method call with receiver: call_expression → function: field_expression
    if (funcNode?.type === 'field_expression') {
      const obj = funcNode.firstNamedChild;
      const field = funcNode.lastNamedChild;
      if (obj?.type === 'identifier' && field?.type === 'field_identifier') {
        return { kind: 'methodCallResult', lhs, receiver: obj.text, method: field.text };
      }
    }
  }
  return undefined;
};

// --- For-loop Tier 1c ---

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['for_range_loop']);

/** Extract template type arguments from a C++ template_type node.
 *  C++ template_type uses template_argument_list (not type_arguments), and each
 *  argument is a type_descriptor with a 'type' field containing the type_specifier. */
const extractCppTemplateTypeArgs = (templateTypeNode: SyntaxNode): string[] => {
  const argsNode = templateTypeNode.childForFieldName('arguments');
  if (!argsNode || argsNode.type !== 'template_argument_list') return [];
  const result: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    let argNode = argsNode.namedChild(i);
    if (!argNode) continue;
    // type_descriptor wraps the actual type specifier in a 'type' field
    if (argNode.type === 'type_descriptor') {
      const inner = argNode.childForFieldName('type');
      if (inner) argNode = inner;
    }
    const name = extractSimpleTypeName(argNode);
    if (name) result.push(name);
  }
  return result;
};

/** Extract element type from a C++ type annotation AST node.
 *  Handles: template_type (vector<User>, map<string, User>),
 *  pointer/reference types (User*, User&). */
const extractCppElementTypeFromTypeNode = (typeNode: SyntaxNode, pos: TypeArgPosition = 'last', depth = 0): string | undefined => {
  if (depth > 50) return undefined;
  // template_type: vector<User>, map<string, User> — extract type arg based on position
  if (typeNode.type === 'template_type') {
    const args = extractCppTemplateTypeArgs(typeNode);
    if (args.length >= 1) return pos === 'first' ? args[0] : args[args.length - 1];
  }
  // reference/pointer types: unwrap and recurse (vector<User>& → vector<User>)
  if (typeNode.type === 'reference_type' || typeNode.type === 'pointer_type'
    || typeNode.type === 'type_descriptor') {
    const inner = typeNode.lastNamedChild;
    if (inner) return extractCppElementTypeFromTypeNode(inner, pos, depth + 1);
  }
  // qualified/scoped types: std::vector<User> → unwrap to template_type child
  if (typeNode.type === 'qualified_identifier' || typeNode.type === 'scoped_type_identifier') {
    const inner = typeNode.lastNamedChild;
    if (inner) return extractCppElementTypeFromTypeNode(inner, pos, depth + 1);
  }
  return undefined;
};

/** Walk up from a for-range-loop to the enclosing function_definition and search parameters
 *  for one named `iterableName`. Returns the element type from its annotation. */
const findCppParamElementType = (iterableName: string, startNode: SyntaxNode, pos: TypeArgPosition = 'last'): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (current.type === 'function_definition') {
      const declarator = current.childForFieldName('declarator');
      // function_definition > declarator (function_declarator) > parameters (parameter_list)
      const paramsNode = declarator?.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param || param.type !== 'parameter_declaration') continue;
          const paramDeclarator = param.childForFieldName('declarator');
          if (!paramDeclarator) continue;
          // Unwrap reference/pointer declarators: vector<User>& users → &users
          let identNode = paramDeclarator;
          if (identNode.type === 'reference_declarator' || identNode.type === 'pointer_declarator') {
            identNode = identNode.firstNamedChild ?? identNode;
          }
          if (identNode.text !== iterableName) continue;
          const typeNode = param.childForFieldName('type');
          if (typeNode) return extractCppElementTypeFromTypeNode(typeNode, pos);
        }
      }
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/** C++: for (auto& user : users) — extract loop variable binding.
 *  Handles explicit types (for (User& user : users)) and auto (for (auto& user : users)).
 *  For auto, resolves element type from the iterable's container type. */
const extractForLoopBinding: ForLoopExtractor = (node, { scopeEnv, declarationTypeNodes, scope } ): void => {
  if (node.type !== 'for_range_loop') return;

  const typeNode = node.childForFieldName('type');
  const declaratorNode = node.childForFieldName('declarator');
  const rightNode = node.childForFieldName('right');
  if (!typeNode || !declaratorNode || !rightNode) return;

  // Unwrap reference/pointer declarator to get the loop variable name
  let nameNode = declaratorNode;
  if (nameNode.type === 'reference_declarator' || nameNode.type === 'pointer_declarator') {
    nameNode = nameNode.firstNamedChild ?? nameNode;
  }

  // Handle structured bindings: auto& [key, value] or auto [key, value]
  // Bind the last identifier (value heuristic for [key, value] patterns)
  let loopVarName: string | undefined;
  if (nameNode.type === 'structured_binding_declarator') {
    const lastChild = nameNode.lastNamedChild;
    if (lastChild?.type === 'identifier') {
      loopVarName = lastChild.text;
    }
  } else if (declaratorNode.type === 'structured_binding_declarator') {
    const lastChild = declaratorNode.lastNamedChild;
    if (lastChild?.type === 'identifier') {
      loopVarName = lastChild.text;
    }
  }

  const varName = loopVarName ?? extractVarName(nameNode);
  if (!varName) return;

  // Check if the type is auto/placeholder — if not, use the explicit type directly
  const isAuto = typeNode.type === 'placeholder_type_specifier'
    || typeNode.text === 'auto'
    || typeNode.text === 'const auto'
    || typeNode.text === 'decltype(auto)';

  if (!isAuto) {
    // Explicit type: for (User& user : users) — extract directly
    const typeName = extractSimpleTypeName(typeNode);
    if (typeName) scopeEnv.set(varName, typeName);
    return;
  }

  // auto/const auto/auto& — resolve from the iterable's container type
  // Extract iterable name + optional method
  let iterableName: string | undefined;
  let methodName: string | undefined;
  if (rightNode.type === 'identifier') {
    iterableName = rightNode.text;
  } else if (rightNode.type === 'field_expression') {
    const prop = rightNode.lastNamedChild;
    if (prop) iterableName = prop.text;
  } else if (rightNode.type === 'call_expression') {
    // users.begin() is NOT used in range-for, but container.items() etc. might be
    const fieldExpr = rightNode.childForFieldName('function');
    if (fieldExpr?.type === 'field_expression') {
      const obj = fieldExpr.firstNamedChild;
      if (obj?.type === 'identifier') iterableName = obj.text;
      const field = fieldExpr.lastNamedChild;
      if (field?.type === 'field_identifier') methodName = field.text;
    }
  } else if (rightNode.type === 'pointer_expression') {
    // Dereference: for (auto& user : *ptr) → pointer_expression > identifier
    // Only handles simple *identifier; *this->field and **ptr are not resolved.
    const operand = rightNode.lastNamedChild;
    if (operand?.type === 'identifier') iterableName = operand.text;
  }
  if (!iterableName) return;

  const containerTypeName = scopeEnv.get(iterableName);
  const typeArgPos = methodToTypeArgPosition(methodName, containerTypeName);
  const elementType = resolveIterableElementType(
    iterableName, node, scopeEnv, declarationTypeNodes, scope,
    extractCppElementTypeFromTypeNode, findCppParamElementType,
    typeArgPos,
  );
  if (elementType) scopeEnv.set(varName, elementType);
};

/** Infer the type of a literal AST node for C++ overload disambiguation. */
const inferLiteralType: LiteralTypeInferrer = (node) => {
  switch (node.type) {
    case 'number_literal': {
      const t = node.text;
      // Float suffixes
      if (t.endsWith('f') || t.endsWith('F')) return 'float';
      if (t.includes('.') || t.includes('e') || t.includes('E')) return 'double';
      // Long suffix
      if (t.endsWith('L') || t.endsWith('l') || t.endsWith('LL') || t.endsWith('ll')) return 'long';
      return 'int';
    }
    case 'string_literal':
    case 'raw_string_literal':
    case 'concatenated_string':
      return 'string';
    case 'char_literal':
      return 'char';
    case 'true':
    case 'false':
      return 'bool';
    case 'null':
    case 'nullptr':
      return 'null';
    default:
      return undefined;
  }
};

/** C++: detect constructor type from smart pointer factory calls (make_shared<Dog>()).
 *  Extracts the template type argument as the constructor type for virtual dispatch. */
const detectCppConstructorType: ConstructorTypeDetector = (node, classNames) => {
  // Navigate to the initializer value in the declaration
  const declarator = node.childForFieldName('declarator');
  const initDecl = declarator?.type === 'init_declarator' ? declarator : undefined;
  if (!initDecl) return undefined;
  const value = initDecl.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;

  // Check for template_function pattern: make_shared<Dog>()
  const func = value.childForFieldName('function');
  if (!func || func.type !== 'template_function') return undefined;

  // Extract function name (possibly qualified: std::make_shared)
  const nameNode = func.firstNamedChild;
  if (!nameNode) return undefined;
  let funcName: string;
  if (nameNode.type === 'qualified_identifier' || nameNode.type === 'scoped_identifier') {
    funcName = nameNode.lastNamedChild?.text ?? '';
  } else {
    funcName = nameNode.text;
  }
  if (!SMART_PTR_FACTORIES.has(funcName)) return undefined;

  // Extract template type argument
  return extractFirstTemplateTypeArg(func);
};

/** Unwrap a C++ smart pointer declared type to its inner template type.
 *  E.g., shared_ptr<Animal> → Animal. Returns the original name if not a smart pointer. */
const unwrapCppDeclaredType: DeclaredTypeUnwrapper = (declaredType, typeNode) => {
  if (!SMART_PTR_WRAPPERS.has(declaredType)) return declaredType;
  if (typeNode.type !== 'template_type') return declaredType;
  return extractFirstTemplateTypeArg(typeNode) ?? declaredType;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
  inferLiteralType,
  detectConstructorType: detectCppConstructorType,
  unwrapDeclaredType: unwrapCppDeclaredType,
};
