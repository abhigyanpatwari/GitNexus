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
 * - Proven `lombok.Data` / `lombok.Value` / `lombok.Getter` / `lombok.Setter`.
 * - Class- or field-level enable; `AccessLevel.NONE` disables.
 * - Default JavaBeans naming; primitive `boolean isX` → `isX` / `setX`.
 * - Access levels PUBLIC/PROTECTED/PRIVATE/PACKAGE.
 * - `@Value` and `@FieldDefaults(makeFinal=true)` make fields final (no setter)
 *   unless `@NonFinal`; unreadable FieldDefaults options suppress setters.
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
import { hasRecoveredSyntax } from '../../utils/ast-helpers.js';
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
  nonFinal: boolean;
  /** An unresolved field annotation may affect both accessors. */
  uncertain: boolean;
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
  ['Value', 'lombok'],
  ['Getter', 'lombok'],
  ['Setter', 'lombok'],
  ['RequiredArgsConstructor', 'lombok'],
  ['AllArgsConstructor', 'lombok'],
  ['NoArgsConstructor', 'lombok'],
  ['NonNull', 'lombok'],
  ['Builder', 'lombok'],
  ['Accessors', 'lombok.experimental'],
  ['FieldDefaults', 'lombok.experimental'],
  ['NonFinal', 'lombok.experimental'],
  ['SuperBuilder', 'lombok.experimental'],
  ['Tolerate', 'lombok.experimental'],
]);

/** Simple names of every Lombok annotation this provider models. */
export const LOMBOK_ANNOTATION_NAMES: ReadonlySet<string> = new Set(
  LOMBOK_ANNOTATION_PACKAGE.keys(),
);

/**
 * Other packages known to declare a simple name that a modelled annotation
 * also uses. Two type-import-on-demand declarations that both supply a name
 * used in the file do not compile, so an unrelated second wildcard (for
 * example `java.util.*` or `javax.persistence.*`) cannot change what the name
 * means. Only a package listed here refuses the wildcard proof. Same-package,
 * member, single-type and single-static-import shadows are modelled separately.
 */
const KNOWN_ON_DEMAND_DECLARERS = new Map<string, ReadonlySet<string>>([
  [
    'Value',
    new Set([
      'lombok',
      'org.springframework.beans.factory.annotation',
      'io.micronaut.context.annotation',
      'org.immutables.value',
    ]),
  ],
  [
    'NonNull',
    new Set([
      'lombok',
      'org.springframework.lang',
      'androidx.annotation',
      'android.support.annotation',
      'edu.umd.cs.findbugs.annotations',
      'org.checkerframework.checker.nullness.qual',
      'org.eclipse.jdt.annotation',
      'io.micronaut.core.annotation',
      'reactor.util.annotation',
      'io.reactivex.annotations',
      'io.reactivex.rxjava3.annotations',
    ]),
  ],
  ['Builder', new Set(['lombok', 'org.immutables.builder'])],
  [
    'Qualifier',
    new Set(['org.springframework.beans.factory.annotation', 'javax.inject', 'jakarta.inject']),
  ],
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

export interface LombokImportIndex {
  bySimple: Map<string, string>;
  starPackages: Set<string>;
  shadowedSimpleNames: Set<string>;
  /**
   * Simple names of single-static-imports. One that imports a static member
   * type hides wildcards; one that imports only fields or methods does not.
   */
  staticImportedSimpleNames: Set<string>;
  /** Compilation-unit lifetime only; never retained across AST edits. */
  memberTypeNamesByOwner: ReadonlyMap<number, ReadonlySet<string>>;
  workspaceProof?: JavaLombokWorkspaceProof;
}

/**
 * Annotation identity: `true` proven, `false` refused, `uncertain` when an
 * unresolved inherited scope might hide the name. An uncertain annotation
 * must neither enable a member nor let a class-level default fall through.
 */
export type JavaAnnotationProof = boolean | 'uncertain';

/** A derived veto, used only while one compilation unit is being re-extracted. */
export type JavaLombokAnnotationWorkspaceProof = (
  writtenName: string,
  qualifiedName: string,
  context: Parser.SyntaxNode | undefined,
) => JavaAnnotationProof;

/** Workspace facts, used only while one compilation unit is being re-extracted. */
export interface JavaLombokWorkspaceProof {
  readonly annotation: JavaLombokAnnotationWorkspaceProof;
  /**
   * Whether this file's single-static-import of a simple name imports a
   * member type (`true`), only fields or methods (`false`), or cannot be
   * decided (`uncertain`).
   */
  readonly staticImportsType: (simpleName: string) => JavaAnnotationProof;
}

let activeWorkspaceProof:
  | {
      tree: Parser.Tree;
      proof: JavaLombokWorkspaceProof;
    }
  | undefined;

/** Synchronous, exception-safe context; no tree or proof survives this call. */
export function withJavaLombokWorkspaceProof<T>(
  tree: Parser.Tree,
  proof: JavaLombokWorkspaceProof,
  run: () => T,
): T {
  const previous = activeWorkspaceProof;
  activeWorkspaceProof = { tree, proof };
  try {
    return run();
  } finally {
    activeWorkspaceProof = previous;
  }
}

/** Member type declarations of a type body, including those after an enum's constants. */
export function javaMemberTypeDeclarations(body: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const members: Parser.SyntaxNode[] = [];
  for (const member of body?.namedChildren ?? []) {
    if (member.type === 'enum_body_declarations') {
      members.push(...javaMemberTypeDeclarations(member));
    } else if (JAVA_TYPE_DECLS.has(member.type) || member.type === 'annotation_type_declaration') {
      members.push(member);
    }
  }
  return members;
}

/**
 * Compilation-unit imports only — Java `import` is never nested in a type body.
 */
export function collectLombokImports(root: Parser.SyntaxNode): LombokImportIndex {
  const bySimple = new Map<string, string>();
  const starPackages = new Set<string>();
  const shadowedSimpleNames = new Set<string>();
  const staticImportedSimpleNames = new Set<string>();
  const memberTypeNamesByOwner = new Map<number, Set<string>>();
  for (const owner of root.descendantsOfType([...JAVA_TYPE_DECLS, 'annotation_type_declaration'])) {
    const names = new Set<string>();
    for (const member of javaMemberTypeDeclarations(owner.childForFieldName('body'))) {
      const name = member.childForFieldName('name');
      if (name !== null) names.add(name.text);
    }
    if (names.size > 0) memberTypeNamesByOwner.set(owner.id, names);
  }
  for (const child of root.children) {
    if (!JAVA_TYPE_DECLS.has(child.type) && child.type !== 'annotation_type_declaration') continue;
    const name = child.childForFieldName('name')?.text;
    if (name) shadowedSimpleNames.add(name);
  }
  for (const child of root.children) {
    if (child.type !== 'import_declaration') continue;
    const nameNode = child.namedChildren.find(
      (part) => part.type === 'scoped_identifier' || part.type === 'identifier',
    );
    if (nameNode === undefined) continue;
    const text = nameNode.text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, '');
    const wildcard = child.namedChildren.some((part) => part.type === 'asterisk');
    if (child.children.some((part) => part.type === 'static')) {
      // `import static a.Tags.Value;` may import a member type named Value,
      // which shadows every type-import-on-demand (JLS 6.4.1), or only a
      // field or method, which does not. A static wildcard is itself
      // on-demand and cannot shadow `lombok.*`.
      if (!wildcard) staticImportedSimpleNames.add(annotationSimpleName(text));
      // Builder.Default is a known member type. A static import can bring it
      // into scope through either the member name or Builder's wildcard.
      if (wildcard ? text !== 'lombok.Builder' : text !== 'lombok.Builder.Default') continue;
    }
    if (wildcard) {
      starPackages.add(text);
    } else {
      bySimple.set(annotationSimpleName(text), text);
    }
  }
  return {
    bySimple,
    starPackages,
    shadowedSimpleNames,
    staticImportedSimpleNames,
    memberTypeNamesByOwner,
    ...(activeWorkspaceProof?.tree === root.tree
      ? { workspaceProof: activeWorkspaceProof.proof }
      : {}),
  };
}

/** Tri-state Lombok identity; see {@link JavaAnnotationProof}. */
export function lombokAnnotationProof(
  nameText: string,
  imports: LombokImportIndex,
  context?: Parser.SyntaxNode,
): JavaAnnotationProof {
  const simple = annotationSimpleName(nameText);
  const packageName = LOMBOK_ANNOTATION_PACKAGE.get(simple);
  if (packageName === undefined) return false;
  return javaAnnotationProof(nameText, `${packageName}.${simple}`, imports, context);
}

/** A possible Builder.Default affects the generated constructor's parameter list. */
export function mayBeLombokBuilderDefault(
  annotation: Parser.SyntaxNode,
  imports: LombokImportIndex,
): boolean {
  const name = annotation.childForFieldName('name');
  if (name === null) return false;
  const written =
    name.type === 'identifier'
      ? name.text
      : name
          .descendantsOfType('identifier')
          .map((part) => part.text)
          .join('.');
  if (written === 'Builder.Default')
    return lombokAnnotationProof('Builder', imports, annotation) !== false;
  if (written !== 'Default' && written !== 'lombok.Builder.Default') return false;
  return javaAnnotationProof(written, 'lombok.Builder.Default', imports, annotation) !== false;
}

/** Shared Java-local annotation proof for accessors and generated constructors. */
export function isProvenJavaAnnotation(
  nameText: string,
  qualifiedName: string,
  imports: LombokImportIndex,
  context?: Parser.SyntaxNode,
): boolean {
  return javaAnnotationProof(nameText, qualifiedName, imports, context) === true;
}

/** File-local proof, narrowed by the workspace veto when one is active. */
function javaAnnotationProof(
  nameText: string,
  qualifiedName: string,
  imports: LombokImportIndex,
  context?: Parser.SyntaxNode,
): JavaAnnotationProof {
  const workspace = imports.workspaceProof?.annotation(nameText, qualifiedName, context) ?? true;
  if (workspace === false) return false;
  const local = isLocallyProvenJavaAnnotation(nameText, qualifiedName, imports, context);
  if (local === false) return false;
  return local === 'uncertain' ? 'uncertain' : workspace;
}

function isLocallyProvenJavaAnnotation(
  nameText: string,
  qualifiedName: string,
  imports: LombokImportIndex,
  context?: Parser.SyntaxNode,
): JavaAnnotationProof {
  if (nameText.includes('.')) {
    const root = nameText.split('.')[0]!;
    if (
      imports.bySimple.has(root) ||
      imports.shadowedSimpleNames.has(root) ||
      imports.staticImportedSimpleNames.has(root)
    )
      return false;
    for (
      let owner = context;
      owner !== undefined && owner !== null;
      owner = owner.parent ?? undefined
    ) {
      const body = owner.childForFieldName('body');
      if (context !== undefined && body !== null && context.startIndex < body.startIndex) continue;
      if (imports.memberTypeNamesByOwner.get(owner.id)?.has(root)) return false;
    }
    return nameText === qualifiedName;
  }
  const simple = annotationSimpleName(qualifiedName);
  if (nameText !== simple || imports.shadowedSimpleNames.has(simple)) return false;
  // A member annotation/type hides imports in nested type bodies as well.
  for (
    let owner = context;
    owner !== undefined && owner !== null;
    owner = owner.parent ?? undefined
  ) {
    if (!JAVA_TYPE_DECLS.has(owner.type) && owner.type !== 'annotation_type_declaration') continue;
    if (owner.childForFieldName('name')?.text === simple) return false;
    const body = owner.childForFieldName('body');
    if (context !== undefined && body !== null && context.startIndex < body.startIndex) continue;
    if (imports.memberTypeNamesByOwner.get(owner.id)?.has(simple)) return false;
  }
  const imported = imports.bySimple.get(simple);
  if (imported !== undefined) return imported === qualifiedName;
  const packageName = qualifiedName.slice(0, qualifiedName.lastIndexOf('.'));
  if (!imports.starPackages.has(packageName)) return false;
  // Refuse only a second wildcard package known to declare the same name.
  const declarers = KNOWN_ON_DEMAND_DECLARERS.get(simple);
  for (const other of imports.starPackages) {
    if (other !== packageName && declarers?.has(other) === true) return false;
  }
  if (!imports.staticImportedSimpleNames.has(simple)) return true;
  // Only an imported member type shadows the wildcard; a static field or
  // method is an expression name (JLS 6.4.1, 7.5.3). The file alone cannot
  // tell them apart, so only the workspace owner can decide.
  const importsType = imports.workspaceProof?.staticImportsType(simple) ?? 'uncertain';
  return importsType === 'uncertain' ? 'uncertain' : !importsType;
}

/**
 * `@FieldDefaults` makeFinal as written: `false` for the default, `undefined`
 * when the options cannot be read exactly (constants, unknown elements or
 * recovered syntax). `level` changes field access only, never members.
 */
export function readLombokFieldDefaultsMakeFinal(
  annotation: Parser.SyntaxNode,
): boolean | undefined {
  if (annotation.type === 'marker_annotation') return false;
  const argumentsNode = annotation.childForFieldName('arguments');
  if (argumentsNode === null || hasRecoveredSyntax(annotation)) return undefined;
  let makeFinal = false;
  for (const child of argumentsNode.namedChildren) {
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    if (child.type !== 'element_value_pair') return undefined;
    const key = child.childForFieldName('key')?.text;
    const value = child.childForFieldName('value');
    if (key === 'level' && value !== null) continue;
    if (key === 'makeFinal' && (value?.type === 'true' || value?.type === 'false')) {
      makeFinal = value.type === 'true';
      continue;
    }
    return undefined;
  }
  return makeFinal;
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
  value: boolean;
  nonFinal: boolean;
  /** `@FieldDefaults` makes fields final: true when proven or unreadable. */
  makeFinal: boolean;
  /** An unresolved annotation can affect more than one accessor. */
  uncertain: boolean;
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
    value: false,
    nonFinal: false,
    makeFinal: false,
    uncertain: false,
  };
  if (!modifiersNode) return result;

  let uncertainGetter = false;
  let uncertainSetter = false;
  for (const child of modifiersNode.children) {
    if (child.type !== 'marker_annotation' && child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    const nameText = nameNode?.text ?? '';
    const proof = lombokAnnotationProof(nameText, imports, modifiersNode);
    if (proof === false) continue;
    const simple = annotationSimpleName(nameText);
    if (proof === 'uncertain') {
      if (simple === 'Getter') uncertainGetter = true;
      else if (simple === 'Setter') uncertainSetter = true;
      else result.uncertain = true;
      continue;
    }

    if (simple === 'Tolerate') {
      result.tolerate = true;
      continue;
    }
    if (simple === 'NonFinal') {
      result.nonFinal = true;
      continue;
    }
    if (simple === 'FieldDefaults') {
      // An unreadable makeFinal may add `final`: never let it enable a setter.
      result.makeFinal = readLombokFieldDefaultsMakeFinal(child) !== false;
      continue;
    }
    if (simple === 'Value') {
      result.value = true;
      result.getter ??= { enabled: true, visibility: 'public' };
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
  // Each override can suppress its own accessor, regardless of annotation order.
  if (uncertainGetter) result.getter = { enabled: false, visibility: 'public' };
  if (uncertainSetter) result.setter = { enabled: false, visibility: 'public' };
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
      type: fieldType + (declaratorNode.childForFieldName('dimensions')?.text ?? ''),
      isStatic,
      isFinal,
      startLine,
      endLine,
      declaratorNode,
      fieldGetter: fieldAnn.getter,
      fieldSetter: fieldAnn.setter,
      accessors: fieldAnn.accessors,
      accessorsPresent: fieldAnn.accessorsPresent,
      nonFinal: fieldAnn.nonFinal,
      uncertain: fieldAnn.uncertain,
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

  // The native search retains source order and includes local/nested types,
  // without allocating wrappers for every expression and token in their bodies.
  for (const node of root.descendantsOfType(['class_declaration', 'enum_declaration'])) {
    const modifiers = node.children.find((c) => c.type === 'modifiers') ?? null;
    const classAnn = parseModifierAnnotations(modifiers, imports);
    const nameNode = node.childForFieldName('name');
    const className = nameNode?.text ?? '';
    // An uncertain class-level annotation could be a suppressing one.
    if (className && !classAnn.uncertain) {
      const body = findTypeBody(node);
      const fields: LombokField[] = [];
      if (body) {
        const collectFields = (container: Parser.SyntaxNode): void => {
          for (const child of container.children) {
            if (child.type === 'field_declaration') {
              for (const f of parseFieldDeclaration(child, imports)) {
                if (f.isStatic || f.uncertain) continue;
                if (
                  classAnn.value &&
                  f.name.startsWith('$') &&
                  f.fieldGetter === null &&
                  f.fieldSetter === null
                )
                  continue;
                if ((classAnn.value || classAnn.makeFinal) && !f.nonFinal) f.isFinal = true;
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
