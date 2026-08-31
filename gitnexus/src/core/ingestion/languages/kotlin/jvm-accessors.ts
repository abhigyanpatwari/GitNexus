/**
 * Kotlin property → JVM accessor synthesis.
 *
 * kotlinc emits JavaBeans getters/setters for `val`/`var` properties. Those
 * methods are absent from the tree-sitter AST, so Java (and Kotlin) calls
 * like `user.getName()` miss CALLS edges. Planning is Kotlin-specific;
 * naming and Method emission share `jvm/beanspec` + `jvm/synthetic-accessors`.
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
import {
  hasExistingAccessor,
  kotlinGetterName,
  kotlinSetterName,
  rememberExistingAccessor,
} from '../jvm/beanspec.js';
import {
  capturesForPlannedAccessors,
  emitPlannedAccessors,
  emptySyntheticAccessorResult,
  jvmTypeSimpleName,
  ownerIdNamePrefix,
  type PlannedJvmAccessor,
  type SyntheticAccessorResult,
  type SyntheticVisibility,
} from '../jvm/synthetic-accessors.js';

const KOTLIN_TYPE_DECLS = new Set(['class_declaration', 'object_declaration', 'companion_object']);

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
  properties: KtProperty[];
  existingMethods: Map<string, Set<number>>;
}

function annotationUserTypeText(annotation: Parser.SyntaxNode): string {
  const constructor = annotation.namedChildren.find((c) => c.type === 'constructor_invocation');
  const userType =
    constructor?.namedChildren.find((c) => c.type === 'user_type') ??
    annotation.namedChildren.find((c) => c.type === 'user_type');
  return userType?.text ?? '';
}

function isAnnotationNamed(annotation: Parser.SyntaxNode, name: string): boolean {
  const typeText = annotationUserTypeText(annotation);
  return typeText === name || typeText.endsWith(`.${name}`);
}

function kotlinVisibility(modifiers: Parser.SyntaxNode | null | undefined): SyntheticVisibility {
  if (!modifiers) return 'public';
  for (const child of modifiers.namedChildren) {
    if (child.type !== 'visibility_modifier') continue;
    if (child.text === 'private') return 'private';
    if (child.text === 'protected') return 'protected';
    if (child.text === 'internal') return 'package';
  }
  return 'public';
}

function hasJvmField(node: Parser.SyntaxNode): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  return (
    mods?.namedChildren.some(
      (child) => child.type === 'annotation' && isAnnotationNamed(child, 'JvmField'),
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

function propertyTypeText(node: Parser.SyntaxNode): string {
  const declarator =
    node.type === 'class_parameter'
      ? node
      : (node.children.find((c) => c.type === 'variable_declaration') ?? node);
  const colon = declarator.children.find((c) => c.type === ':');
  let typeNode = colon?.nextNamedSibling ?? null;
  while (typeNode?.type === 'type_modifiers') typeNode = typeNode.nextNamedSibling;
  return typeNode?.text ?? 'Any';
}

function propertyNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'class_parameter') {
    return node.children.find((c) => c.type === 'simple_identifier') ?? null;
  }
  const decl = node.children.find((c) => c.type === 'variable_declaration');
  if (decl) {
    return decl.children.find((c) => c.type === 'simple_identifier') ?? decl;
  }
  return node.children.find((c) => c.type === 'simple_identifier') ?? node;
}

function accessorMetadata(
  prop: Parser.SyntaxNode,
  propertyVisibility: SyntheticVisibility,
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
    if (annotation.type !== 'annotation' || !isAnnotationNamed(annotation, 'JvmName')) continue;
    const target = annotation.children.find((c) => c.type === 'use_site_target')?.text;
    if (target === 'get:') skipGetter = true;
    if (target === 'set:') skipSetter = true;
  }
  const apply = (node: Parser.SyntaxNode): void => {
    const modifiers = node.children.find((c) => c.type === 'modifiers');
    if (!modifiers) return;
    if (node.type === 'getter') getter = kotlinVisibility(modifiers);
    if (node.type === 'setter') setter = kotlinVisibility(modifiers);
    if (modifiers.namedChildren.some((annotation) => isAnnotationNamed(annotation, 'JvmName'))) {
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
  if (!params) return 0;
  let n = 0;
  for (const c of params.namedChildren) {
    if (c.type === 'parameter' || c.type === 'parameter_with_optional_type') n += 1;
  }
  return n;
}

function collectExistingMethods(body: Parser.SyntaxNode | null): Map<string, Set<number>> {
  const names = new Map<string, Set<number>>();
  if (!body) return names;
  for (const child of body.children) {
    if (child.type !== 'function_declaration') continue;
    const name = functionName(child);
    if (!name) continue;
    rememberExistingAccessor(names, name, functionArity(child));
  }
  return names;
}

function toKtProperty(child: Parser.SyntaxNode): KtProperty | null {
  const isVar = isVarBinding(child);
  if (isVar === null) return null;
  if (hasJvmField(child) || hasConst(child)) return null;
  const nameNode = propertyNameNode(child);
  if (!nameNode) return null;
  const mods = child.children.find((c) => c.type === 'modifiers') ?? null;
  const visibility = kotlinVisibility(mods);
  const accessor = accessorMetadata(child, visibility);
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

function collectTypedProperties(parent: Parser.SyntaxNode | null, type: string): KtProperty[] {
  if (!parent) return [];
  const out: KtProperty[] = [];
  for (const child of parent.namedChildren) {
    if (child.type !== type) continue;
    const prop = toKtProperty(child);
    if (prop) out.push(prop);
  }
  return out;
}

function findKtClasses(root: Parser.SyntaxNode): KtClass[] {
  const classes: KtClass[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    if (KOTLIN_TYPE_DECLS.has(node.type)) {
      const name = jvmTypeSimpleName(node) ?? (node.type === 'companion_object' ? 'Companion' : '');
      const ctor = node.children.find((c) => c.type === 'primary_constructor') ?? null;
      const body = node.children.find((c) => c.type === 'class_body') ?? null;
      if (name) {
        const properties = [
          ...collectTypedProperties(ctor, 'class_parameter'),
          ...collectTypedProperties(body, 'property_declaration'),
        ];
        if (properties.length > 0) {
          classes.push({
            node,
            name,
            properties,
            existingMethods: collectExistingMethods(body),
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
    if (!prop.skipGetter && !hasExistingAccessor(cls.existingMethods, gName, 0)) {
      planned.push({
        kind: 'getter',
        name: gName,
        returnType: prop.type,
        parameterTypes: [],
        visibility: prop.getterVisibility,
        startLine: prop.startLine,
        endLine: prop.endLine,
        classNode: cls.node,
        declaratorNode: prop.declaratorNode,
      });
    }
    if (prop.isVar && !prop.skipSetter) {
      const sName = kotlinSetterName(prop.name);
      if (!hasExistingAccessor(cls.existingMethods, sName, 1)) {
        planned.push({
          kind: 'setter',
          name: sName,
          returnType: 'void',
          parameterTypes: [prop.type],
          visibility: prop.setterVisibility,
          startLine: prop.startLine,
          endLine: prop.endLine,
          classNode: cls.node,
          declaratorNode: prop.declaratorNode,
        });
      }
    }
  }
  return planned;
}

export function synthesizeKotlinJvmAccessors(
  tree: Parser.Tree,
  filePath: string,
  classOwnersById: ReadonlyMap<number, string>,
): SyntheticAccessorResult {
  const result = emptySyntheticAccessorResult();
  for (const cls of findKtClasses(tree.rootNode)) {
    const ownerId = classOwnersById.get(cls.node.id);
    if (!ownerId) continue;
    emitPlannedAccessors({
      planned: planAccessors(cls),
      filePath,
      ownerId,
      idPrefix: ownerIdNamePrefix(ownerId, filePath, cls.name),
      language: 'kotlin',
      synthetic: 'kotlin-jvm',
      result,
    });
  }
  return result;
}

export function synthesizeKotlinJvmAccessorCaptures(rootNode: Parser.SyntaxNode): CaptureMatch[] {
  const planned: PlannedJvmAccessor[] = [];
  for (const cls of findKtClasses(rootNode)) planned.push(...planAccessors(cls));
  return capturesForPlannedAccessors(planned, KOTLIN_TYPE_DECLS);
}
