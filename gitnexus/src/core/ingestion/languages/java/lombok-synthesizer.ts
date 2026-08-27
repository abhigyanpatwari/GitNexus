/**
 * Lombok method synthesizer for Java.
 *
 * Lombok generates accessor methods (getters/setters) at compile time via
 * annotation processors. These methods are absent from the AST — every call
 * to `obj.getOrderId()` on a `@Data` class is an unresolved call edge in the
 * static graph.
 *
 * This module walks the tree-sitter Java AST and, for each class annotated
 * with `@Getter`, `@Setter`, or `@Data`, synthesizes virtual Method graph
 * nodes for the accessor methods Lombok would generate. The output mirrors
 * the shape of real Method symbols/nodes/relationships so the rest of the
 * ingestion pipeline treats them identically.
 *
 * Synthesized methods are:
 *  - **Public** (`visibility: 'public'`): Lombok's default access level.
 *  - **Non-static**: only instance fields get accessors.
 *  - **Skipped when a hand-written method of the same name already exists.**
 *  - **Skipped for final fields' setters** (Lombok never emits those).
 *  - **Skipped for fields explicitly suppressed** via `@Getter/@Setter(AccessLevel.NONE)`.
 *
 * Naming follows the JavaBeans convention Lombok uses:
 *  - `String name` → `getName()` / `setName(String)`
 *  - `boolean active` → `isActive()` / `setActive(boolean)`
 *  - `Boolean active` → `getActive()` (boxed → getXxx, per Lombok)
 *
 * ## Identity model (root-cause fix for name ambiguity)
 *
 * A class is identified by its class_declaration AST node, not by its simple
 * name — simple names are ambiguous across files and among nested classes
 * with the same tail (bot review: cross-file collision + `Outer.A` vs
 * `Other.A` overwriting each other in a name-keyed map). The caller keys the
 * owner map by tree-sitter node id (`SyntaxNode.id`, a stable per-tree
 * integer), which is unique by construction for every declaration in the
 * file, so both collisions are impossible rather than filtered out.
 *
 * The synthesized Method node id follows the SAME convention real methods
 * use in parse-worker: `${filePath}:${idMethodName}#${arity}` where
 * `idMethodName` is qualified by the IMMEDIATE enclosing class simple name
 * only (`Outer.method`, never the full `Top.Outer.method` chain) — matching
 * `findEnclosingClassInfo().className` + `nodeName`, which keys real Method
 * ids for languages without `qualifiedNodeId` (Java among them).
 */

import type Parser from 'tree-sitter';

// ── Types ─────────────────────────────────────────────────────────────────

/** A field extracted from the AST for Lombok synthesis. */
interface LombokField {
  name: string;
  type: string;
  isStatic: boolean;
  isFinal: boolean;
  /** True when @Getter(AccessLevel.NONE) suppresses the getter for this field. */
  suppressGetter: boolean;
  /** True when @Setter(AccessLevel.NONE) suppresses the setter for this field. */
  suppressSetter: boolean;
}

/** A class eligible for Lombok accessor synthesis. */
interface LombokClass {
  /** Tree-sitter node of the class_declaration — the class's identity. */
  node: Parser.SyntaxNode;
  /** Class simple name. */
  name: string;
  /** 'getter' and/or 'setter' depending on which annotations are present. */
  generateGetters: boolean;
  generateSetters: boolean;
  fields: LombokField[];
  /** Names of methods already declared in this class body (collision guard). */
  existingMethods: Set<string>;
}

/** Synthetic symbol entry — mirrors the shape pushed to `result.symbols`. */
export interface SyntheticSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: 'Method';
  ownerId: string;
  parameterCount: number;
  requiredParameterCount: number;
  parameterTypes: string[];
  returnType: string;
  visibility: string;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isLombok: true;
}

/** Synthetic node entry — mirrors the shape pushed to `result.nodes`. */
export interface SyntheticNode {
  id: string;
  label: 'Method';
  properties: Record<string, unknown> & {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
    synthetic: 'lombok';
    visibility: string;
    isStatic: boolean;
    returnType: string;
    parameterTypes: string[];
    parameterCount: number;
  };
}

/** Synthetic relationship entry — mirrors the shape pushed to `result.relationships`. */
export interface SyntheticRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'HAS_METHOD';
  confidence: number;
  reason: string;
}

export interface LombokSynthesisResult {
  symbols: SyntheticSymbol[];
  nodes: SyntheticNode[];
  relationships: SyntheticRelationship[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Capitalize the first letter of a string. */
function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Generate the Lombok getter method name for a field. */
function getterName(fieldName: string, fieldType: string): string {
  // Primitive boolean → isXxx(); everything else → getXxx()
  if (fieldType === 'boolean') {
    return `is${capitalize(fieldName)}`;
  }
  return `get${capitalize(fieldName)}`;
}

/** Generate the Lombok setter method name for a field. */
function setterName(fieldName: string): string {
  return `set${capitalize(fieldName)}`;
}

/**
 * Extract annotation simple names from a tree-sitter `modifiers` node.
 * Handles both `marker_annotation` (`@Data`) and `annotation` (`@Getter(...)`)
 * and their fully-qualified forms (`@lombok.Data`).
 */
function extractAnnotationNames(modifiersNode: Parser.SyntaxNode | null): Set<string> {
  const names = new Set<string>();
  if (!modifiersNode) return names;

  for (const child of modifiersNode.children) {
    if (child.type !== 'marker_annotation' && child.type !== 'annotation') continue;
    // The name child is a named field 'name' within marker_annotation/annotation
    const nameNode = child.childForFieldName('name');
    const text = nameNode?.text ?? '';
    // Normalize to simple name: `lombok.Data` → `Data`
    const simpleName = text.split('.').pop() ?? text;
    if (simpleName) names.add(simpleName);
  }
  return names;
}

/**
 * Determine if a field's Lombok accessor is suppressed.
 *
 * `@Getter(AccessLevel.NONE)` or `@Setter(AccessLevel.NONE)` on a field
 * disables that specific accessor. We check for the string `NONE` in the
 * annotation text as a lightweight heuristic — the annotation argument is
 * always an enum constant, so `NONE` uniquely identifies suppression.
 */
function isAccessorSuppressed(
  fieldNode: Parser.SyntaxNode,
  accessorType: 'Getter' | 'Setter',
): boolean {
  const modifiers = fieldNode.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return false;
  for (const child of modifiers.children) {
    if (child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    const simpleName = nameNode?.text.split('.').pop();
    if (simpleName === accessorType && child.text.includes('NONE')) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a field declaration node to extract field name(s) and type.
 *
 * `private String name;` → [{ name: 'name', type: 'String', isStatic: false, isFinal: false }]
 * `private final Long id = 0L;` → [{ name: 'id', type: 'Long', isStatic: false, isFinal: true }]
 * `private int x, y;` → [{ name: 'x', ... }, { name: 'y', ... }]
 */
function parseFieldDeclaration(
  fieldNode: Parser.SyntaxNode,
): { name: string; type: string; isStatic: boolean; isFinal: boolean; suppressGetter: boolean; suppressSetter: boolean }[] {
  const results: { name: string; type: string; isStatic: boolean; isFinal: boolean; suppressGetter: boolean; suppressSetter: boolean }[] = [];

  // Type is in the `type` field
  const typeNode = fieldNode.childForFieldName('type');
  const fieldType = typeNode?.text ?? 'Object';

  // Check static/final — tree-sitter-java uses the keyword itself as the node type
  // (e.g. `static`, `final`), not a wrapper `modifier` node.
  const modifiers = fieldNode.children.find((c) => c.type === 'modifiers');
  let isStatic = false;
  let isFinal = false;
  if (modifiers) {
    for (const mod of modifiers.children) {
      if (mod.text === 'static') {
        isStatic = true;
      } else if (mod.text === 'final') {
        isFinal = true;
      }
    }
  }

  // Collect all variable declarators — handles both single (`int x;`) and
  // multi-variable (`int x, y;`) declarations. The `declarator` field name
  // returns only the first one; the rest are unnamed children.
  const declarators: Parser.SyntaxNode[] = [];
  const declaratorField = fieldNode.childForFieldName('declarator');
  if (declaratorField) {
    declarators.push(declaratorField);
  }
  // Also collect unnamed variable_declarator children (multi-variable case)
  for (const child of fieldNode.children) {
    if (child.type === 'variable_declarator' && child !== declaratorField) {
      declarators.push(child);
    }
  }

  for (const declaratorNode of declarators) {
    const nameNode = declaratorNode.childForFieldName('name');
    if (nameNode) {
      results.push({
        name: nameNode.text,
        type: fieldType,
        isStatic,
        isFinal,
        suppressGetter: false,
        suppressSetter: false,
      });
    }
  }

  return results;
}

/**
 * Collect method names from a class body (for collision detection).
 * Walks direct children of the class body for `method_declaration` nodes.
 */
function collectExistingMethodNames(classBody: Parser.SyntaxNode | null): Set<string> {
  const names = new Set<string>();
  if (!classBody) return names;
  for (const child of classBody.children) {
    if (child.type === 'method_declaration') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) names.add(nameNode.text);
    }
  }
  return names;
}

/** Walk the tree for class_declaration nodes eligible for Lombok synthesis. */
function findLombokClasses(root: Parser.SyntaxNode): LombokClass[] {
  const classes: LombokClass[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration') {
      const modifiers = node.children.find((c) => c.type === 'modifiers');
      const annotations = extractAnnotationNames(modifiers);

      const hasGetter = annotations.has('Getter') || annotations.has('Data');
      const hasSetter = annotations.has('Setter') || annotations.has('Data');

      if (hasGetter || hasSetter) {
        const nameNode = node.childForFieldName('name');
        const className = nameNode?.text ?? '';
        if (className) {
          // Find class body
          const body = node.children.find((c) => c.type === 'class_body');
          const existingMethods = collectExistingMethodNames(body ?? null);

          // Collect fields
          const fields: LombokField[] = [];
          if (body) {
            for (const child of body.children) {
              if (child.type !== 'field_declaration') continue;
              for (const f of parseFieldDeclaration(child)) {
                // Skip static fields (Lombok doesn't generate instance accessors for static fields)
                if (f.isStatic) continue;
                // Mark accessors suppressed when @Getter/@Setter(AccessLevel.NONE) is on the field
                if (hasGetter && isAccessorSuppressed(child, 'Getter')) {
                  f.suppressGetter = true;
                }
                if (hasSetter && isAccessorSuppressed(child, 'Setter')) {
                  f.suppressSetter = true;
                }
                fields.push(f);
              }
            }
          }

          classes.push({
            node,
            name: className,
            generateGetters: hasGetter,
            generateSetters: hasSetter,
            fields,
            existingMethods,
          });
        }
      }
    }

    // Recurse into children for nested classes
    for (const child of node.children) walk(child);
  }

  walk(root);
  return classes;
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Synthesize Lombok accessor methods for a Java file.
 *
 * Call this after the normal AST capture loop in parse-worker, for Java files
 * only. The returned symbols/nodes/relationships should be pushed into the
 * worker result so they flow through the rest of the pipeline unchanged.
 *
 * @param tree      The parsed tree-sitter Java AST.
 * @param filePath  Absolute file path.
 * @param classOwnersById  Map from tree-sitter node id (SyntaxNode.id) of the
 *                         class_declaration → graph node id of that class.
 *                         Keyed by AST node identity, so simple-name collisions
 *                         (across files or among same-tailed nested classes)
 *                         cannot resolve to the wrong class.
 * @returns Synthesis result, or empty if no Lombok classes found.
 */
export function synthesizeLombokAccessors(
  tree: Parser.Tree,
  filePath: string,
  classOwnersById: Map<number, string>,
): LombokSynthesisResult {
  const result: LombokSynthesisResult = {
    symbols: [],
    nodes: [],
    relationships: [],
  };

  const lombokClasses = findLombokClasses(tree.rootNode);

  for (const cls of lombokClasses) {
    const ownerId = classOwnersById.get(cls.node.id);
    if (!ownerId) continue; // Class not in the graph — skip

    // Synthesized method ids are keyed by the class's own simple name only
    // (`Inner.method`), matching how real member ids are keyed for nested
    // classes — `findEnclosingClassInfo().className` is the IMMEDIATE parent
    // simple name, so a real method in `Outer.Inner` keys as `Inner.method`,
    // never `Outer.Inner.method` (Java has no qualifiedNodeId).
    const idMethodNamePrefix = cls.name;

    for (const field of cls.fields) {
      // Getter (skip if suppressed by @Getter(AccessLevel.NONE))
      if (cls.generateGetters && !field.suppressGetter) {
        const gName = getterName(field.name, field.type);
        if (!cls.existingMethods.has(gName)) {
          const nodeId = `Method:${filePath}:${idMethodNamePrefix}.${gName}#0`;
          result.nodes.push({
            id: nodeId,
            label: 'Method',
            properties: {
              name: gName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: 'java',
              isExported: false,
              synthetic: 'lombok',
              visibility: 'public',
              isStatic: false,
              returnType: field.type,
              parameterTypes: [],
              parameterCount: 0,
            },
          });
          result.symbols.push({
            filePath,
            name: gName,
            nodeId,
            type: 'Method',
            ownerId,
            parameterCount: 0,
            requiredParameterCount: 0,
            parameterTypes: [],
            returnType: field.type,
            visibility: 'public',
            isStatic: false,
            isAbstract: false,
            isFinal: false,
            isLombok: true,
          });
          result.relationships.push({
            id: `HAS_METHOD:${ownerId}->${nodeId}`,
            sourceId: ownerId,
            targetId: nodeId,
            type: 'HAS_METHOD',
            confidence: 1.0,
            reason: 'lombok-getter',
          });
        }
      }

      // Setter — skipped when suppressed by @Setter(AccessLevel.NONE) or when
      // the field is final (Lombok never generates setters for final fields).
      if (cls.generateSetters && !field.suppressSetter && !field.isFinal) {
        const sName = setterName(field.name);
        if (!cls.existingMethods.has(sName)) {
          const nodeId = `Method:${filePath}:${idMethodNamePrefix}.${sName}#1`;
          result.nodes.push({
            id: nodeId,
            label: 'Method',
            properties: {
              name: sName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: 'java',
              isExported: false,
              synthetic: 'lombok',
              visibility: 'public',
              isStatic: false,
              returnType: 'void',
              parameterTypes: [field.type],
              parameterCount: 1,
            },
          });
          result.symbols.push({
            filePath,
            name: sName,
            nodeId,
            type: 'Method',
            ownerId,
            parameterCount: 1,
            requiredParameterCount: 1,
            parameterTypes: [field.type],
            returnType: 'void',
            visibility: 'public',
            isStatic: false,
            isAbstract: false,
            isFinal: false,
            isLombok: true,
          });
          result.relationships.push({
            id: `HAS_METHOD:${ownerId}->${nodeId}`,
            sourceId: ownerId,
            targetId: nodeId,
            type: 'HAS_METHOD',
            confidence: 1.0,
            reason: 'lombok-setter',
          });
        }
      }
    }
  }

  return result;
}
