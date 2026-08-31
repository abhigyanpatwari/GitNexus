/**
 * Lombok accessor synthesizer for Java.
 *
 * Lombok generates getters/setters at compile time. They are absent from the
 * AST, so calls like `obj.getOrderId()` on a `@Data` class would otherwise
 * leave unresolved CALLS edges. This module walks the tree-sitter Java AST
 * and synthesizes Method graph members for the accessors Lombok would emit
 * under the supported subset.
 *
 * ## Supported subset (v1)
 * - Proven `lombok.Data` / `lombok.Getter` / `lombok.Setter` (FQN or import).
 * - Class- or field-level enable; `AccessLevel.NONE` disables.
 * - Default JavaBeans naming; primitive `boolean isX` → `isX` / `setX`.
 * - Access levels PUBLIC/PROTECTED/PRIVATE/PACKAGE.
 * - `@Accessors(chain=true)` modeled as setter return = declaring type.
 * - `@Accessors(fluent=true)` / `prefix=…`: omit affected accessors (names
 *   cannot be proven without full Lombok config).
 * - External `lombok.config`: unsupported (may change semantics invisibly).
 *
 * ## Identity
 * Owner lookup uses in-memory AST node ids only. Method ids are derived from
 * the stable declaring-owner graph key (the Class node id's name segment),
 * never from persisted tree-sitter node ids.
 */

import type Parser from 'tree-sitter';
import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';

// ── Public result types (ParsedSymbol / ParsedNode compatible) ────────────

export type LombokVisibility = 'public' | 'protected' | 'private' | 'package';

export interface SyntheticSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: 'Method';
  ownerId: string;
  /** Required for resolveDefGraphId → CALLS emission (ClassName.method). */
  qualifiedName: string;
  parameterCount: number;
  requiredParameterCount: number;
  parameterTypes: string[];
  returnType: string;
  visibility: LombokVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
}

export interface SyntheticNode {
  id: string;
  label: 'Method';
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
    synthetic: 'lombok';
    visibility: LombokVisibility;
    isStatic: boolean;
    returnType: string;
    parameterTypes: string[];
    parameterCount: number;
    qualifiedName: string;
  };
}

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

/** One planned accessor before collision / Accessors filtering. */
export interface PlannedLombokAccessor {
  kind: 'getter' | 'setter';
  name: string;
  fieldName: string;
  fieldType: string;
  returnType: string;
  parameterTypes: string[];
  visibility: LombokVisibility;
  startLine: number;
  endLine: number;
  classNode: Parser.SyntaxNode;
  /** Field declaration used as the scope/structure anchor (no synthetic method AST). */
  fieldNode: Parser.SyntaxNode;
  classSimpleName: string;
  ownerIdPrefix: string;
}

export interface AccessorConfig {
  enabled: boolean;
  visibility: LombokVisibility;
}

interface AccessorsOptions {
  /** When true, JavaBeans get/set/is prefixes are not used — omit (unsupported). */
  fluent: boolean;
  /** When true, field prefixes alter base names — omit (unsupported). */
  hasPrefix: boolean;
  /** When true, setters return the declaring type instead of void. */
  chain: boolean;
}

interface LombokField {
  name: string;
  type: string;
  isStatic: boolean;
  isFinal: boolean;
  startLine: number;
  endLine: number;
  fieldNode: Parser.SyntaxNode;
  fieldGetter: AccessorConfig | null;
  fieldSetter: AccessorConfig | null;
  accessors: AccessorsOptions;
}

interface LombokClass {
  node: Parser.SyntaxNode;
  name: string;
  classGetter: AccessorConfig | null;
  classSetter: AccessorConfig | null;
  classAccessors: AccessorsOptions;
  fields: LombokField[];
  /** lowercase method name → set of arities already present (non-@Tolerate). */
  existingMethods: Map<string, Set<number>>;
}

const LOMBOK_ANNOTATIONS = new Set(['Data', 'Getter', 'Setter', 'Accessors', 'Tolerate']);

// ── Naming (Lombok HandlerUtil / beanspec) ────────────────────────────────

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Primitive boolean fields whose name already starts with `is` + uppercase
 * keep that name for the getter and drop the `is` prefix for the setter base
 * (`boolean isEnabled` → `isEnabled()` / `setEnabled(...)`).
 */
function booleanIsPrefixBase(fieldName: string, fieldType: string): string | null {
  if (fieldType !== 'boolean') return null;
  if (fieldName.length < 3) return null;
  if (!fieldName.startsWith('is')) return null;
  const third = fieldName.charAt(2);
  if (third !== third.toUpperCase() || third === third.toLowerCase()) return null;
  return fieldName.slice(2);
}

export function getterName(fieldName: string, fieldType: string): string {
  if (booleanIsPrefixBase(fieldName, fieldType) !== null) return fieldName;
  if (fieldType === 'boolean') return `is${capitalize(fieldName)}`;
  return `get${capitalize(fieldName)}`;
}

export function setterName(fieldName: string, fieldType: string): string {
  const stripped = booleanIsPrefixBase(fieldName, fieldType);
  if (stripped !== null) return `set${stripped}`;
  return `set${capitalize(fieldName)}`;
}

// ── Provenance / imports ──────────────────────────────────────────────────

function annotationSimpleName(nameText: string): string {
  return nameText.split('.').pop() ?? nameText;
}

function isLombokProven(nameText: string, lombokImports: Map<string, string>): boolean {
  if (nameText === 'lombok' || nameText.startsWith('lombok.')) return true;
  const simple = annotationSimpleName(nameText);
  const bound = lombokImports.get(simple);
  return (
    bound === `lombok.${simple}` ||
    bound === `lombok.experimental.${simple}` ||
    bound === 'lombok.*' ||
    bound === 'lombok.experimental.*'
  );
}

/**
 * Collect proven Lombok simple-name bindings from import declarations.
 * `import lombok.Data` → Data→lombok.Data; `import lombok.*` → *→lombok.*.
 */
function collectLombokImports(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_declaration') {
      const text = node.text
        .replace(/^import\s+/, '')
        .replace(/;\s*$/, '')
        .trim();
      if (text === 'lombok.*' || text === 'lombok.experimental.*') {
        map.set('*', text);
      } else if (text.startsWith('lombok.')) {
        const simple = annotationSimpleName(text);
        if (simple.length > 0) {
          map.set(simple, text);
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return map;
}

function hasStarLombok(imports: Map<string, string>): boolean {
  for (const v of imports.values()) {
    if (v === 'lombok.*' || v === 'lombok.experimental.*') return true;
  }
  return false;
}

function isProvenLombokAnnotation(nameText: string, imports: Map<string, string>): boolean {
  if (isLombokProven(nameText, imports)) return true;
  const simple = annotationSimpleName(nameText);
  if (!LOMBOK_ANNOTATIONS.has(simple)) return false;
  if (hasStarLombok(imports)) return true;
  const bound = imports.get(simple);
  return bound?.startsWith('lombok.') === true;
}

// ── AccessLevel / Accessors structural parse ──────────────────────────────

function parseAccessLevelToken(text: string): LombokVisibility | 'none' | null {
  const simple = annotationSimpleName(text.trim());
  switch (simple) {
    case 'PUBLIC':
      return 'public';
    case 'PROTECTED':
      return 'protected';
    case 'PRIVATE':
      return 'private';
    case 'PACKAGE':
    case 'MODULE': // treated as package-private for graph metadata
      return 'package';
    case 'NONE':
      return 'none';
    default:
      return null;
  }
}

function findAccessLevelInAnnotation(ann: Parser.SyntaxNode): LombokVisibility | 'none' | null {
  // Positional: @Getter(AccessLevel.PROTECTED) or @Getter(lombok.AccessLevel.NONE)
  // Named: @Getter(value = AccessLevel.PRIVATE)
  const stack: Parser.SyntaxNode[] = [...ann.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'field_access' || n.type === 'identifier') {
      const level = parseAccessLevelToken(n.text);
      if (level !== null) return level;
    }
    for (const c of n.children) stack.push(c);
  }
  return null;
}

function defaultAccessors(): AccessorsOptions {
  return { fluent: false, hasPrefix: false, chain: false };
}

function parseAccessorsAnnotation(ann: Parser.SyntaxNode): AccessorsOptions {
  const opts = defaultAccessors();
  const stack: Parser.SyntaxNode[] = [...ann.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'element_value_pair') {
      const key =
        n.childForFieldName('key')?.text ?? n.children.find((c) => c.type === 'identifier')?.text;
      const valueNode =
        n.childForFieldName('value') ??
        n.children.find(
          (c) =>
            c.type === 'true' || c.type === 'false' || c.type === 'element_value_array_initializer',
        );
      if (key === 'fluent' && valueNode?.type === 'true') opts.fluent = true;
      if (key === 'chain' && valueNode?.type === 'true') opts.chain = true;
      if (key === 'prefix') opts.hasPrefix = true;
    }
    // Bare @Accessors(true) does not occur; still scan identifiers for prefix= strings via array init
    if (n.type === 'element_value_array_initializer' || n.type === 'string_literal') {
      // Presence of any string/array under Accessors implies prefix configuration.
      // Only mark hasPrefix when we already saw key=prefix; handled above.
    }
    for (const c of n.children) stack.push(c);
  }
  // Also detect `prefix = "m"` / `prefix = {"m","f"}` without relying solely on key field name
  const text = ann.text;
  if (/\bprefix\s*=/.test(text)) opts.hasPrefix = true;
  if (/\bfluent\s*=\s*true\b/.test(text)) opts.fluent = true;
  if (/\bchain\s*=\s*true\b/.test(text)) opts.chain = true;
  return opts;
}

interface ParsedAnnotations {
  getter: AccessorConfig | null;
  setter: AccessorConfig | null;
  data: boolean;
  accessors: AccessorsOptions;
  tolerate: boolean;
}

function parseModifierAnnotations(
  modifiersNode: Parser.SyntaxNode | null,
  imports: Map<string, string>,
): ParsedAnnotations {
  const result: ParsedAnnotations = {
    getter: null,
    setter: null,
    data: false,
    accessors: defaultAccessors(),
    tolerate: false,
  };
  if (!modifiersNode) return result;

  for (const child of modifiersNode.children) {
    if (child.type !== 'marker_annotation' && child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    const nameText = nameNode?.text ?? '';
    if (!isProvenLombokAnnotation(nameText, imports)) continue;
    const simple = annotationSimpleName(nameText);

    if (simple === 'Tolerate') {
      result.tolerate = true;
      continue;
    }
    if (simple === 'Accessors') {
      result.accessors = parseAccessorsAnnotation(child);
      continue;
    }
    if (simple === 'Data') {
      result.data = true;
      // @Data implies public getters + setters
      result.getter = { enabled: true, visibility: 'public' };
      result.setter = { enabled: true, visibility: 'public' };
      continue;
    }
    if (simple === 'Getter' || simple === 'Setter') {
      const level = child.type === 'annotation' ? findAccessLevelInAnnotation(child) : null;
      const cfg: AccessorConfig =
        level === 'none'
          ? { enabled: false, visibility: 'public' }
          : { enabled: true, visibility: level ?? 'public' };
      if (simple === 'Getter') result.getter = cfg;
      else result.setter = cfg;
    }
  }
  return result;
}

function mergeAccessors(
  classOpts: AccessorsOptions,
  fieldOpts: AccessorsOptions,
): AccessorsOptions {
  return {
    fluent: classOpts.fluent || fieldOpts.fluent,
    hasPrefix: classOpts.hasPrefix || fieldOpts.hasPrefix,
    chain: classOpts.chain || fieldOpts.chain,
  };
}

function effectiveAccessor(
  classCfg: AccessorConfig | null,
  fieldCfg: AccessorConfig | null,
): AccessorConfig | null {
  if (fieldCfg !== null) return fieldCfg;
  return classCfg;
}

// ── Field / method collection ─────────────────────────────────────────────

function parseFieldDeclaration(
  fieldNode: Parser.SyntaxNode,
  imports: Map<string, string>,
): LombokField[] {
  const typeNode = fieldNode.childForFieldName('type');
  const fieldType = typeNode?.text ?? 'Object';
  const modifiers = fieldNode.children.find((c) => c.type === 'modifiers') ?? null;
  let isStatic = false;
  let isFinal = false;
  if (modifiers) {
    for (const mod of modifiers.children) {
      if (mod.text === 'static') isStatic = true;
      else if (mod.text === 'final') isFinal = true;
    }
  }
  const fieldAnn = parseModifierAnnotations(modifiers, imports);

  const declarators: Parser.SyntaxNode[] = [];
  const declaratorField = fieldNode.childForFieldName('declarator');
  if (declaratorField) declarators.push(declaratorField);
  for (const child of fieldNode.children) {
    if (child.type === 'variable_declarator' && child !== declaratorField) {
      declarators.push(child);
    }
  }

  const startLine = fieldNode.startPosition.row + 1;
  const endLine = fieldNode.endPosition.row + 1;
  const out: LombokField[] = [];
  for (const declaratorNode of declarators) {
    const nameNode = declaratorNode.childForFieldName('name');
    if (!nameNode) continue;
    out.push({
      name: nameNode.text,
      type: fieldType,
      isStatic,
      isFinal,
      startLine,
      endLine,
      fieldNode,
      fieldGetter: fieldAnn.getter,
      fieldSetter: fieldAnn.setter,
      accessors: fieldAnn.accessors,
    });
  }
  return out;
}

function methodArity(methodNode: Parser.SyntaxNode): number {
  const params = methodNode.childForFieldName('parameters');
  if (!params) return 0;
  let count = 0;
  for (const child of params.namedChildren) {
    if (
      child.type === 'formal_parameter' ||
      child.type === 'spread_parameter' ||
      child.type === 'receiver_parameter'
    ) {
      // receiver_parameter is not a user arity slot for collision with Lombok
      if (child.type === 'receiver_parameter') continue;
      count += 1;
    }
  }
  return count;
}

function collectExistingMethods(
  classBody: Parser.SyntaxNode | null,
  imports: Map<string, string>,
): Map<string, Set<number>> {
  const names = new Map<string, Set<number>>();
  if (!classBody) return names;
  for (const child of classBody.children) {
    if (child.type !== 'method_declaration') continue;
    const mods = child.children.find((c) => c.type === 'modifiers') ?? null;
    const ann = parseModifierAnnotations(mods, imports);
    if (ann.tolerate) continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const key = nameNode.text.toLowerCase();
    const arity = methodArity(child);
    let set = names.get(key);
    if (!set) {
      set = new Set();
      names.set(key, set);
    }
    set.add(arity);
  }
  return names;
}

function hasExisting(existing: Map<string, Set<number>>, name: string, arity: number): boolean {
  return existing.get(name.toLowerCase())?.has(arity) === true;
}

const TYPE_BODIES = new Set(['class_body', 'enum_body', 'interface_body']);

function findTypeBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.children.find((c) => TYPE_BODIES.has(c.type)) ?? null;
}

function findLombokClasses(root: Parser.SyntaxNode, imports: Map<string, string>): LombokClass[] {
  const classes: LombokClass[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration' || node.type === 'enum_declaration') {
      const modifiers = node.children.find((c) => c.type === 'modifiers') ?? null;
      const classAnn = parseModifierAnnotations(modifiers, imports);
      const nameNode = node.childForFieldName('name');
      const className = nameNode?.text ?? '';
      if (className) {
        const body = findTypeBody(node);
        const fields: LombokField[] = [];
        if (body) {
          const collectFields = (container: Parser.SyntaxNode): void => {
            for (const child of container.children) {
              if (child.type === 'field_declaration') {
                for (const f of parseFieldDeclaration(child, imports)) {
                  if (f.isStatic) continue;
                  fields.push(f);
                }
              } else if (child.type === 'enum_body_declarations') {
                collectFields(child);
              }
            }
          };
          collectFields(body);
        }

        const anyFieldEnable = fields.some(
          (f) => f.fieldGetter?.enabled === true || f.fieldSetter?.enabled === true,
        );
        const classEnable =
          classAnn.getter?.enabled === true || classAnn.setter?.enabled === true || classAnn.data;

        // Class-level NONE alone is not enable — getter/setter configs may be disabled
        if (classEnable || anyFieldEnable) {
          classes.push({
            node,
            name: className,
            classGetter: classAnn.getter,
            classSetter: classAnn.setter,
            classAccessors: classAnn.accessors,
            fields,
            existingMethods: collectExistingMethods(body, imports),
          });
        }
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return classes;
}

function ownerIdNamePrefix(ownerId: string, filePath: string, fallback: string): string {
  const needle = `Class:${filePath}:`;
  if (ownerId.startsWith(needle)) return ownerId.slice(needle.length);
  // Enum owners use Enum:… in some paths; accept either
  const enumNeedle = `Enum:${filePath}:`;
  if (ownerId.startsWith(enumNeedle)) return ownerId.slice(enumNeedle.length);
  return fallback;
}

function planAccessors(cls: LombokClass): PlannedLombokAccessor[] {
  const planned: PlannedLombokAccessor[] = [];
  for (const field of cls.fields) {
    const accessors = mergeAccessors(cls.classAccessors, field.accessors);
    // fluent/prefix change names — omit rather than invent wrong names
    if (accessors.fluent || accessors.hasPrefix) continue;

    const getterCfg = effectiveAccessor(cls.classGetter, field.fieldGetter);
    const setterCfg = effectiveAccessor(cls.classSetter, field.fieldSetter);

    if (getterCfg?.enabled) {
      const gName = getterName(field.name, field.type);
      if (!hasExisting(cls.existingMethods, gName, 0)) {
        planned.push({
          kind: 'getter',
          name: gName,
          fieldName: field.name,
          fieldType: field.type,
          returnType: field.type,
          parameterTypes: [],
          visibility: getterCfg.visibility,
          startLine: field.startLine,
          endLine: field.endLine,
          classNode: cls.node,
          fieldNode: field.fieldNode,
          classSimpleName: cls.name,
          ownerIdPrefix: cls.name,
        });
      }
    }

    if (setterCfg?.enabled && !field.isFinal) {
      const sName = setterName(field.name, field.type);
      if (!hasExisting(cls.existingMethods, sName, 1)) {
        // chain=true → setter returns declaring type; never emit void in that case
        const returnType = accessors.chain ? cls.name : 'void';
        planned.push({
          kind: 'setter',
          name: sName,
          fieldName: field.name,
          fieldType: field.type,
          returnType,
          parameterTypes: [field.type],
          visibility: setterCfg.visibility,
          startLine: field.startLine,
          endLine: field.endLine,
          classNode: cls.node,
          fieldNode: field.fieldNode,
          classSimpleName: cls.name,
          ownerIdPrefix: cls.name,
        });
      }
    }
  }
  return planned;
}

// ── Main API ──────────────────────────────────────────────────────────────

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

  const imports = collectLombokImports(tree.rootNode);
  const lombokClasses = findLombokClasses(tree.rootNode, imports);

  for (const cls of lombokClasses) {
    const ownerId = classOwnersById.get(cls.node.id);
    if (!ownerId) continue;

    const idPrefix = ownerIdNamePrefix(ownerId, filePath, cls.name);
    const planned = planAccessors(cls);
    // Dedupe by Method identity — multi-declarator collection bugs or
    // overlapping enable paths must not emit two Method nodes for one signature.
    const emittedIds = new Set<string>();

    for (const acc of planned) {
      const arity = acc.parameterTypes.length;
      // Match structure-phase method qualification: `ClassName.method` (or
      // `Outer.Inner.method` when the owner key is nested). resolveDefGraphId
      // requires a non-empty qualifiedName; without it CALLS emission fails
      // even though MethodRegistry and graph nodes are present.
      const qualifiedName = `${idPrefix}.${acc.name}`;
      const nodeId = `Method:${filePath}:${qualifiedName}#${arity}`;
      if (emittedIds.has(nodeId)) continue;
      emittedIds.add(nodeId);
      result.nodes.push({
        id: nodeId,
        label: 'Method',
        properties: {
          name: acc.name,
          filePath,
          startLine: acc.startLine,
          endLine: acc.endLine,
          language: 'java',
          isExported: false,
          synthetic: 'lombok',
          visibility: acc.visibility,
          isStatic: false,
          returnType: acc.returnType,
          parameterTypes: acc.parameterTypes,
          parameterCount: arity,
          qualifiedName,
        },
      });
      result.symbols.push({
        filePath,
        name: acc.name,
        nodeId,
        type: 'Method',
        ownerId,
        qualifiedName,
        parameterCount: arity,
        requiredParameterCount: arity,
        parameterTypes: acc.parameterTypes,
        returnType: acc.returnType,
        visibility: acc.visibility,
        isStatic: false,
        isAbstract: false,
        isFinal: false,
      });
      result.relationships.push({
        id: `HAS_METHOD:${ownerId}->${nodeId}`,
        sourceId: ownerId,
        targetId: nodeId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: acc.kind === 'getter' ? 'lombok-getter' : 'lombok-setter',
      });
    }
  }

  return result;
}

/**
 * Scope-declaration captures mirroring structure-phase synthetic accessors,
 * so ParsedFile.localDefs / MethodRegistry ownership stay aligned with records.
 */
export function planLombokAccessorsForTree(tree: Parser.Tree): PlannedLombokAccessor[] {
  const imports = collectLombokImports(tree.rootNode);
  const out: PlannedLombokAccessor[] = [];
  for (const cls of findLombokClasses(tree.rootNode, imports)) {
    out.push(...planAccessors(cls));
  }
  return out;
}

/** Scope captures for Lombok accessors (dual-path parity with record components). */
export function synthesizeLombokAccessorCaptures(rootNode: Parser.SyntaxNode): CaptureMatch[] {
  const fakeTree = { rootNode } as Parser.Tree;
  const planned = planLombokAccessorsForTree(fakeTree);
  const captures: CaptureMatch[] = [];
  for (const acc of planned) {
    // Distinct anchors: getter → variable_declarator; setter → field_declaration.
    // Sharing one node for both would collide makeDefId ranges and @scope.function.
    const declarator =
      acc.fieldNode.childForFieldName('declarator') ??
      acc.fieldNode.children.find((c) => c.type === 'variable_declarator') ??
      acc.fieldNode;
    const anchor = acc.kind === 'getter' ? declarator : acc.fieldNode;
    const arity = String(acc.parameterTypes.length);
    const enclosing = ownerQualifiedSimpleName(acc.classNode);
    const qualifiedName = `${enclosing}.${acc.name}`;
    captures.push({
      '@scope.function': nodeToCapture('@scope.function', anchor),
    });
    captures.push({
      '@declaration.method': nodeToCapture('@declaration.method', anchor),
      '@declaration.name': syntheticCapture('@declaration.name', anchor, acc.name),
      '@declaration.qualified-name': syntheticCapture(
        '@declaration.qualified-name',
        anchor,
        qualifiedName,
      ),
      '@declaration.parameter-count': syntheticCapture(
        '@declaration.parameter-count',
        anchor,
        arity,
      ),
      '@declaration.required-parameter-count': syntheticCapture(
        '@declaration.required-parameter-count',
        anchor,
        arity,
      ),
      '@declaration.return-type': syntheticCapture(
        '@declaration.return-type',
        anchor,
        acc.returnType,
      ),
      '@declaration.is-synthetic': syntheticCapture('@declaration.is-synthetic', anchor, 'true'),
    });
  }
  return captures;
}

/** Immediate nested type path: `Outer.Inner` or top-level `User`. */
function ownerQualifiedSimpleName(classNode: Parser.SyntaxNode): string {
  const parts: string[] = [];
  let current: Parser.SyntaxNode | null = classNode;
  while (current) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'enum_declaration' ||
      current.type === 'interface_declaration' ||
      current.type === 'record_declaration'
    ) {
      const name = current.childForFieldName('name')?.text;
      if (name) parts.unshift(name);
    }
    current = current.parent;
  }
  return parts.join('.') || 'Unknown';
}
