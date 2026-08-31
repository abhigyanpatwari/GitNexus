/**
 * Kotlin accessor synthesizer (same provider-hook role as Java Lombok).
 *
 * kotlinc emits JavaBeans getters/setters for `val`/`var` properties. Those
 * methods are absent from the tree-sitter AST, so Java (and Kotlin) calls
 * like `user.getName()` miss CALLS edges. Planning is Kotlin-specific;
 * naming and Method emission share `jvm/beanspec` + `jvm/accessor-synthesis`.
 *
 * ## Supported subset (v1)
 * - Class / data class / object / companion `val`/`var` properties.
 * - Primary-constructor `val`/`var` class parameters.
 * - Names beginning with `is` + a non-lowercase character keep that getter name; all other
 *   properties, including `Boolean`, use `get`.
 * - Custom `get()`/`set()` bodies still emit their JVM accessor Methods.
 * - Explicit `fun getX` / `@JvmField` / `const` skip synthesis.
 * - `@JvmName`-renamed accessors are suppressed until custom-name emission lands.
 * Unsupported: `@JvmStatic` renaming, file-facade top-level properties.
 */
import type Parser from 'tree-sitter';
import type { CaptureMatch } from 'gitnexus-shared';
import { booleanIsPrefixBase, jvmGetterName, jvmSetterName } from '../jvm/beanspec.js';
import {
  createExistingMethodIndex,
  createJvmAccessorSynthesis,
  hasExistingMethod,
  jvmTypeSimpleName,
  rememberExistingMethod,
  type ExistingMethodIndex,
  type PlannedJvmAccessor,
  type PlannedJvmAccessorOwner,
  type SyntheticAccessorResult,
  type SyntheticVisibility,
} from '../jvm/accessor-synthesis.js';

const KOTLIN_TYPE_DECLS = new Set(['class_declaration', 'object_declaration', 'companion_object']);

function capitalizeAscii(name: string): string {
  const first = name.charAt(0);
  return first >= 'a' && first <= 'z'
    ? String.fromCharCode(first.charCodeAt(0) - 32) + name.slice(1)
    : name;
}

export function kotlinGetterName(propertyName: string): string {
  return jvmGetterName(
    propertyName,
    booleanIsPrefixBase(propertyName, true) !== null,
    capitalizeAscii,
  );
}

export function kotlinSetterName(propertyName: string): string {
  return jvmSetterName(propertyName, true, capitalizeAscii);
}

interface KtProperty {
  name: string;
  type: string;
  isVar: boolean;
  skipGetter: boolean;
  skipSetter: boolean;
  getterVisibility: SyntheticVisibility;
  setterVisibility: SyntheticVisibility;
  startLine: number;
  endLine: number;
  declaratorNode: Parser.SyntaxNode;
}

interface KtClass {
  node: Parser.SyntaxNode;
  name: string;
  isStatic: boolean;
  wasHoisted: boolean;
  properties: KtProperty[];
  existingMethods: ExistingMethodIndex;
}

interface KotlinImportIndex {
  byLocalName: Map<string, string>;
  shadowedSimpleNames: Set<string>;
}

function collectKotlinImports(root: Parser.SyntaxNode): KotlinImportIndex {
  const byLocalName = new Map<string, string>();
  const shadowedSimpleNames = new Set<string>();
  for (const child of root.children) {
    if (child.type !== 'class_declaration') continue;
    const name = jvmTypeSimpleName(child);
    if (name) shadowedSimpleNames.add(name);
  }
  const importList = root.children.find((child) => child.type === 'import_list');
  for (const child of importList?.children ?? []) {
    if (child.type !== 'import_header') continue;
    const text = child.text
      .replace(/^import\s+/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    const [pathText, aliasText] = text.split(/\s+as\s+/, 2);
    const importPath = pathText?.replace(/\s+/g, '');
    if (!importPath || importPath.endsWith('.*')) continue;
    const localName = aliasText?.trim() || importPath.split('.').pop();
    if (localName) byLocalName.set(localName, importPath);
  }
  return { byLocalName, shadowedSimpleNames };
}

function annotationUserTypeText(annotation: Parser.SyntaxNode): string {
  const constructor = annotation.namedChildren.find((c) => c.type === 'constructor_invocation');
  const userType =
    constructor?.namedChildren.find((c) => c.type === 'user_type') ??
    annotation.namedChildren.find((c) => c.type === 'user_type');
  return userType?.text ?? '';
}

function isKotlinJvmAnnotation(
  annotation: Parser.SyntaxNode,
  name: string,
  imports: KotlinImportIndex,
): boolean {
  const typeText = annotationUserTypeText(annotation);
  const canonical = `kotlin.jvm.${name}`;
  if (typeText.includes('.')) return typeText === canonical;
  const imported = imports.byLocalName.get(typeText);
  if (imported !== undefined) return imported === canonical;
  if (imports.shadowedSimpleNames.has(typeText)) return false;
  return typeText === name;
}

function kotlinVisibility(modifiers: Parser.SyntaxNode | undefined): SyntheticVisibility {
  if (!modifiers) return 'public';
  for (const child of modifiers.namedChildren) {
    if (child.type !== 'visibility_modifier') continue;
    if (child.text === 'private') return 'private';
    if (child.text === 'protected') return 'protected';
    if (child.text === 'internal') return 'package';
  }
  return 'public';
}

function hasJvmField(node: Parser.SyntaxNode, imports: KotlinImportIndex): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  return (
    mods?.namedChildren.some(
      (child) => child.type === 'annotation' && isKotlinJvmAnnotation(child, 'JvmField', imports),
    ) === true
  );
}

function hasConst(node: Parser.SyntaxNode): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  if (
    mods?.namedChildren.some(
      (child) => child.type === 'property_modifier' && child.text === 'const',
    )
  ) {
    return true;
  }
  return node.namedChildren.some((child) => child.type === 'const');
}

function isVarBinding(node: Parser.SyntaxNode): boolean | null {
  const kind = node.children.find((c) => c.type === 'binding_pattern_kind');
  const text = kind?.text;
  if (text === 'var') return true;
  if (text === 'val') return false;
  return null;
}

function inferredInitializerType(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case 'string_literal':
    case 'line_string_literal':
    case 'multi_line_string_literal':
      return 'String';
    case 'character_literal':
      return 'Char';
    case 'boolean_literal':
    case 'true':
    case 'false':
      return 'Boolean';
    case 'long_literal':
      return 'Long';
    case 'unsigned_literal':
      return /l$/i.test(node.text) ? 'ULong' : 'UInt';
    case 'integer_literal':
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'octal_integer_literal':
    case 'binary_integer_literal':
      return 'Int';
    case 'real_literal':
    case 'decimal_floating_point_literal':
      return /f$/i.test(node.text) ? 'Float' : 'Double';
    case 'prefix_expression': {
      const operand = node.namedChildren.at(-1);
      return operand ? inferredInitializerType(operand) : undefined;
    }
    case 'call_expression': {
      const callee = node.namedChildren.find((child) => child.type === 'simple_identifier');
      if (!callee) return undefined;
      const first = callee.text.charAt(0);
      return first !== '' && first === first.toUpperCase() ? callee.text : undefined;
    }
    default:
      return undefined;
  }
}

function propertyTypeText(node: Parser.SyntaxNode): string {
  const declarator =
    node.type === 'class_parameter'
      ? node
      : (node.children.find((c) => c.type === 'variable_declaration') ?? node);
  const colon = declarator.children.find((c) => c.type === ':');
  let typeNode = colon?.nextNamedSibling ?? null;
  while (typeNode?.type === 'type_modifiers') typeNode = typeNode.nextNamedSibling;
  if (typeNode) return typeNode.text;
  const initializer = node.namedChildren.find(
    (child) =>
      child.id !== declarator.id &&
      child.type !== 'binding_pattern_kind' &&
      child.type !== 'modifiers',
  );
  return initializer ? (inferredInitializerType(initializer) ?? 'unknown') : 'unknown';
}

function propertyNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'class_parameter') {
    return node.children.find((c) => c.type === 'simple_identifier') ?? null;
  }
  const decl = node.children.find((c) => c.type === 'variable_declaration');
  if (decl) {
    return decl.children.find((c) => c.type === 'simple_identifier') ?? null;
  }
  return node.children.find((c) => c.type === 'simple_identifier') ?? null;
}

function accessorMetadata(
  prop: Parser.SyntaxNode,
  propertyVisibility: SyntheticVisibility,
  imports: KotlinImportIndex,
): {
  getterVisibility: SyntheticVisibility;
  setterVisibility: SyntheticVisibility;
  skipGetter: boolean;
  skipSetter: boolean;
} {
  let getter = propertyVisibility;
  let setter = propertyVisibility;
  let skipGetter = false;
  let skipSetter = false;
  const propertyModifiers = prop.children.find((c) => c.type === 'modifiers');
  for (const annotation of propertyModifiers?.namedChildren ?? []) {
    if (
      annotation.type !== 'annotation' ||
      !isKotlinJvmAnnotation(annotation, 'JvmName', imports)
    ) {
      continue;
    }
    const target = annotation.children.find((c) => c.type === 'use_site_target')?.text;
    if (target === 'get:') skipGetter = true;
    if (target === 'set:') skipSetter = true;
  }
  const apply = (node: Parser.SyntaxNode): void => {
    const modifiers = node.children.find((c) => c.type === 'modifiers');
    if (!modifiers) return;
    if (node.type === 'getter') getter = kotlinVisibility(modifiers);
    if (node.type === 'setter') setter = kotlinVisibility(modifiers);
    if (
      modifiers.namedChildren.some((annotation) =>
        isKotlinJvmAnnotation(annotation, 'JvmName', imports),
      )
    ) {
      if (node.type === 'getter') skipGetter = true;
      if (node.type === 'setter') skipSetter = true;
    }
  };
  for (const child of prop.children) {
    if (child.type === 'getter' || child.type === 'setter') apply(child);
  }
  let sib: Parser.SyntaxNode | null = prop.nextNamedSibling;
  while (sib && (sib.type === 'getter' || sib.type === 'setter')) {
    apply(sib);
    sib = sib.nextNamedSibling;
  }
  return {
    getterVisibility: getter,
    setterVisibility: setter,
    skipGetter,
    skipSetter,
  };
}

function functionName(node: Parser.SyntaxNode): string | undefined {
  return node.children.find((c) => c.type === 'simple_identifier')?.text;
}

function functionArity(node: Parser.SyntaxNode): number {
  const params = node.children.find((c) => c.type === 'function_value_parameters');
  let arity =
    node.childForFieldName('receiver') !== null ||
    node.namedChildren.some((child) => child.type === 'receiver_type')
      ? 1
      : 0;
  const modifiers = node.children.find((child) => child.type === 'modifiers');
  if (
    modifiers?.namedChildren.some(
      (child) => child.type === 'function_modifier' && child.text === 'suspend',
    )
  ) {
    arity += 1;
  }
  for (const child of params?.namedChildren ?? []) {
    if (child.type === 'parameter' || child.type === 'parameter_with_optional_type') arity += 1;
  }
  return arity;
}

function collectExistingMethods(...bodies: Array<Parser.SyntaxNode | null>): ExistingMethodIndex {
  const index = createExistingMethodIndex('exact');
  for (const body of bodies) {
    if (!body) continue;
    for (const child of body.children) {
      if (child.type !== 'function_declaration') continue;
      const name = functionName(child);
      if (!name) continue;
      rememberExistingMethod(index, name, functionArity(child));
    }
  }
  return index;
}

function toKtProperty(child: Parser.SyntaxNode, imports: KotlinImportIndex): KtProperty | null {
  const isVar = isVarBinding(child);
  if (isVar === null) return null;
  if (hasJvmField(child, imports) || hasConst(child)) return null;
  const nameNode = propertyNameNode(child);
  if (!nameNode) return null;
  const mods = child.children.find((c) => c.type === 'modifiers');
  const visibility = kotlinVisibility(mods);
  const accessor = accessorMetadata(child, visibility, imports);
  return {
    name: nameNode.text,
    type: propertyTypeText(child),
    isVar,
    skipGetter: accessor.skipGetter,
    skipSetter: accessor.skipSetter,
    getterVisibility: accessor.getterVisibility,
    setterVisibility: accessor.setterVisibility,
    startLine: child.startPosition.row + 1,
    endLine: child.endPosition.row + 1,
    declaratorNode: nameNode,
  };
}

function collectTypedProperties(
  parent: Parser.SyntaxNode | null,
  type: 'class_parameter' | 'property_declaration',
  imports: KotlinImportIndex,
): KtProperty[] {
  if (!parent) return [];
  const out: KtProperty[] = [];
  for (const child of parent.namedChildren) {
    if (child.type !== type) continue;
    const prop = toKtProperty(child, imports);
    if (prop) out.push(prop);
  }
  return out;
}

function findKtClasses(root: Parser.SyntaxNode, imports: KotlinImportIndex): KtClass[] {
  const classes: KtClass[] = [];
  const graphOwnerNode = (node: Parser.SyntaxNode): Parser.SyntaxNode => {
    if (node.type !== 'companion_object') return node;
    if (jvmTypeSimpleName(node)) return node;
    let current = node.parent;
    while (current && !KOTLIN_TYPE_DECLS.has(current.type)) current = current.parent;
    return current ?? node;
  };
  const walk = (node: Parser.SyntaxNode): void => {
    if (KOTLIN_TYPE_DECLS.has(node.type)) {
      const ownerNode = graphOwnerNode(node);
      const name = jvmTypeSimpleName(ownerNode) ?? '';
      const ctor = node.children.find((c) => c.type === 'primary_constructor') ?? null;
      const body = node.children.find((c) => c.type === 'class_body') ?? null;
      if (name) {
        const properties = [
          ...collectTypedProperties(ctor, 'class_parameter', imports),
          ...collectTypedProperties(body, 'property_declaration', imports),
        ];
        if (properties.length > 0) {
          const ownerBody =
            ownerNode.id === node.id
              ? null
              : (ownerNode.children.find((child) => child.type === 'class_body') ?? null);
          classes.push({
            node: ownerNode,
            name,
            isStatic: node.type === 'companion_object',
            wasHoisted: ownerNode.id !== node.id,
            properties,
            existingMethods: collectExistingMethods(body, ownerBody),
          });
        }
      }
      if (body) {
        for (const child of body.namedChildren) {
          if (KOTLIN_TYPE_DECLS.has(child.type)) walk(child);
        }
      }
      return;
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return classes;
}

function planAccessors(cls: KtClass): PlannedJvmAccessor[] {
  const planned: PlannedJvmAccessor[] = [];
  for (const prop of cls.properties) {
    const gName = kotlinGetterName(prop.name);
    if (!prop.skipGetter && !hasExistingMethod(cls.existingMethods, gName, 0)) {
      planned.push({
        kind: 'getter',
        name: gName,
        returnType: prop.type,
        parameterTypes: [],
        visibility: prop.getterVisibility,
        isStatic: cls.isStatic,
        startLine: prop.startLine,
        endLine: prop.endLine,
        declaratorNode: prop.declaratorNode,
      });
    }
    if (prop.isVar && !prop.skipSetter) {
      const sName = kotlinSetterName(prop.name);
      if (!hasExistingMethod(cls.existingMethods, sName, 1)) {
        planned.push({
          kind: 'setter',
          name: sName,
          returnType: 'void',
          parameterTypes: [prop.type],
          visibility: prop.setterVisibility,
          isStatic: cls.isStatic,
          startLine: prop.startLine,
          endLine: prop.endLine,
          declaratorNode: prop.declaratorNode,
        });
      }
    }
  }
  return planned;
}

function planKotlinAccessorOwners(rootNode: Parser.SyntaxNode): PlannedJvmAccessorOwner[] {
  const owners: PlannedJvmAccessorOwner[] = [];
  const imports = collectKotlinImports(rootNode);
  for (const cls of findKtClasses(rootNode, imports)) {
    const accessors = planAccessors(cls);
    const existingIndex = cls.wasHoisted
      ? owners.findIndex((owner) => owner.node.id === cls.node.id)
      : -1;
    const existing = existingIndex >= 0 ? owners[existingIndex] : undefined;
    if (existing) {
      owners[existingIndex] = {
        ...existing,
        accessors: [...existing.accessors, ...accessors],
      };
    } else {
      owners.push({ node: cls.node, name: cls.name, accessors });
    }
  }
  return owners;
}

const lombokAccessorSynthesis = createJvmAccessorSynthesis({
  language: 'kotlin',
  synthetic: 'kotlin-jvm',
  planOwners: planKotlinAccessorOwners,
});

export function synthesizeLombokAccessors(
  tree: Parser.Tree,
  filePath: string,
  classOwnersById: ReadonlyMap<number, string>,
): SyntheticAccessorResult {
  return lombokAccessorSynthesis.synthesize(tree, filePath, classOwnersById);
}

export function synthesizeLombokAccessorCaptures(rootNode: Parser.SyntaxNode): CaptureMatch[] {
  return lombokAccessorSynthesis.captures(rootNode);
}
