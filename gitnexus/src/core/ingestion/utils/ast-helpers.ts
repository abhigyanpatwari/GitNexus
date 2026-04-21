import type Parser from 'tree-sitter';
import type { Capture, NodeLabel, Range } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';
import { generateId } from '../../../lib/utils.js';

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
  'definition.variable',
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
 * Used by parent-walk in call-processor, parse-worker, and type-env to detect
 * enclosing function scope boundaries.
 *
 * INVARIANT: This set MUST be a superset of every language's
 * MethodExtractionConfig.methodNodeTypes. When adding a new node type to a
 * MethodExtractor config, add it here too — otherwise enclosing-function
 * resolution will silently miss that node type during parent-walks.
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
 * AST node types that represent a class-like container (for HAS_METHOD edge extraction).
 *
 * INVARIANT: When a language config adds a new node type to `typeDeclarationNodes`,
 * that type must also be added here AND to `CONTAINER_TYPE_TO_LABEL` below,
 * otherwise `findEnclosingClassNode` won't recognize it and methods may get
 * orphaned HAS_METHOD edges or incorrect labels.
 */
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
  // PHP
  'enum_declaration',
  'protocol_declaration',
  // Dart
  'mixin_declaration',
  'extension_declaration',
  // Ruby
  'class',
  'module',
  'singleton_class', // Ruby: class << self
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
  enum_declaration: 'Enum',
  record_declaration: 'Record',
  protocol_declaration: 'Interface',
  mixin_declaration: 'Mixin',
  extension_declaration: 'Extension',
  class: 'Class',
  // Ruby `module` declarations map to `Trait` so they participate in the
  // class-like type registry used by `lookupClassByName` / `buildHeritageMap`.
  // This lets `include` / `extend` / `prepend` mixin heritage resolve to
  // the providing module. Safe for non-Ruby languages: the only supported
  // grammar that uses the bare `module` AST node type as a container is
  // Ruby (Rust uses `mod_item`). Any new language adding a `module` node
  // type must explicitly reclassify here.
  module: 'Trait',
  singleton_class: 'Class', // Ruby: class << self inherits enclosing class name
  object_declaration: 'Class',
  companion_object: 'Class',
};

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
  if (captureMap['definition.module']) {
    // Let providers reclassify module captures (e.g. Ruby remaps `Module`→`Trait`
    // so mixin heritage resolves through `lookupClassByName`). Returning null
    // from labelOverride means "skip this symbol"; treat it as a no-op here so
    // we keep the default label rather than dropping a real definition.
    if (provider.labelOverride) {
      const override = provider.labelOverride(captureMap['definition.module'], 'Module');
      if (override && override !== 'Module') return override;
    }
    return 'Module';
  }
  if (captureMap['definition.trait']) return 'Trait';
  if (captureMap['definition.impl']) return 'Impl';
  if (captureMap['definition.type']) return 'TypeAlias';
  if (captureMap['definition.const']) return 'Const';
  if (captureMap['definition.static']) return 'Static';
  if (captureMap['definition.variable']) return 'Variable';
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

/** Enclosing class info: both the generated node ID and the bare class name. */
export interface EnclosingClassInfo {
  classId: string; // e.g. "Class:animal.dart:Animal"
  className: string; // e.g. "Animal"
}

/** Walk up AST to find enclosing class/struct/interface/impl, return its ID and name.
 *  For Go method_declaration nodes, extracts receiver type (e.g. `func (u *User) Save()` → User struct).
 *
 *  @param resolveEnclosingOwner  Optional language-specific hook for container remapping.
 *    When provided and a CLASS_CONTAINER_TYPES node is found, this hook is called:
 *    - Return a different SyntaxNode to remap the container (e.g., Ruby singleton_class → class).
 *    - Return `null` to skip this container and keep walking up.
 *    - Return the input node (identity) to use the container as-is.
 *    When omitted, the container node is used as-is.
 *
 *    INVARIANT: Implementers SHOULD return either `null`, the input node, or
 *    another CLASS_CONTAINER_TYPES node. Returning a non-container node is
 *    permitted but discouraged — it will cause the walk to skip the current
 *    container and continue from the redirected node's parent. The
 *    `MAX_ENCLOSING_WALK_ITERATIONS` defense-in-depth guard below prevents
 *    pathological hooks from creating an infinite loop. */
const MAX_ENCLOSING_WALK_ITERATIONS = 4096;

export const findEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
  let current = node.parent;
  let iterations = 0;
  // Tracks container nodes already visited via the hook so a misbehaving hook
  // that keeps redirecting back to the same container cannot loop forever.
  const visitedContainers = new Set<SyntaxNode>();
  while (current) {
    if (++iterations > MAX_ENCLOSING_WALK_ITERATIONS) {
      // Defense-in-depth: a real source tree has nowhere near this many ancestors.
      // Bail out rather than hang ingestion.
      return null;
    }
    // Go: method_declaration has a receiver parameter with the struct type
    if (current.type === 'method_declaration') {
      const receiver = current.childForFieldName?.('receiver');
      if (receiver) {
        const paramDecl = receiver.namedChildren?.find?.(
          (c: SyntaxNode) => c.type === 'parameter_declaration',
        );
        if (paramDecl) {
          const typeNode = paramDecl.childForFieldName?.('type');
          if (typeNode) {
            const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
            if (inner && (inner.type === 'type_identifier' || inner.type === 'identifier')) {
              return {
                classId: generateId('Struct', `${filePath}:${inner.text}`),
                className: inner.text,
              };
            }
          }
        }
      }
    }
    // Go: type_declaration wrapping a struct_type (type User struct { ... })
    if (current.type === 'type_declaration') {
      const typeSpec = current.children?.find((c: SyntaxNode) => c.type === 'type_spec');
      if (typeSpec) {
        const typeBody = typeSpec.childForFieldName?.('type');
        if (typeBody?.type === 'struct_type' || typeBody?.type === 'interface_type') {
          const nameNode = typeSpec.childForFieldName?.('name');
          if (nameNode) {
            const label = typeBody.type === 'struct_type' ? 'Struct' : 'Interface';
            return {
              classId: generateId(label, `${filePath}:${nameNode.text}`),
              className: nameNode.text,
            };
          }
        }
      }
    }
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Delegate language-specific container remapping to the provider hook.
      if (resolveEnclosingOwner) {
        if (visitedContainers.has(current)) {
          // We've already asked the hook about this container once — a loop
          // would form (e.g., hook redirects to a child node whose parent is
          // this same container). Skip and walk up.
          current = current.parent;
          continue;
        }
        visitedContainers.add(current);
        const resolved = resolveEnclosingOwner(current);
        if (resolved === null) {
          // Provider says skip this container — keep walking up.
          current = current.parent;
          continue;
        }
        if (resolved !== current) {
          // Provider remapped to a different node — re-evaluate from there.
          current = resolved;
          continue;
        }
      }

      // Rust impl_item: for `impl Trait for Struct {}`, pick the type after `for`
      // NOTE: This impl_item ownership logic is duplicated in rust.ts:extractOwnerName.
      // If modifying this block, update the other location too.
      if (current.type === 'impl_item') {
        const children = current.children ?? [];
        const forIdx = children.findIndex((c: SyntaxNode) => c.text === 'for');
        if (forIdx !== -1) {
          const nameNode = children
            .slice(forIdx + 1)
            .find(
              (c: SyntaxNode) =>
                c.type === 'type_identifier' ||
                c.type === 'scoped_type_identifier' ||
                c.type === 'identifier',
            );
          if (nameNode) {
            return {
              classId: generateId('Struct', `${filePath}:${nameNode.text}`),
              className: nameNode.text,
            };
          }
        }
        const firstType = children.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (firstType) {
          return {
            classId: generateId('Impl', `${filePath}:${firstType.text}`),
            className: firstType.text,
          };
        }
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
        let label = CONTAINER_TYPE_TO_LABEL[current.type] || 'Class';
        // Kotlin: class_declaration with an anonymous "interface" keyword child
        // is actually an interface, not a class. Refine the label to match the
        // node ID generated from the tree-sitter query capture (@definition.interface).
        if (
          current.type === 'class_declaration' &&
          label === 'Class' &&
          current.children?.some((c: SyntaxNode) => c.type === 'interface')
        ) {
          label = 'Interface';
        }
        return {
          classId: generateId(label, `${filePath}:${nameNode.text}`),
          className: nameNode.text,
        };
      }
    }
    current = current.parent;
  }
  return null;
};

/** Convenience wrapper: returns just the class ID string (backward compat). */
export const findEnclosingClassId = (node: SyntaxNode, filePath: string): string | null => {
  return findEnclosingClassInfo(node, filePath)?.classId ?? null;
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

/** Generic name extraction from a function-like AST node.
 *  Tries `node.childForFieldName('name')?.text`, then scans children for
 *  `identifier` / `property_identifier` / `simple_identifier`. */
export const genericFuncName = (node: SyntaxNode): string | null => {
  const nameField = node.childForFieldName?.('name');
  if (nameField) return nameField.text;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (
      c?.type === 'identifier' ||
      c?.type === 'property_identifier' ||
      c?.type === 'simple_identifier'
    )
      return c.text;
  }
  return null;
};

/** AST node types that represent a method definition (for `inferFunctionLabel`). */
export const METHOD_LABEL_NODE_TYPES = new Set([
  'method_definition',
  'method_declaration',
  'method',
  'singleton_method',
]);

/** AST node types that represent a constructor definition (for `inferFunctionLabel`). */
export const CONSTRUCTOR_LABEL_NODE_TYPES = new Set([
  'constructor_declaration',
  'compact_constructor_declaration',
]);

/** Infer node label from AST node type for function-like nodes without a provider hook. */
export const inferFunctionLabel = (nodeType: string): NodeLabel =>
  METHOD_LABEL_NODE_TYPES.has(nodeType)
    ? 'Method'
    : CONSTRUCTOR_LABEL_NODE_TYPES.has(nodeType)
      ? 'Constructor'
      : 'Function';

/** Argument list node types shared between countCallArguments and call-resolution helpers. */
export const CALL_ARGUMENT_LIST_TYPES = new Set(['arguments', 'argument_list', 'value_arguments']);

// ============================================================================
// Generic AST traversal helpers (shared by parse-worker + php-helpers)
// ============================================================================

/** Walk an AST node depth-first, returning the first descendant with the given type. */
export function findDescendant(root: SyntaxNode, type: string): SyntaxNode | null {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    // Push in reverse order so left children are visited first (depth-first)
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
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

/** Find the first direct named child of a tree-sitter node matching the given type. */
export function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

// ============================================================================
// Capture + range helpers (formerly python/ast-utils.ts — language-agnostic)
// ============================================================================

/** Convert a tree-sitter node to a `Capture` with 1-based line numbers
 *  (matching RFC §2.1). The tag includes the leading `@`. */
export function nodeToCapture(name: string, node: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text: node.text,
  };
}

/** Build a `Capture` whose range mirrors `atNode` but whose `text` is
 *  caller-supplied. Used to synthesize markers that don't have a
 *  corresponding source token. */
export function syntheticCapture(name: string, atNode: SyntaxNode, text: string): Capture {
  return {
    name,
    range: {
      startLine: atNode.startPosition.row + 1,
      startCol: atNode.startPosition.column,
      endLine: atNode.endPosition.row + 1,
      endCol: atNode.endPosition.column,
    },
    text,
  };
}

function rangeMatches(node: SyntaxNode, range: Range): boolean {
  return (
    node.startPosition.row + 1 === range.startLine &&
    node.startPosition.column === range.startCol &&
    node.endPosition.row + 1 === range.endLine &&
    node.endPosition.column === range.endCol
  );
}

/** Walk a subtree to find a node whose range exactly matches AND whose
 *  type matches `expectedType` (when given). When multiple nodes share
 *  the range — e.g., `function_definition` and its inner `block` body
 *  for a one-liner — the type filter disambiguates.
 *
 *  Iterative depth-first-left-to-right via an explicit stack. Children
 *  are pushed in reverse index order so LIFO pop visits them in source
 *  order. Prunes branches that can't contain the target range by
 *  row bounds — same optimization the prior recursive form used, minus
 *  the early-break since stack-push is cheap. */
export function findNodeAtRange(
  root: SyntaxNode,
  range: Range,
  expectedType?: string,
): SyntaxNode | null {
  const startRow = range.startLine - 1;
  const endRow = range.endLine - 1;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (rangeMatches(node, range) && (expectedType === undefined || node.type === expectedType)) {
      return node;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child === null) continue;
      if (child.endPosition.row < startRow) continue;
      if (child.startPosition.row > endRow) continue;
      stack.push(child);
    }
  }
  return null;
}
