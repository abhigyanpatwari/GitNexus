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
import {
  hasExistingAccessor,
  javaUsesIsPrefix,
  jvmGetterName,
  jvmSetterName,
} from '../jvm/beanspec.js';
import {
  capturesForPlannedAccessors,
  emitPlannedAccessors,
  emptySyntheticAccessorResult,
  ownerIdNamePrefix,
  type PlannedJvmAccessor,
  type SyntheticAccessorResult,
  type SyntheticVisibility,
} from '../jvm/synthetic-accessors.js';

const JAVA_TYPE_DECLS = new Set([
  'class_declaration',
  'enum_declaration',
  'interface_declaration',
  'record_declaration',
]);

// ── Public result types (ParsedSymbol / ParsedNode compatible) ────────────

export type LombokVisibility = SyntheticVisibility;
export type SyntheticSymbol = SyntheticAccessorResult['symbols'][number];
export type SyntheticNode = SyntheticAccessorResult['nodes'][number];
export type SyntheticRelationship = SyntheticAccessorResult['relationships'][number];
export type LombokSynthesisResult = SyntheticAccessorResult;
export type PlannedLombokAccessor = PlannedJvmAccessor;

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
  declaratorNode: Parser.SyntaxNode;
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

export function getterName(fieldName: string, fieldType: string): string {
  return jvmGetterName(fieldName, javaUsesIsPrefix(fieldType));
}

export function setterName(fieldName: string, fieldType: string): string {
  return jvmSetterName(fieldName, javaUsesIsPrefix(fieldType));
}

// ── Provenance / imports ──────────────────────────────────────────────────

function annotationSimpleName(nameText: string): string {
  return nameText.split('.').pop() ?? nameText;
}

interface LombokImportIndex {
  bySimple: Map<string, string>;
  star: boolean;
}

/**
 * Compilation-unit imports only — Java `import` is never nested in a type body.
 */
function collectLombokImports(root: Parser.SyntaxNode): LombokImportIndex {
  const bySimple = new Map<string, string>();
  let star = false;
  for (const child of root.children) {
    if (child.type !== 'import_declaration') continue;
    const text = child.text
      .replace(/^import\s+/, '')
      .replace(/;\s*$/, '')
      .trim();
    if (text === 'lombok.*' || text === 'lombok.experimental.*') {
      star = true;
    } else if (text.startsWith('lombok.')) {
      const simple = annotationSimpleName(text);
      if (simple.length > 0) bySimple.set(simple, text);
    }
  }
  return { bySimple, star };
}

function isProvenLombokAnnotation(nameText: string, imports: LombokImportIndex): boolean {
  if (nameText === 'lombok' || nameText.startsWith('lombok.')) return true;
  const simple = annotationSimpleName(nameText);
  if (!LOMBOK_ANNOTATIONS.has(simple)) return false;
  if (imports.star) return true;
  return imports.bySimple.get(simple)?.startsWith('lombok.') === true;
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
    for (const c of n.children) stack.push(c);
  }
  const text = ann.text;
  if (/\bprefix\s*=/.test(text)) opts.hasPrefix = true;
  if (/\bfluent\s*=\s*true\b/.test(text)) opts.fluent = true;
  if (/\bchain\s*=\s*true\b/.test(text)) opts.chain = true;
  return opts;
}

interface ParsedAnnotations {
  getter: AccessorConfig | null;
  setter: AccessorConfig | null;
  accessors: AccessorsOptions;
  tolerate: boolean;
}

function parseModifierAnnotations(
  modifiersNode: Parser.SyntaxNode | null,
  imports: LombokImportIndex,
): ParsedAnnotations {
  const result: ParsedAnnotations = {
    getter: null,
    setter: null,
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
  imports: LombokImportIndex,
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
      declaratorNode,
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
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') count += 1;
  }
  return count;
}

function collectExistingMethods(
  classBody: Parser.SyntaxNode | null,
  imports: LombokImportIndex,
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
  return hasExistingAccessor(existing, name, arity);
}

const TYPE_BODIES = new Set(['class_body', 'enum_body']);

function findTypeBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.children.find((c) => TYPE_BODIES.has(c.type)) ?? null;
}

function findLombokClasses(root: Parser.SyntaxNode, imports: LombokImportIndex): LombokClass[] {
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
        const classEnable = classAnn.getter?.enabled === true || classAnn.setter?.enabled === true;

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
          returnType: field.type,
          parameterTypes: [],
          visibility: getterCfg.visibility,
          startLine: field.startLine,
          endLine: field.endLine,
          classNode: cls.node,
          declaratorNode: field.declaratorNode,
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
          returnType,
          parameterTypes: [field.type],
          visibility: setterCfg.visibility,
          startLine: field.startLine,
          endLine: field.endLine,
          classNode: cls.node,
          declaratorNode: field.declaratorNode,
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
  classOwnersById: ReadonlyMap<number, string>,
): LombokSynthesisResult {
  const result = emptySyntheticAccessorResult();
  const imports = collectLombokImports(tree.rootNode);

  for (const cls of findLombokClasses(tree.rootNode, imports)) {
    const ownerId = classOwnersById.get(cls.node.id);
    if (!ownerId) continue;
    emitPlannedAccessors({
      planned: planAccessors(cls),
      filePath,
      ownerId,
      idPrefix: ownerIdNamePrefix(ownerId, filePath, cls.name),
      language: 'java',
      synthetic: 'lombok',
      result,
    });
  }

  return result;
}

function planLombokAccessorsForRoot(root: Parser.SyntaxNode): PlannedLombokAccessor[] {
  const imports = collectLombokImports(root);
  const out: PlannedLombokAccessor[] = [];
  for (const cls of findLombokClasses(root, imports)) {
    out.push(...planAccessors(cls));
  }
  return out;
}

/** Scope captures for Lombok accessors (dual-path parity with record components). */
export function synthesizeLombokAccessorCaptures(rootNode: Parser.SyntaxNode): CaptureMatch[] {
  return capturesForPlannedAccessors(planLombokAccessorsForRoot(rootNode), JAVA_TYPE_DECLS);
}
