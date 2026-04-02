import type Parser from 'tree-sitter';
import type { NodeLabel } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';
import { generateId } from '../../../lib/utils.js';
import { extractSimpleTypeName } from '../type-extractors/shared.js';

/** Tree-sitter AST node. Re-exported for use across ingestion modules. */
export type SyntaxNode = Parser.SyntaxNode;

/**
 * Ordered list of definition capture keys for tree-sitter query matches.
 * Used to extract the definition node from a capture map.
 */
export const DEFINITION_CAPTURE_KEYS = [
  'definition.function',
  'definition.class',
  'definition.interface',
  'definition.method',
  'definition.struct',
  'definition.enum',
  'definition.namespace',
  'definition.module',
  'definition.trait',
  'definition.impl',
  'definition.type',
  'definition.const',
  'definition.static',
  'definition.typedef',
  'definition.macro',
  'definition.union',
  'definition.property',
  'definition.record',
  'definition.delegate',
  'definition.annotation',
  'definition.constructor',
  'definition.template',
] as const;

/** Extract the definition node from a tree-sitter query capture map. */
export const getDefinitionNodeFromCaptures = (
  captureMap: Record<string, SyntaxNode>,
): SyntaxNode | null => {
  for (const key of DEFINITION_CAPTURE_KEYS) {
    if (captureMap[key]) return captureMap[key];
  }
  return null;
};

/**
 * Node types that represent function/method definitions across languages.
 * Used to find the enclosing function for a call site.
 */
export const FUNCTION_NODE_TYPES = new Set([
  // TypeScript/JavaScript
  'function_declaration',
  'arrow_function',
  'function_expression',
  'method_definition',
  'generator_function_declaration',
  // Python
  'function_definition',
  // Common async variants
  'async_function_declaration',
  'async_arrow_function',
  // Java
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'annotation_type_element_declaration',
  // C/C++
  // 'function_definition' already included above
  // Go
  // 'method_declaration' already included from Java
  // C#
  'local_function_statement',
  // Rust
  'function_item',
  'impl_item', // Methods inside impl blocks
  // PHP
  'anonymous_function',
  // Kotlin
  'lambda_literal',
  // Swift
  'init_declaration',
  'deinit_declaration',
  // Ruby
  'method', // def foo
  'singleton_method', // def self.foo
  // Dart
  'function_signature',
  'method_signature',
]);

/**
 * Node types for standard function declarations that need C/C++ declarator handling.
 * Used by extractFunctionName to determine how to extract the function name.
 */
export const FUNCTION_DECLARATION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'async_function_declaration',
  'generator_function_declaration',
  'function_item',
]);

/** AST node types that represent a class-like container (for HAS_METHOD edge extraction) */
export const CLASS_CONTAINER_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'class_specifier',
  'struct_specifier',
  'impl_item',
  'trait_item',
  'struct_item',
  'enum_item',
  'class_definition',
  'trait_declaration',
  'protocol_declaration',
  // Ruby
  'class',
  'module',
  // Kotlin
  'object_declaration',
  'companion_object',
]);

export const CONTAINER_TYPE_TO_LABEL: Record<string, string> = {
  class_declaration: 'Class',
  abstract_class_declaration: 'Class',
  interface_declaration: 'Interface',
  struct_declaration: 'Struct',
  struct_specifier: 'Struct',
  class_specifier: 'Class',
  class_definition: 'Class',
  impl_item: 'Impl',
  trait_item: 'Trait',
  struct_item: 'Struct',
  enum_item: 'Enum',
  trait_declaration: 'Trait',
  record_declaration: 'Record',
  protocol_declaration: 'Interface',
  class: 'Class',
  module: 'Module',
  object_declaration: 'Class',
  companion_object: 'Class',
};

/** Check if a Kotlin function_declaration capture is inside a class_body (i.e., a method).
 *  Kotlin grammar uses function_declaration for both top-level functions and class methods.
 *  Returns true when the captured definition node has a class_body ancestor. */
export function isKotlinClassMethod(
  captureNode: { parent?: SyntaxNode | null } | null | undefined,
): boolean {
  let ancestor = captureNode?.parent;
  while (ancestor) {
    if (ancestor.type === 'class_body') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

/**
 * Determine the graph node label from a tree-sitter capture map.
 * Handles language-specific reclassification via the provider's labelOverride hook
 * (e.g. C/C++ duplicate skipping, Kotlin Method promotion).
 * Returns null if the capture should be skipped (import, call, C/C++ duplicate, missing name).
 */
export function getLabelFromCaptures(
  captureMap: Record<string, SyntaxNode>,
  provider: LanguageProvider,
): NodeLabel | null {
  if (captureMap['import'] || captureMap['call']) return null;
  if (!captureMap['name'] && !captureMap['definition.constructor']) return null;

  if (captureMap['definition.function']) {
    if (provider.labelOverride) {
      const override = provider.labelOverride(captureMap['definition.function'], 'Function');
      if (override !== 'Function') return override;
    }
    return 'Function';
  }
  if (captureMap['definition.class']) return 'Class';
  if (captureMap['definition.interface']) return 'Interface';
  if (captureMap['definition.method']) return 'Method';
  if (captureMap['definition.struct']) return 'Struct';
  if (captureMap['definition.enum']) return 'Enum';
  if (captureMap['definition.namespace']) return 'Namespace';
  if (captureMap['definition.module']) return 'Module';
  if (captureMap['definition.trait']) return 'Trait';
  if (captureMap['definition.impl']) return 'Impl';
  if (captureMap['definition.type']) return 'TypeAlias';
  if (captureMap['definition.const']) return 'Const';
  if (captureMap['definition.static']) return 'Static';
  if (captureMap['definition.typedef']) return 'Typedef';
  if (captureMap['definition.macro']) return 'Macro';
  if (captureMap['definition.union']) return 'Union';
  if (captureMap['definition.property']) return 'Property';
  if (captureMap['definition.record']) return 'Record';
  if (captureMap['definition.delegate']) return 'Delegate';
  if (captureMap['definition.annotation']) return 'Annotation';
  if (captureMap['definition.constructor']) return 'Constructor';
  if (captureMap['definition.template']) return 'Template';
  return 'CodeElement';
}

/** Walk up AST to find enclosing class/struct/interface/impl, return its generateId or null.
 *  For Go method_declaration nodes, extracts receiver type (e.g. `func (u *User) Save()` → User struct). */
export const findEnclosingClassId = (node: SyntaxNode, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    // Go: method_declaration has a receiver parameter with the struct type
    if (current.type === 'method_declaration') {
      const receiver = current.childForFieldName?.('receiver');
      if (receiver) {
        // receiver is a parameter_list: (u *User) or (u User)
        const paramDecl = receiver.namedChildren?.find?.(
          (c: SyntaxNode) => c.type === 'parameter_declaration',
        );
        if (paramDecl) {
          const typeNode = paramDecl.childForFieldName?.('type');
          if (typeNode) {
            // Unwrap pointer_type (*User → User)
            const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
            if (inner && (inner.type === 'type_identifier' || inner.type === 'identifier')) {
              return generateId('Struct', `${filePath}:${inner.text}`);
            }
          }
        }
      }
    }
    // Go: type_declaration wrapping a struct_type (type User struct { ... })
    // field_declaration → field_declaration_list → struct_type → type_spec → type_declaration
    if (current.type === 'type_declaration') {
      const typeSpec = current.children?.find((c: SyntaxNode) => c.type === 'type_spec');
      if (typeSpec) {
        const typeBody = typeSpec.childForFieldName?.('type');
        if (typeBody?.type === 'struct_type' || typeBody?.type === 'interface_type') {
          const nameNode = typeSpec.childForFieldName?.('name');
          if (nameNode) {
            const label = typeBody.type === 'struct_type' ? 'Struct' : 'Interface';
            return generateId(label, `${filePath}:${nameNode.text}`);
          }
        }
      }
    }
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Rust impl_item: for `impl Trait for Struct {}`, pick the type after `for`
      if (current.type === 'impl_item') {
        const children = current.children ?? [];
        const forIdx = children.findIndex((c: SyntaxNode) => c.text === 'for');
        if (forIdx !== -1) {
          const nameNode = children
            .slice(forIdx + 1)
            .find((c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier');
          if (nameNode) {
            return generateId('Impl', `${filePath}:${nameNode.text}`);
          }
        }
        // Fall through: plain `impl Struct {}` — use first type_identifier below
      }
      const nameNode =
        current.childForFieldName?.('name') ??
        current.children?.find(
          (c: SyntaxNode) =>
            c.type === 'type_identifier' ||
            c.type === 'identifier' ||
            c.type === 'name' ||
            c.type === 'constant',
        );
      if (nameNode) {
        const label = CONTAINER_TYPE_TO_LABEL[current.type] || 'Class';
        return generateId(label, `${filePath}:${nameNode.text}`);
      }
    }
    current = current.parent;
  }
  return null;
};

/**
 * Find a child of `childType` within a sibling node of `siblingType`.
 * Used for Kotlin AST traversal where visibility_modifier lives inside a modifiers sibling.
 */
export const findSiblingChild = (
  parent: SyntaxNode,
  siblingType: string,
  childType: string,
): SyntaxNode | null => {
  for (let i = 0; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling?.type === siblingType) {
      for (let j = 0; j < sibling.childCount; j++) {
        const child = sibling.child(j);
        if (child?.type === childType) return child;
      }
    }
  }
  return null;
};

/**
 * Extract function name and label from a function_definition or similar AST node.
 * Handles C/C++ qualified_identifier (ClassName::MethodName) and other language patterns.
 */
export const extractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } => {
  let funcName: string | null = null;
  let label: NodeLabel = 'Function';

  // Swift init/deinit
  if (node.type === 'init_declaration' || node.type === 'deinit_declaration') {
    return {
      funcName: node.type === 'init_declaration' ? 'init' : 'deinit',
      label: 'Constructor',
    };
  }

  if (FUNCTION_DECLARATION_TYPES.has(node.type)) {
    // C/C++: function_definition -> [pointer_declarator ->] function_declarator -> qualified_identifier/identifier
    // Unwrap pointer_declarator / reference_declarator wrappers to reach function_declarator
    let declarator = node.childForFieldName?.('declarator');
    if (!declarator) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.type === 'function_declarator') {
          declarator = c;
          break;
        }
      }
    }
    while (
      declarator &&
      (declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator')
    ) {
      let nextDeclarator = declarator.childForFieldName?.('declarator');
      if (!nextDeclarator) {
        for (let i = 0; i < declarator.childCount; i++) {
          const c = declarator.child(i);
          if (
            c?.type === 'function_declarator' ||
            c?.type === 'pointer_declarator' ||
            c?.type === 'reference_declarator'
          ) {
            nextDeclarator = c;
            break;
          }
        }
      }
      declarator = nextDeclarator;
    }
    if (declarator) {
      let innerDeclarator = declarator.childForFieldName?.('declarator');
      if (!innerDeclarator) {
        for (let i = 0; i < declarator.childCount; i++) {
          const c = declarator.child(i);
          if (
            c?.type === 'qualified_identifier' ||
            c?.type === 'identifier' ||
            c?.type === 'field_identifier' ||
            c?.type === 'parenthesized_declarator'
          ) {
            innerDeclarator = c;
            break;
          }
        }
      }

      if (innerDeclarator?.type === 'qualified_identifier') {
        let nameNode = innerDeclarator.childForFieldName?.('name');
        if (!nameNode) {
          for (let i = 0; i < innerDeclarator.childCount; i++) {
            const c = innerDeclarator.child(i);
            if (c?.type === 'identifier') {
              nameNode = c;
              break;
            }
          }
        }
        if (nameNode?.text) {
          funcName = nameNode.text;
          label = 'Method';
        }
      } else if (
        innerDeclarator?.type === 'identifier' ||
        innerDeclarator?.type === 'field_identifier'
      ) {
        // field_identifier is used for method names inside C++ class bodies
        funcName = innerDeclarator.text;
        if (innerDeclarator.type === 'field_identifier') label = 'Method';
      } else if (innerDeclarator?.type === 'parenthesized_declarator') {
        let nestedId: SyntaxNode | null = null;
        for (let i = 0; i < innerDeclarator.childCount; i++) {
          const c = innerDeclarator.child(i);
          if (c?.type === 'qualified_identifier' || c?.type === 'identifier') {
            nestedId = c;
            break;
          }
        }
        if (nestedId?.type === 'qualified_identifier') {
          let nameNode = nestedId.childForFieldName?.('name');
          if (!nameNode) {
            for (let i = 0; i < nestedId.childCount; i++) {
              const c = nestedId.child(i);
              if (c?.type === 'identifier') {
                nameNode = c;
                break;
              }
            }
          }
          if (nameNode?.text) {
            funcName = nameNode.text;
            label = 'Method';
          }
        } else if (nestedId?.type === 'identifier') {
          funcName = nestedId.text;
        }
      }
    }

    // Fallback for other languages (Kotlin uses simple_identifier, Swift uses simple_identifier)
    if (!funcName) {
      let nameNode = node.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (
            c?.type === 'identifier' ||
            c?.type === 'property_identifier' ||
            c?.type === 'simple_identifier'
          ) {
            nameNode = c;
            break;
          }
        }
      }
      funcName = nameNode?.text;
    }
  } else if (node.type === 'impl_item') {
    let funcItem: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_item') {
        funcItem = c;
        break;
      }
    }
    if (funcItem) {
      let nameNode = funcItem.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < funcItem.childCount; i++) {
          const c = funcItem.child(i);
          if (c?.type === 'identifier') {
            nameNode = c;
            break;
          }
        }
      }
      funcName = nameNode?.text;
      label = 'Method';
    }
  } else if (node.type === 'method_definition') {
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.type === 'property_identifier') {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text;
    label = 'Method';
  } else if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.type === 'identifier') {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text;
    label = 'Method';
  } else if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      let nameNode = parent.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < parent.childCount; i++) {
          const c = parent.child(i);
          if (c?.type === 'identifier') {
            nameNode = c;
            break;
          }
        }
      }
      funcName = nameNode?.text;
    }
  } else if (node.type === 'method' || node.type === 'singleton_method') {
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.type === 'identifier') {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text;
    label = 'Method';
  } else if (node.type === 'function_signature') {
    // Dart: top-level function signatures
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.type === 'identifier') {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text ?? null;
  } else if (node.type === 'method_signature') {
    // Dart: method_signature wraps function_signature
    let funcSig: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_signature') {
        funcSig = c;
        break;
      }
    }
    if (funcSig) {
      let nameNode = funcSig.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < funcSig.childCount; i++) {
          const c = funcSig.child(i);
          if (c?.type === 'identifier') {
            nameNode = c;
            break;
          }
        }
      }
      funcName = nameNode?.text ?? null;
    }
    label = 'Method';
  }

  return { funcName, label };
};

export interface MethodSignature {
  parameterCount: number | undefined;
  /** Number of required (non-optional, non-default) parameters.
   *  Only set when fewer than parameterCount — enables range-based arity filtering.
   *  undefined means all parameters are required (or metadata unavailable). */
  requiredParameterCount: number | undefined;
  /** Per-parameter type names extracted via extractSimpleTypeName.
   *  Only populated for languages with method overloading (Java, Kotlin, C#, C++).
   *  undefined (not []) when no types are extractable — avoids empty array allocations. */
  parameterTypes: string[] | undefined;
  returnType: string | undefined;
}

/** Argument list node types shared between extractMethodSignature and countCallArguments. */
export const CALL_ARGUMENT_LIST_TYPES = new Set(['arguments', 'argument_list', 'value_arguments']);

/**
 * Extract parameter count and return type text from an AST method/function node.
 * Works across languages by looking for common AST patterns.
 */
export const extractMethodSignature = (node: SyntaxNode | null | undefined): MethodSignature => {
  let parameterCount: number | undefined = 0;
  let requiredCount = 0;
  let returnType: string | undefined;
  let isVariadic = false;
  const paramTypes: string[] = [];

  if (!node)
    return {
      parameterCount,
      requiredParameterCount: undefined,
      parameterTypes: undefined,
      returnType,
    };

  const paramListTypes = new Set([
    'formal_parameters',
    'parameters',
    'parameter_list',
    'function_parameters',
    'method_parameters',
    'function_value_parameters',
    'formal_parameter_list', // Dart
  ]);

  // Node types that indicate variadic/rest parameters
  const VARIADIC_PARAM_TYPES = new Set([
    'variadic_parameter_declaration', // Go: ...string
    'variadic_parameter', // Rust: extern "C" fn(...)
    'spread_parameter', // Java: Object... args
    'list_splat_pattern', // Python: *args
    'dictionary_splat_pattern', // Python: **kwargs
  ]);

  /** AST node types that represent parameters with default values. */
  const OPTIONAL_PARAM_TYPES = new Set([
    'optional_parameter', // TypeScript, Ruby: (x?: number), (x: number = 5), def f(x = 5)
    'default_parameter', // Python: def f(x=5)
    'typed_default_parameter', // Python: def f(x: int = 5)
    'optional_parameter_declaration', // C++: void f(int x = 5)
  ]);

  /** Check if a parameter node has a default value (handles Kotlin, C#, Swift, PHP
   *  where defaults are expressed as child nodes rather than distinct node types). */
  const hasDefaultValue = (paramNode: SyntaxNode): boolean => {
    if (OPTIONAL_PARAM_TYPES.has(paramNode.type)) return true;
    // C#, Swift, PHP: check for '=' token or equals_value_clause child
    for (let i = 0; i < paramNode.childCount; i++) {
      const c = paramNode.child(i);
      if (!c) continue;
      if (c.type === '=' || c.type === 'equals_value_clause') return true;
    }
    // Kotlin: default values are siblings of the parameter node, not children.
    // The AST is: parameter, =, <literal>  — all at function_value_parameters level.
    // Check if the immediately following sibling is '=' (default value separator).
    const sib = paramNode.nextSibling;
    if (sib && sib.type === '=') return true;
    return false;
  };

  const findParameterList = (current: SyntaxNode): SyntaxNode | null => {
    for (const child of current.children) {
      if (paramListTypes.has(child.type)) return child;
    }
    for (const child of current.children) {
      const nested = findParameterList(child);
      if (nested) return nested;
    }
    return null;
  };

  const parameterList = paramListTypes.has(node.type)
    ? node // node itself IS the parameter list (e.g. C# primary constructors)
    : (node.childForFieldName?.('parameters') ?? findParameterList(node));

  if (parameterList && paramListTypes.has(parameterList.type)) {
    for (const param of parameterList.namedChildren) {
      if (param.type === 'comment') continue;
      if (
        param.text === 'self' ||
        param.text === '&self' ||
        param.text === '&mut self' ||
        param.type === 'self_parameter'
      ) {
        continue;
      }
      // TypeScript: `this` parameter is a compile-time type constraint, not a real param
      // e.g., handle(this: void, event: Event) — only count 'event'
      if (param.type === 'required_parameter') {
        const patternNode = param.childForFieldName('pattern');
        if (patternNode?.type === 'this') continue;
      }
      // Kotlin: default values are siblings of the parameter node inside
      // function_value_parameters, so they appear as named children (e.g.
      // string_literal, integer_literal, boolean_literal, call_expression).
      // Skip any named child that isn't a parameter-like or modifier node.
      if (
        param.type.endsWith('_literal') ||
        param.type === 'call_expression' ||
        param.type === 'navigation_expression' ||
        param.type === 'prefix_expression' ||
        param.type === 'parenthesized_expression'
      ) {
        continue;
      }
      // Check for variadic parameter types
      if (VARIADIC_PARAM_TYPES.has(param.type)) {
        isVariadic = true;
        continue;
      }
      // TypeScript/JavaScript: rest parameter — required_parameter containing rest_pattern
      if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
        for (const child of param.children) {
          if (child.type === 'rest_pattern') {
            isVariadic = true;
            break;
          }
        }
        if (isVariadic) continue;
      }
      // Kotlin: vararg modifier on a regular parameter
      if (param.type === 'parameter' || param.type === 'formal_parameter') {
        const prev = param.previousSibling;
        if (prev?.type === 'parameter_modifiers' && prev.text.includes('vararg')) {
          isVariadic = true;
        }
      }
      // Extract parameter type name for overload disambiguation.
      // Works for Java (formal_parameter), Kotlin (parameter), C# (parameter),
      // C++ (parameter_declaration). Uses childForFieldName('type') which is the
      // standard tree-sitter field for typed parameters across these languages.
      // Kotlin uses positional children instead of 'type' field — fall back to
      // searching for user_type/nullable_type/predefined_type children.
      const paramTypeNode = param.childForFieldName('type');
      if (paramTypeNode) {
        const typeName = extractSimpleTypeName(paramTypeNode);
        paramTypes.push(typeName ?? 'unknown');
      } else {
        // Kotlin: parameter → [simple_identifier, user_type|nullable_type]
        let found = false;
        for (const child of param.namedChildren) {
          if (
            child.type === 'user_type' ||
            child.type === 'nullable_type' ||
            child.type === 'type_identifier' ||
            child.type === 'predefined_type'
          ) {
            const typeName = extractSimpleTypeName(child);
            paramTypes.push(typeName ?? 'unknown');
            found = true;
            break;
          }
        }
        if (!found) paramTypes.push('unknown');
      }
      if (!hasDefaultValue(param)) requiredCount++;
      parameterCount++;
    }
    // C/C++: bare `...` token in parameter list (not a named child — check all children)
    if (!isVariadic) {
      for (const child of parameterList.children) {
        if (!child.isNamed && child.text === '...') {
          isVariadic = true;
          break;
        }
      }
    }
  }

  // Swift fallback: tree-sitter-swift places `parameter` nodes as direct children of
  // function_declaration without a wrapping parameters/function_parameters list node.
  // When no parameter list was found, count direct `parameter` children on the node.
  if (!parameterList && parameterCount === 0) {
    for (const child of node.namedChildren) {
      if (child.type === 'parameter') {
        if (!hasDefaultValue(child)) requiredCount++;
        parameterCount++;
      }
    }
  }

  // Return type extraction — language-specific field names
  // Go: 'result' field is either a type_identifier or parameter_list (multi-return)
  const goResult = node.childForFieldName?.('result');
  if (goResult) {
    if (goResult.type === 'parameter_list') {
      // Multi-return: extract first parameter's type only (e.g. (*User, error) → *User)
      const firstParam = goResult.firstNamedChild;
      if (firstParam?.type === 'parameter_declaration') {
        const typeNode = firstParam.childForFieldName('type');
        if (typeNode) returnType = typeNode.text;
      } else if (firstParam) {
        // Unnamed return types: (string, error) — first child is a bare type node
        returnType = firstParam.text;
      }
    } else {
      returnType = goResult.text;
    }
  }

  // Rust: 'return_type' field — the value IS the type node (e.g. primitive_type, type_identifier).
  // Skip if the node is a type_annotation (TS/Python), which is handled by the generic loop below.
  if (!returnType) {
    const rustReturn = node.childForFieldName?.('return_type');
    if (rustReturn && rustReturn.type !== 'type_annotation') {
      returnType = rustReturn.text;
    }
  }

  // C/C++: 'type' field on function_definition
  if (!returnType) {
    const cppType = node.childForFieldName?.('type');
    if (cppType && cppType.text !== 'void') {
      returnType = cppType.text;
    }
  }

  // C#: 'returns' field on method_declaration
  if (!returnType) {
    const csReturn = node.childForFieldName?.('returns');
    if (csReturn && csReturn.text !== 'void') {
      returnType = csReturn.text;
    }
  }

  // TS/Rust/Python/C#/Kotlin: type_annotation or return_type child
  if (!returnType) {
    for (const child of node.children) {
      if (child.type === 'type_annotation' || child.type === 'return_type') {
        const typeNode = child.children.find((c) => c.isNamed);
        if (typeNode) returnType = typeNode.text;
      }
    }
  }

  // Kotlin: fun getUser(): User — return type is a bare user_type child of
  // function_declaration. The Kotlin grammar does NOT wrap it in type_annotation
  // or return_type; it appears as a direct child after function_value_parameters.
  // Note: Kotlin uses function_value_parameters (not a field), so we find it by type.
  if (!returnType) {
    let paramsEnd = -1;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'function_value_parameters' || child.type === 'value_parameters') {
        paramsEnd = child.endIndex;
      }
      if (paramsEnd >= 0 && child.type === 'user_type' && child.startIndex > paramsEnd) {
        returnType = child.text;
        break;
      }
    }
  }

  if (isVariadic) parameterCount = undefined;

  // Only include parameterTypes when at least one type was successfully extracted.
  // Use undefined (not []) to avoid empty array allocations for untyped parameters.
  const hasTypes = paramTypes.length > 0 && paramTypes.some((t) => t !== 'unknown');
  // Only set requiredParameterCount when it differs from total — saves memory on the common case.
  const requiredParameterCount =
    !isVariadic && requiredCount < (parameterCount ?? 0) ? requiredCount : undefined;
  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: hasTypes ? paramTypes : undefined,
    returnType,
  };
};

// ============================================================================
// Generic AST traversal helpers (shared by parse-worker + php-helpers)
// ============================================================================

/** Walk an AST node depth-first, returning the first descendant with the given type. */
export function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

/** Extract the text content from a string or encapsed_string AST node. */
export function extractStringContent(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const content = node.children?.find((c: SyntaxNode) => c.type === 'string_content');
  if (content) return content.text;
  if (node.type === 'string_content') return node.text;
  return null;
}

/** Check if a C/C++ function_definition is inside a class or struct body.
 *  Used by the C/C++ labelOverride to skip duplicate function captures
 *  that are already covered by definition.method queries. */
export function isCppInsideClassOrStruct(functionNode: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = functionNode?.parent ?? null;
  while (ancestor) {
    if (ancestor.type === 'class_specifier' || ancestor.type === 'struct_specifier') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

/** Find the first direct named child of a tree-sitter node matching the given type. */
export function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}
