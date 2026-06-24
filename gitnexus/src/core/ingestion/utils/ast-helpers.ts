import type Parser from 'tree-sitter';
import type { Capture, NodeLabel, Range } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';
import { generateId } from '../../../lib/utils.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
  templateArgumentsIdTag,
} from './template-arguments.js';
import { splitQualifiedName } from './qualified-name.js';

/** Tree-sitter AST node. Re-exported for use across ingestion modules. */
export type SyntaxNode = Parser.SyntaxNode;

/**
 * Qualify a Rust inherent-impl target (`impl Inner { ... }`) by its enclosing
 * `mod_item` scope, so a bare same-tail target nested under different modules
 * resolves to a DISTINCT path (`outer.Inner` vs `other.Inner`) — the #1982
 * follow-up to #1975. Walks `mod_item` ancestors (outermost → innermost) and
 * joins them with the normalized raw target via the shared `splitQualifiedName`.
 * A top-level `impl Inner` (no enclosing mod) returns the bare target unchanged.
 * Keyed purely on tree-sitter node types (no language name), matching the
 * inherent-impl branch in `findEnclosingClassInfo`; the caller restricts this to
 * UNSCOPED targets (`type_identifier`) so a SCOPED `impl a::Inner` keeps its full
 * raw text (#1975). The Impl-node materialization in parsing-processor /
 * parse-worker mirrors this so the owner edge and node id agree byte-for-byte.
 */
export const qualifyRustImplTargetByModScope = (
  implNode: SyntaxNode,
  rawTargetText: string,
): string => {
  const modSegments: string[] = [];
  let current = implNode.parent;
  while (current) {
    if (current.type === 'mod_item') {
      const nameNode =
        current.childForFieldName?.('name') ??
        current.children?.find((c: SyntaxNode) => c.type === 'identifier');
      if (nameNode) modSegments.unshift(nameNode.text);
    }
    current = current.parent;
  }
  return [...modSegments, ...splitQualifiedName(rawTargetText)].filter(Boolean).join('.');
};

/**
 * #1991: scope-label predicate that single-sources the `nodeLabel === 'Trait'`
 * checks in parsing-processor.ts / parse-worker.ts. A Ruby `module` maps to the
 * `Trait` registry label but is NOT a typeDeclaration, so `extractQualifiedName`
 * bails on it; these node labels are instead qualified via the scope walk
 * (`qualifyScopeName`) so same-tail nested modules get distinct ids. Keeping the
 * literal in one place stops the four hand-maintained copies (two each in the
 * sequential and worker definition paths) from drifting apart. Pure predicate —
 * value-identical to the inlined `nodeLabel === 'Trait'`.
 */
export const isQualifiableScopeLabel = (nodeLabel: string): boolean => nodeLabel === 'Trait';

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
  captureMap: Record<string, SyntaxNode | undefined>,
): SyntaxNode | null => {
  for (const key of DEFINITION_CAPTURE_KEYS) {
    if (captureMap[key]) return captureMap[key];
  }
  return null;
};

type QueryMatchLike = {
  captures: Array<{ name: string; node: SyntaxNode }>;
};

const nodeRangeKey = (node: SyntaxNode): string =>
  `${node.startPosition.row}:${node.startPosition.column}:${node.endPosition.row}:${node.endPosition.column}`;

const isConcreteTypedefCapture = (captureMap: Record<string, SyntaxNode>): boolean => {
  const definitionNode = getDefinitionNodeFromCaptures(captureMap);
  return (
    definitionNode?.type === 'type_definition' &&
    (captureMap['definition.struct'] !== undefined || captureMap['definition.enum'] !== undefined)
  );
};

export const buildConcreteTypedefDefinitionRanges = (
  matches: readonly QueryMatchLike[],
): Set<string> => {
  const ranges = new Set<string>();
  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const capture of match.captures) {
      captureMap[capture.name] = capture.node;
    }

    const definitionNode = getDefinitionNodeFromCaptures(captureMap);
    if (definitionNode && isConcreteTypedefCapture(captureMap)) {
      ranges.add(nodeRangeKey(definitionNode));
    }
  }
  return ranges;
};

export const isSuppressedConcreteTypedefDuplicate = (
  captureMap: Record<string, SyntaxNode>,
  concreteTypedefRanges: ReadonlySet<string>,
): boolean => {
  const definitionNode = getDefinitionNodeFromCaptures(captureMap);
  return (
    definitionNode?.type === 'type_definition' &&
    captureMap['definition.typedef'] !== undefined &&
    concreteTypedefRanges.has(nodeRangeKey(definitionNode))
  );
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
  'secondary_constructor', // F48: methodNodeTypes superset invariant
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
  // Go
  'struct_type',
  'interface_type',
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
  // class-like type registry used by `lookupClassByName` / inheritance
  // resolution. This lets `include` / `extend` / `prepend` mixin heritage
  // resolve to the providing module. Safe for non-Ruby languages: the only supported
  // grammar that uses the bare `module` AST node type as a container is
  // Ruby (Rust uses `mod_item`). Any new language adding a `module` node
  // type must explicitly reclassify here.
  module: 'Trait',
  singleton_class: 'Class', // Ruby: class << self inherits enclosing class name
  object_declaration: 'Class',
  companion_object: 'Class',
  struct_type: 'Struct',
  interface_type: 'Interface',
};

/**
 * Pre-order walk over a node and all its named descendants, invoking `cb` on
 * each. Replaces the per-language `visit`/`visitGo`/`visitRust`/`visitSwift`
 * clones that every language's capture-synthesis walker re-implemented (#1956
 * tri-review U6).
 *
 * Iterates by index with a null guard: `node.namedChild(i)` is typed
 * `SyntaxNode | null`, and most callers already guarded it. The Go and C#
 * callers previously iterated `node.namedChildren`; the Go one had no null
 * guard, so this standardizes them onto the guarded indexed form — a deliberate,
 * strictly-safer behavior addition (the traversal *sequence* is identical, so
 * capture output stays byte-identical on well-formed trees; the guard only
 * matters for a null named child, which the fixture corpus never produces).
 */
export function walkNamedTree(node: SyntaxNode, cb: (node: SyntaxNode) => void): void {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null) walkNamedTree(child, cb);
  }
}

/** Return the first matching ancestor unless a boundary ancestor is reached first. */
export function findAncestorBeforeBoundary(
  node: SyntaxNode,
  targetTypes: ReadonlySet<string>,
  boundaryTypes: ReadonlySet<string>,
): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (boundaryTypes.has(current.type)) return null;
    if (targetTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Determine the graph node label from a tree-sitter capture map.
 * Handles language-specific reclassification via the provider's labelOverride hook
 * (e.g. C/C++ duplicate skipping, Kotlin Method promotion).
 * Returns null if the capture should be skipped (import, call, C/C++ duplicate, missing name).
 */
export function getLabelFromCaptures(
  captureMap: Record<string, SyntaxNode | undefined>,
  provider: LanguageProvider,
): NodeLabel | null {
  if (captureMap['import'] || captureMap['call']) return null;
  const hasDefaultExportHocNameSeed =
    captureMap['definition.function'] !== undefined &&
    (captureMap['hoc'] !== undefined || captureMap['callee'] !== undefined);
  if (!captureMap['name'] && !captureMap['definition.constructor'] && !hasDefaultExportHocNameSeed)
    return null;

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
  /**
   * The owner node id keyed by the enclosing type's FULLY-QUALIFIED path
   * (e.g. "Class:file:Outer.Inner"), present only when the language opts into
   * `qualifiedNodeId` AND the enclosing type is actually nested (#1978).
   * Consumers building HAS_METHOD/HAS_PROPERTY owner edges use this in
   * preference to `classId` so the edge source matches the qualified class
   * node id. When absent, `classId` (the simple-tail key) is unchanged.
   */
  qualifiedClassId?: string;
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
  /**
   * Optional (#1978): returns the enclosing type's fully-qualified name
   * (e.g. "Outer.Inner") for a type-declaration container, or null. Callers
   * pass `classExtractor.extractQualifiedName` ONLY when the language's
   * `qualifiedNodeId` flag is on — so when omitted, behavior is byte-identical
   * to before (qualifiedClassId stays undefined). Used by the standard
   * class-container branch to compute `qualifiedClassId` from the SAME function
   * the node-id is built from, guaranteeing owner-id == node-id by construction.
   */
  getQualifiedOwnerName?: (node: SyntaxNode, simpleName: string) => string | null,
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
      // NOTE: This impl_item ownership logic is mirrored in
      // method-extractors/configs/rust.ts (extractOwnerName, metadata only).
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
            // `for` target keeps its raw text. A scoped path (impl T for a::Inner)
            // therefore owns through `a::Inner`, which only resolves once the
            // referenced struct is keyed by its qualified path — deferred to #1978.
            return {
              classId: generateId('Struct', `${filePath}:${nameNode.text}`),
              className: nameNode.text,
            };
          }
        }
        // Inherent impl target.
        //   - SCOPED (`impl a::Inner`, scoped_type_identifier): key by FULL text,
        //     matching the @definition.impl scoped arm (#1975). UNCHANGED.
        //   - UNSCOPED (`impl Inner`, type_identifier): qualify by the enclosing
        //     `mod_item` scope (`outer.Inner`) so two same-tail bare impls under
        //     different mods own through DISTINCT nodes. The Impl-node
        //     materialization (parsing-processor / parse-worker) mirrors this, so
        //     the owner id == the Impl node id byte-for-byte (#1982).
        //   - GENERIC (`impl<T> Inner<T>`, generic_type): the @definition.impl
        //     node is materialized only when the generic base is a bare
        //     `type_identifier` (tree-sitter-queries.ts), qualified the same way —
        //     so drill into the base and mirror that gate, keeping the owner id ==
        //     the node id byte-for-byte (#1992). A generic over a SCOPED base
        //     (`impl<T> a::Inner<T>`) materializes NO node, so it must produce NO
        //     owner (the method orphans — scoped-generic deferred, #1992).
        const implTarget = children.find(
          (c: SyntaxNode) =>
            c.type === 'type_identifier' ||
            c.type === 'scoped_type_identifier' ||
            c.type === 'generic_type',
        );
        if (implTarget) {
          const baseType =
            implTarget.type === 'generic_type'
              ? (implTarget.childForFieldName?.('type') ?? null)
              : implTarget;
          if (baseType?.type === 'type_identifier') {
            // Bare target (`impl Inner` or `impl<T> Inner<T>`): qualify by mod scope.
            // #1992 follow-up: qualify `className` too (not just `classId`). The
            // method node id is keyed `${className}.${name}`, so a bare tail collapses
            // two same-tail bare impls that ALSO share a method name (`a::Inner::m` +
            // `b::Inner::m` both → `Inner.m`) onto one Method node (graph addNode is
            // first-write-wins). Qualifying className → `a.Inner.m` / `b.Inner.m` keeps
            // them distinct. Symmetric: the call-resolution fallback rebuilds the same
            // `${className}.${name}` from the same enclosing-impl walk, so def and call
            // ids still agree. Owner edge anchors on `classId` (already qualified).
            const qualified = qualifyRustImplTargetByModScope(current, baseType.text);
            return {
              classId: generateId('Impl', `${filePath}:${qualified}`),
              className: qualified,
            };
          }
          if (baseType?.type === 'scoped_type_identifier' && implTarget.type !== 'generic_type') {
            // Top-level scoped `impl a::Inner`: key by full raw text (#1975).
            return {
              classId: generateId('Impl', `${filePath}:${baseType.text}`),
              className: baseType.text,
            };
          }
          // generic-over-scoped (`impl<T> a::Inner<T>`) and any other base: fall
          // through with no owner — no @definition.impl node exists, so attributing
          // a method to a synthesized id would orphan it against a phantom owner.
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
        // class_declaration with a `declaration_kind` field collapses several
        // type kinds onto one node (tree-sitter-swift: class / struct / enum /
        // extension / actor). The structure query labels struct → Struct and
        // enum → Enum; refine the owner label to match so a member edge
        // (HAS_METHOD / HAS_PROPERTY) anchors on the real Enum/Struct node id
        // rather than a non-existent `Class:` id (F79). Gated on the field
        // being present, so it is a no-op for grammars whose class_declaration
        // has no `declaration_kind` field (e.g. Kotlin).
        if (current.type === 'class_declaration' && label === 'Class') {
          const declKind = current.childForFieldName?.('declaration_kind')?.text;
          if (declKind === 'struct') label = 'Struct';
          else if (declKind === 'enum') label = 'Enum';
        }
        const templateArguments = extractTemplateArguments(nameNode.text);
        const classIdName =
          templateArguments !== undefined
            ? `${stripTemplateArguments(nameNode.text)}${templateArgumentsIdTag(templateArguments)}`
            : nameNode.text;
        // #1978: when the language opts into qualified node ids, key the owner
        // edge by the enclosing type's qualified path (e.g. "Outer.Inner") so it
        // matches the qualified class node id. Derived from the SAME
        // extractQualifiedName the node-id uses → agree by construction. Only set
        // when actually nested (qualified !== simple); top-level types are
        // unchanged. (Go receiver / Rust impl branches return earlier and are
        // intentionally untouched here.)
        const qualifiedOwnerName = getQualifiedOwnerName?.(current, nameNode.text);
        const qualifiedClassId =
          qualifiedOwnerName != null && qualifiedOwnerName !== nameNode.text
            ? generateId(
                label,
                `${filePath}:${
                  templateArguments !== undefined
                    ? `${stripTemplateArguments(qualifiedOwnerName)}${templateArgumentsIdTag(templateArguments)}`
                    : qualifiedOwnerName
                }`,
              )
            : undefined;
        return {
          classId: generateId(label, `${filePath}:${classIdName}`),
          className: nameNode.text,
          ...(qualifiedClassId !== undefined ? { qualifiedClassId } : {}),
        };
      }
    }
    current = current.parent;
  }
  return null;
};

/** Object literal binding info for TS/JS shorthand methods. */
export interface ObjectLiteralBindingInfo {
  ownerId: string;
}

/**
 * Block-statement AST types that disqualify an object-literal binding from
 * carrying a HAS_METHOD edge. A `const` declared inside one of these is block-
 * scoped and cannot be imported, so attributing methods to it would create
 * false-positive cross-file edges.
 */
const BLOCK_SCOPE_BOUNDARY_TYPES = new Set([
  'statement_block',
  'if_statement',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'switch_statement',
  'switch_case',
  'switch_default',
  'with_statement',
]);

/**
 * Find the file-scope variable that owns an object literal method definition.
 *
 * Covers TypeScript/JavaScript shorthand object methods such as:
 *
 *   export const service = { async load() {} };
 *
 * tree-sitter represents `load` as a `method_definition` inside an `object`,
 * not inside a class container. Without this fallback, ingestion emits a
 * top-level `Method` node but no edge from the exported `service` value to
 * that method, so impact queries cannot discover `service.load`.
 *
 * Two-phase walk:
 *   Phase A walks up from `node` tracking how many `object` ancestors we
 *     cross. The first `variable_declarator` reached with `objectDepth >= 1`
 *     is the candidate owner — unless `objectDepth > 1` (the method belongs
 *     to a nested object literal; we return null rather than misattribute
 *     to the outer binding). Hitting a function/class container before the
 *     declarator returns null (catches IIFE-wrapped literals).
 *   Phase B walks the declarator's own ancestors. Any function or class
 *     ancestor before reaching `program`/`export_statement` returns null
 *     (catches `const` declared inside a function body). Any block-statement
 *     ancestor also returns null (catches block-scoped declarations inside
 *     top-level `if`/`for`/`try`/etc., which cannot be imported).
 */
export const findObjectLiteralBindingInfo = (
  node: SyntaxNode,
  filePath: string,
): ObjectLiteralBindingInfo | null => {
  // ── Phase A: walk up from node, count `object` ancestors, find declarator
  let current: SyntaxNode | null = node;
  let objectDepth = 0;
  let declarator: SyntaxNode | null = null;

  while (current) {
    if (current.type === 'object') {
      objectDepth += 1;
    }

    if (current.type === 'variable_declarator' && objectDepth >= 1) {
      if (objectDepth > 1) {
        // Method belongs to a nested object literal; safe under-approximation.
        return null;
      }
      declarator = current;
      break;
    }

    if (
      current !== node &&
      (FUNCTION_NODE_TYPES.has(current.type) || CLASS_CONTAINER_TYPES.has(current.type))
    ) {
      // Function/class container encountered before owning declarator
      // (e.g. IIFE-wrapped object literal). Bail out.
      return null;
    }

    current = current.parent;
  }

  if (!declarator) return null;

  // ── Phase B: declarator must live at file scope (program / export_statement)
  // with no function, class, or block-statement ancestor in between.
  let anc: SyntaxNode | null = declarator.parent;
  while (anc) {
    if (anc.type === 'program' || anc.type === 'export_statement') {
      break;
    }
    if (FUNCTION_NODE_TYPES.has(anc.type) || CLASS_CONTAINER_TYPES.has(anc.type)) {
      return null;
    }
    if (BLOCK_SCOPE_BOUNDARY_TYPES.has(anc.type)) {
      return null;
    }
    anc = anc.parent;
  }

  const nameNode = declarator.childForFieldName?.('name');
  if (!nameNode || nameNode.type !== 'identifier') return null;

  const declaration = declarator.parent;
  const ownerLabel = declaration?.type === 'variable_declaration' ? 'Variable' : 'Const';
  return {
    ownerId: generateId(ownerLabel, `${filePath}:${nameNode.text}`),
  };
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
 *  `identifier` / `property_identifier` / `simple_identifier`.
 *
 *  `arrow_function` and `function_expression` (TS/JS) are inherently
 *  anonymous — they have no `name` field, and their first identifier
 *  child is a *parameter*, not a function name. Returning a parameter
 *  identifier here would synthesize phantom Function IDs (e.g. callers
 *  walking up from a call inside `arr.map(x => fn(x))` would get
 *  attributed to a non-existent "Function x"). The language's
 *  `methodExtractor.extractFunctionName` hook is responsible for naming
 *  these via parent context (variable_declarator, pair, etc.); when it
 *  declines, the parent walk should continue rather than fall through
 *  here. See issue #1166. */
export const genericFuncName = (node: SyntaxNode): string | null => {
  const nameField = node.childForFieldName?.('name');
  if (nameField) return nameField.text;
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return null;
  }
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

/**
 * Function/method parameter-list node types across grammars. Used to tell a
 * PARAMETER-property (a constructor parameter that is also a class field, e.g.
 * TypeScript `constructor(public name: string)`) apart from a function-BODY
 * local: a property reached through one of these — rather than through the
 * function's executable body — is a genuine class member, so the
 * function-local-property guard must NOT strip its owner edge.
 */
export const PARAMETER_LIST_NODE_TYPES = new Set([
  'formal_parameters', // TypeScript / JavaScript
  'parameters', // Python / C#
  'parameter_list', // Java / Go / C / Swift
  'function_value_parameters', // Kotlin
  'class_parameters', // Scala-like / future grammars
]);

/**
 * Executable local-scope boundaries for the property-ownership guard
 * (`isFunctionLocalProperty` in parse-worker.ts). A `Property` capture whose
 * nearest enclosing scope — walking up before any class container — is one of
 * these executable bodies is a function-local binding, NOT a class member, so it
 * must not receive a class `HAS_PROPERTY` owner edge.
 *
 * Derived from FUNCTION_NODE_TYPES, with two deliberate adjustments found by the
 * #1919 review of the original guard:
 *  - EXCLUDES Dart's bare signature wrappers (`function_signature` /
 *    `method_signature`). A Dart getter/setter NAME lives under `method_signature`,
 *    yet it is a class-member declaration, not a local inside an executable body;
 *    treating the signature as a scope boundary OVER-stripped every Dart class
 *    accessor's owner edge. (Signatures are Dart-only; no language emits a
 *    legitimately-function-local Property under one.)
 *  - INCLUDES accessor + initializer bodies (Kotlin `anonymous_initializer` /
 *    `getter` / `setter`, Swift `computed_property` / `computed_getter` /
 *    `computed_setter` / `computed_modify`). Destructuring/locals inside these ARE
 *    function-local, yet they are absent from FUNCTION_NODE_TYPES; omitting them
 *    UNDER-stripped and emitted spurious class `HAS_PROPERTY` edges for
 *    `init {}` / accessor-body destructuring bindings.
 *
 * Kept separate from FUNCTION_NODE_TYPES because that set has many other consumers
 * (e.g. enclosing-callable resolution) where signatures must remain function nodes
 * and accessor bodies must not.
 */
export const LOCAL_SCOPE_BODY_NODE_TYPES: ReadonlySet<string> = new Set(
  [...FUNCTION_NODE_TYPES]
    .filter((t) => t !== 'function_signature' && t !== 'method_signature')
    .concat([
      'anonymous_initializer', // Kotlin: init { }
      'getter', // Kotlin: val x get() { }
      'setter', // Kotlin: var x set(v) { }
      'computed_property', // Swift: var x: T { get set }
      'computed_getter', // Swift: get { }
      'computed_setter', // Swift: set { }
      'computed_modify', // Swift: _modify { }
    ]),
);

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

/** Remove bidi-override and zero-width control characters. Doc text is
 *  attacker-influenced (any indexed repo) and is returned verbatim to MCP
 *  clients, so strip Trojan-Source-style hidden controls from the description
 *  before it leaves the extractor (#2286 review). Scoped to the doc-comment path
 *  only — global `sanitizeUTF8` is intentionally untouched. */
const stripBidiAndZeroWidth = (text: string): string =>
  Array.from(text)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      // Bidi overrides/isolates (U+202A–202E, U+2066–2069), zero-width
      // space/joiners (U+200B–200D), and BOM/zero-width-no-break (U+FEFF).
      return !(
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) ||
        (c >= 0x200b && c <= 0x200d) ||
        c === 0xfeff
      );
    })
    .join('');

/** Normalize a block doc comment body: strip the opening (double-star or
 *  bang) delimiter, the closing delimiter, and per-line gutter stars, then
 *  collapse whitespace so tag content stays as searchable words. */
const normalizeBlockDocComment = (text: string): string | undefined => {
  const inner = stripBidiAndZeroWidth(
    text
      .replace(/^\/\*[*!]/, '')
      // Close delimiter: tolerate the degenerate empty comment `/**/`, where the
      // opening strip already consumed the shared `*`, leaving a lone `/`.
      .replace(/\*?\/\s*$/, '')
      .replace(/^[ \t]*\*[ \t]?/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return inner.length > 0 ? inner : undefined;
};

/** Default line-comment prefixes treated as documentation: the universal
 *  triple-slash / bang-slash doc markers (Rust, C#, Dart, Swift, Doxygen).
 *  Go (`//`) and Ruby (`#`) opt into their conventional markers explicitly. */
const DEFAULT_LINE_DOC_PREFIXES: readonly string[] = ['///', '//!'];

/** Default block-comment doc openers: Javadoc/JSDoc-style `/**` and Doxygen
 *  `/*!`. Rust opts out of `/*!` (and `//!`) because those are *inner* docs that
 *  document the enclosing item, not the following one. */
const DEFAULT_BLOCK_DOC_PREFIXES: readonly string[] = ['/**', '/*!'];

/** A file-top `/** … *\/` license/copyright/file-overview block has no
 *  package/import sibling to shield it, so it would otherwise be absorbed as the
 *  first declaration's description (PR #2286 review). These markers identify such
 *  headers; they are specific enough not to fire on an ordinary symbol doc that
 *  merely mentions the word "copyright". `@file`/`@fileoverview` are explicitly
 *  file-level JSDoc tags, so a block carrying them is not a symbol doc. */
const FILE_HEADER_MARKER =
  /SPDX-License-Identifier|@licen[sc]e\b|@fileoverview\b|@file\b|Licen[sc]ed under|copyright\s*(\(c\)|©|\d{4})/i;

/**
 * Extract the normalized text of a leading doc comment immediately preceding a
 * definition node — covering both block doc comments (Javadoc / KDoc / JSDoc /
 * PHPDoc / Doxygen, opened by `/**` or `/*!`) and runs of line doc comments
 * (`///`, `//!`, or the caller-supplied prefixes such as Go's `//` or Ruby's
 * `#`). Returns `undefined` when there is no preceding doc comment or it is
 * empty.
 *
 * Grammar-agnostic by design: matches on the comment text prefix rather than a
 * grammar node type, because the comment node is named differently across
 * grammars (`block_comment`, `multiline_comment`, `comment`, `line_comment`).
 * Annotations and modifiers live inside the definition node, so the doc comment
 * remains the definition's `previousNamedSibling` even on annotated/decorated
 * declarations.
 *
 * Block comments are taken as the immediately-preceding sibling (intervening
 * package/import/code siblings already shield a file-level license block from
 * the first declaration). Line doc comments enforce row-adjacency: the first
 * comment must sit on the line directly above the definition, and each comment
 * walked further up must sit directly above the previous one — so a run stops
 * at a blank line. This matches godoc/RDoc/rustdoc convention and prevents an
 * unrelated comment block (a license header, a Ruby shebang + magic comment)
 * separated by a blank line from being absorbed. Adjacency is checked on
 * `startPosition.row` (reliable) rather than `endPosition.row`, since some
 * grammars fold the trailing newline into the comment node.
 *
 * Normalization mirrors Python docstring handling: strip the comment delimiters
 * / per-line markers, then collapse whitespace to single spaces so tag content
 * (`@param`, `@deprecated since 2.0, use computeBalanceV2`) survives.
 *
 * When the captured definition is an inner node and its own preceding sibling
 * carries no doc, the search retries from a wrapping node whose type is listed in
 * `opts.wrapperNodeTypes` (e.g. an `export_statement` wrapping an exported
 * function/class — the JSDoc precedes the wrapper, not the inner declaration).
 */
export interface LeadingDocCommentOptions {
  /** Line-comment doc prefixes (defaults to {@link DEFAULT_LINE_DOC_PREFIXES};
   *  Go passes `['//']`, Ruby passes `['#']`). */
  lineCommentPrefixes?: readonly string[];
  /** Grammar node types that wrap a definition such that the doc comment is the
   *  wrapper's preceding sibling rather than the definition's. TS/JS pass
   *  `['export_statement']`. Empty by default → no wrapper retry. */
  wrapperNodeTypes?: readonly string[];
  /** Line-comment prefixes that are tool/build directives or magic comments
   *  rather than documentation (Go passes `['//go:', '// +build', …]`, Ruby
   *  passes `['# frozen_string_literal:', '#!', …]`). A matching line is skipped
   *  in the doc run rather than absorbed. Empty by default. */
  lineDirectivePrefixes?: readonly string[];
  /** Block-comment doc openers (defaults to `['/**', '/*!']`). Rust passes
   *  `['/**']` so its inner-doc `/*!` does not attach to the following item. */
  blockDocPrefixes?: readonly string[];
}

export function extractLeadingDocComment(
  node: SyntaxNode,
  opts: LeadingDocCommentOptions = {},
): string | undefined {
  const lineCommentPrefixes = opts.lineCommentPrefixes ?? DEFAULT_LINE_DOC_PREFIXES;
  const wrapperNodeTypes = opts.wrapperNodeTypes ?? [];
  const lineDirectivePrefixes = opts.lineDirectivePrefixes ?? [];
  const blockDocPrefixes = opts.blockDocPrefixes ?? DEFAULT_BLOCK_DOC_PREFIXES;

  const fromNode = (anchor: SyntaxNode): string | undefined => {
    const prev = anchor.previousNamedSibling;
    if (!prev) return undefined;

    // Block doc comment: /** ... */ or /*! ... */
    if (blockDocPrefixes.some((p) => prev.text.startsWith(p))) {
      // Skip a file-top license/copyright/overview header (no package/import
      // sibling shields it from the first declaration). A strict row-adjacency
      // check is unreliable here — some grammars fold the trailing newline into
      // the comment node — so match header markers instead.
      if (FILE_HEADER_MARKER.test(prev.text)) return undefined;
      return normalizeBlockDocComment(prev.text);
    }

    // Run of row-adjacent preceding line doc comments (e.g. `///` or `//`).
    const matchedPrefix = (text: string): string | undefined =>
      lineCommentPrefixes.find((prefix) => text.trimStart().startsWith(prefix));
    const isDirective = (text: string): boolean =>
      lineDirectivePrefixes.some((prefix) => text.trimStart().startsWith(prefix));

    const lines: string[] = [];
    let current: SyntaxNode | null = prev;
    let expectedRow = anchor.startPosition.row - 1;
    while (current) {
      const text = current.text;
      const prefix = matchedPrefix(text);
      if (prefix === undefined || current.startPosition.row !== expectedRow) break;
      // A build/tool directive or magic comment (e.g. `//go:build`,
      // `# frozen_string_literal:`) is not documentation: skip it but keep
      // walking the adjacent run, so a real doc above it is still collected.
      if (!isDirective(text)) lines.unshift(text.trimStart().slice(prefix.length));
      expectedRow = current.startPosition.row - 1;
      current = current.previousNamedSibling;
    }

    const joined = stripBidiAndZeroWidth(lines.join(' ').replace(/\s+/g, ' ').trim());
    return joined.length > 0 ? joined : undefined;
  };

  const direct = fromNode(node);
  if (direct !== undefined) return direct;

  const parent = node.parent;
  if (parent && wrapperNodeTypes.includes(parent.type)) {
    return fromNode(parent);
  }
  return undefined;
}

/** Node labels that can carry a leading doc comment — callables and type-like
 *  declarations. Field/property/variable/const doc is intentionally excluded
 *  (issue #2270 scopes this to method/type documentation). Language-neutral:
 *  a label a given grammar never emits simply never matches.
 *
 *  Bounded to labels that are also in `embeddings/types.ts` `EMBEDDABLE_LABELS`:
 *  the description is only useful once it reaches the embedding metadata header,
 *  and the embedding pipeline only queries embeddable labels. Extracting docs
 *  for a non-embeddable label is a wasted write that never becomes searchable.
 *  A subset invariant in the unit tests guards against drift. Making currently-
 *  non-embeddable doc-bearing labels (Module, Delegate, Annotation, and C++
 *  `Template`) searchable is tracked as a follow-up — it needs an embedding-
 *  pipeline/schema change beyond this fix. */
export const DOC_BEARING_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Function',
  'Method',
  'Constructor',
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Trait',
  'Record',
  'Union',
  'Namespace',
  'TypeAlias',
  'Macro',
]);

/**
 * Build a `LanguageProvider.descriptionExtractor` that surfaces a definition's
 * leading doc comment as its `description` (issue #2270). For labels in
 * {@link DOC_BEARING_LABELS} (which is bounded to embeddable labels) the text
 * then reaches the embedding metadata header and becomes semantically searchable.
 *
 * Language-neutral factory (names no language): guards on
 * {@link DOC_BEARING_LABELS}; callers pass per-language doc-comment behavior via
 * {@link LeadingDocCommentOptions} (line prefixes, export-style wrappers, …)
 * which is threaded straight through to {@link extractLeadingDocComment}.
 */
export const createLeadingDocDescriptionExtractor = (
  opts: LeadingDocCommentOptions = {},
): ((
  nodeLabel: NodeLabel,
  nodeName: string,
  captureMap: Record<string, SyntaxNode | undefined>,
) => string | undefined) => {
  return (nodeLabel, _nodeName, captureMap) => {
    if (!DOC_BEARING_LABELS.has(nodeLabel)) return undefined;
    const definitionNode = getDefinitionNodeFromCaptures(captureMap);
    return definitionNode ? extractLeadingDocComment(definitionNode, opts) : undefined;
  };
};

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

/**
 * Return the captured node if its type is one of `types`, else null.
 *
 * The threaded-node equivalent of `findNodeAtRange(root, capture.range, type)`
 * for the common case where a tree-sitter query already hands you the matched
 * node (`c.node`): the captured node IS the node at that range, so a type check
 * is exact and there is no need to re-walk from the tree root (the
 * O(matches × rootChildren) hot path #1848 hit). Unlike `findNodeAtRange`, this
 * does NOT traverse — the caller must already hold the node; for a multi-type
 * call the node must literally be one of `types` (no fallback search).
 *
 * Used by every language's scope-capture path (go/python/ruby/php/rust/csharp).
 */
export function nodeIfType<T extends SyntaxNode>(
  node: T | undefined,
  ...types: readonly string[]
): T | null {
  return node !== undefined && types.includes(node.type) ? node : null;
}
