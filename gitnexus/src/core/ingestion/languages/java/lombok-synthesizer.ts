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
import { jvmGetterName, jvmSetterName } from '../jvm/beanspec.js';
import {
  createExistingMethodIndex,
  createJvmAccessorSynthesis,
  hasExistingMethod,
  rememberExistingMethodRange,
  type ExistingMethodIndex,
  type PlannedJvmAccessor,
  type PlannedJvmAccessorOwner,
  type SyntheticAccessorResult,
  type SyntheticVisibility,
} from '../jvm/accessor-synthesis.js';

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
  accessorsPresent: boolean;
}

interface LombokClass {
  node: Parser.SyntaxNode;
  name: string;
  classGetter: AccessorConfig | null;
  classSetter: AccessorConfig | null;
  classAccessors: AccessorsOptions;
  fields: LombokField[];
  existingMethods: ExistingMethodIndex;
}

const LOMBOK_ANNOTATION_PACKAGE = new Map<string, string>([
  ['Data', 'lombok'],
  ['Getter', 'lombok'],
  ['Setter', 'lombok'],
  ['Accessors', 'lombok.experimental'],
  ['Tolerate', 'lombok.experimental'],
]);

export function getterName(fieldName: string, fieldType: string): string {
  return jvmGetterName(fieldName, fieldType === 'boolean');
}

export function setterName(fieldName: string, fieldType: string): string {
  return jvmSetterName(fieldName, fieldType === 'boolean');
}

// ── Provenance / imports ──────────────────────────────────────────────────

function annotationSimpleName(nameText: string): string {
  return nameText.split('.').pop() ?? nameText;
}

interface LombokImportIndex {
  bySimple: Map<string, string>;
  starPackages: Set<string>;
  shadowedSimpleNames: Set<string>;
}

/**
 * Compilation-unit imports only — Java `import` is never nested in a type body.
 */
function collectLombokImports(root: Parser.SyntaxNode): LombokImportIndex {
  const bySimple = new Map<string, string>();
  const starPackages = new Set<string>();
  const shadowedSimpleNames = new Set<string>();
  for (const child of root.children) {
    if (!JAVA_TYPE_DECLS.has(child.type) && child.type !== 'annotation_type_declaration') continue;
    const name = child.childForFieldName('name')?.text;
    if (name) shadowedSimpleNames.add(name);
  }
  for (const child of root.children) {
    if (child.type !== 'import_declaration') continue;
    if (/^import\s+static\b/.test(child.text)) continue;
    const text = child.text
      .replace(/^import\s+/, '')
      .replace(/;\s*$/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, '')
      .trim();
    if (text === 'lombok.*') {
      starPackages.add('lombok');
    } else if (text === 'lombok.experimental.*') {
      starPackages.add('lombok.experimental');
    } else if (!text.endsWith('.*')) {
      bySimple.set(annotationSimpleName(text), text);
    }
  }
  return { bySimple, starPackages, shadowedSimpleNames };
}

function isProvenLombokAnnotation(nameText: string, imports: LombokImportIndex): boolean {
  const simple = annotationSimpleName(nameText);
  const packageName = LOMBOK_ANNOTATION_PACKAGE.get(simple);
  if (packageName === undefined) return false;
  if (nameText.includes('.')) return nameText === `${packageName}.${simple}`;
  const imported = imports.bySimple.get(simple);
  if (imported !== undefined) return imported === `${packageName}.${simple}`;
  if (imports.shadowedSimpleNames.has(simple)) return false;
  return imports.starPackages.has(packageName);
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
    const n = stack.pop();
    if (!n) break;
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
    const n = stack.pop();
    if (!n) break;
    if (n.type === 'element_value_pair') {
      const key =
        n.childForFieldName('key')?.text ?? n.children.find((c) => c.type === 'identifier')?.text;
      const valueNode =
        n.childForFieldName('value') ??
        n.children.find(
          (c) =>
            c.type === 'true' || c.type === 'false' || c.type === 'element_value_array_initializer',
        );
      if (key === 'fluent' && (valueNode?.type === 'true' || valueNode?.type === 'false')) {
        opts.fluent = valueNode.type === 'true';
      }
      if (key === 'chain' && (valueNode?.type === 'true' || valueNode?.type === 'false')) {
        opts.chain = valueNode.type === 'true';
      }
      if (key === 'prefix') opts.hasPrefix = true;
    }
    for (const c of n.children) stack.push(c);
  }
  const text = ann.text;
  if (/\bprefix\s*=/.test(text)) opts.hasPrefix = true;
  if (/\bfluent\s*=\s*true\b/.test(text)) opts.fluent = true;
  if (/\bfluent\s*=\s*false\b/.test(text)) opts.fluent = false;
  if (/\bchain\s*=\s*true\b/.test(text)) opts.chain = true;
  if (/\bchain\s*=\s*false\b/.test(text)) opts.chain = false;
  return opts;
}

interface ParsedAnnotations {
  getter: AccessorConfig | null;
  setter: AccessorConfig | null;
  accessors: AccessorsOptions;
  accessorsPresent: boolean;
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
    accessorsPresent: false,
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
      result.accessorsPresent = true;
      continue;
    }
    if (simple === 'Data') {
      result.getter ??= { enabled: true, visibility: 'public' };
      result.setter ??= { enabled: true, visibility: 'public' };
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
  fieldAccessorsPresent: boolean,
): AccessorsOptions {
  return fieldAccessorsPresent ? fieldOpts : classOpts;
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
      accessorsPresent: fieldAnn.accessorsPresent,
    });
  }
  return out;
}

function methodArityRange(methodNode: Parser.SyntaxNode): { min: number; max: number } {
  const params = methodNode.childForFieldName('parameters');
  if (!params) return { min: 0, max: 0 };
  let count = 0;
  for (const child of params.namedChildren) {
    if (child.type === 'spread_parameter') return { min: count, max: Number.POSITIVE_INFINITY };
    if (child.type === 'formal_parameter') count += 1;
  }
  return { min: count, max: count };
}

function collectExistingMethods(
  classBody: Parser.SyntaxNode | null,
  imports: LombokImportIndex,
): ExistingMethodIndex {
  const index = createExistingMethodIndex('case-folded');
  if (!classBody) return index;
  const scan = (container: Parser.SyntaxNode): void => {
    for (const child of container.children) {
      if (child.type === 'enum_body_declarations') {
        scan(child);
        continue;
      }
      if (child.type !== 'method_declaration') continue;
      const mods = child.children.find((c) => c.type === 'modifiers') ?? null;
      const ann = parseModifierAnnotations(mods, imports);
      if (ann.tolerate) continue;
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const arity = methodArityRange(child);
      rememberExistingMethodRange(index, nameNode.text, arity.min, arity.max);
    }
  };
  scan(classBody);
  return index;
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
    const accessors = mergeAccessors(cls.classAccessors, field.accessors, field.accessorsPresent);
    // fluent/prefix change names — omit rather than invent wrong names
    if (accessors.fluent || accessors.hasPrefix) continue;

    const getterCfg = effectiveAccessor(cls.classGetter, field.fieldGetter);
    const setterCfg = effectiveAccessor(cls.classSetter, field.fieldSetter);

    if (getterCfg?.enabled) {
      const gName = getterName(field.name, field.type);
      if (!hasExistingMethod(cls.existingMethods, gName, 0)) {
        planned.push({
          kind: 'getter',
          name: gName,
          returnType: field.type,
          parameterTypes: [],
          visibility: getterCfg.visibility,
          isStatic: false,
          isAbstract: false,
          startLine: field.startLine,
          endLine: field.endLine,
          declaratorNode: field.declaratorNode,
        });
      }
    }

    if (setterCfg?.enabled && !field.isFinal) {
      const sName = setterName(field.name, field.type);
      if (!hasExistingMethod(cls.existingMethods, sName, 1)) {
        // chain=true → setter returns declaring type; never emit void in that case
        const returnType = accessors.chain ? cls.name : 'void';
        planned.push({
          kind: 'setter',
          name: sName,
          returnType,
          parameterTypes: [field.type],
          visibility: setterCfg.visibility,
          isStatic: false,
          isAbstract: false,
          startLine: field.startLine,
          endLine: field.endLine,
          declaratorNode: field.declaratorNode,
        });
      }
    }
  }
  return planned;
}

function planLombokAccessorOwners(root: Parser.SyntaxNode): PlannedJvmAccessorOwner[] {
  const imports = collectLombokImports(root);
  return findLombokClasses(root, imports).map((cls) => ({
    node: cls.node,
    name: cls.name,
    accessors: planAccessors(cls),
  }));
}

const lombokAccessorSynthesis = createJvmAccessorSynthesis({
  language: 'java',
  synthetic: 'lombok',
  planOwners: planLombokAccessorOwners,
});

// ── Main API ──────────────────────────────────────────────────────────────

export function synthesizeLombokAccessors(
  tree: Parser.Tree,
  filePath: string,
  classOwnersById: ReadonlyMap<number, string>,
): LombokSynthesisResult {
  return lombokAccessorSynthesis.synthesize(tree, filePath, classOwnersById);
}

/** Scope captures for Lombok accessors (dual-path parity with record components). */
export function synthesizeLombokAccessorCaptures(rootNode: Parser.SyntaxNode): CaptureMatch[] {
  return lombokAccessorSynthesis.captures(rootNode);
}
