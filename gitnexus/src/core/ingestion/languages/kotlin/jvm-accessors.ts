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
 * - Non-null `Boolean` uses the `is` prefix; `Boolean?` uses `get`.
 * - Explicit `fun getX` / custom `get()`/`set()` / `@JvmField` / `const` skip.
 * Unsupported: `@JvmName`, `@JvmStatic` renaming, file-facade top-level properties.
 */
import type Parser from 'tree-sitter';
import type { CaptureMatch } from 'gitnexus-shared';
import {
  hasExistingAccessor,
  jvmGetterName,
  jvmSetterName,
  kotlinUsesIsPrefix,
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
  visibility: SyntheticVisibility;
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

function kotlinVisibility(modifiers: Parser.SyntaxNode | null | undefined): SyntheticVisibility {
  if (!modifiers) return 'public';
  const text = modifiers.text;
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  if (/\binternal\b/.test(text)) return 'package';
  return 'public';
}

function hasJvmField(node: Parser.SyntaxNode): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  if (!mods) return false;
  return mods.text.includes('JvmField');
}

function hasConst(node: Parser.SyntaxNode): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  if (mods?.text.includes('const')) return true;
  return node.children.some((c) => c.type === 'const' || c.text === 'const');
}

function isVarBinding(node: Parser.SyntaxNode): boolean | null {
  const kind = node.children.find((c) => c.type === 'binding_pattern_kind');
  const text = kind?.text;
  if (text === 'var') return true;
  if (text === 'val') return false;
  return null;
}

function propertyTypeText(node: Parser.SyntaxNode): string {
  const walk = (n: Parser.SyntaxNode): string | null => {
    if (n.type === 'nullable_type') return n.text;
    if (n.type === 'user_type' || n.type === 'type_identifier' || n.type === 'generic_type') {
      return n.text;
    }
    for (const c of n.namedChildren) {
      const inner = walk(c);
      if (inner) return inner;
    }
    return null;
  };
  return walk(node) ?? 'Any';
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

function customAccessors(prop: Parser.SyntaxNode): { getter: boolean; setter: boolean } {
  let getter = prop.children.some((c) => c.type === 'getter');
  let setter = prop.children.some((c) => c.type === 'setter');
  let sib: Parser.SyntaxNode | null = prop.nextNamedSibling;
  while (sib && (sib.type === 'getter' || sib.type === 'setter')) {
    if (sib.type === 'getter') getter = true;
    if (sib.type === 'setter') setter = true;
    sib = sib.nextNamedSibling;
  }
  return { getter, setter };
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

function collectClassParameters(ctor: Parser.SyntaxNode | null): KtProperty[] {
  if (!ctor) return [];
  const out: KtProperty[] = [];
  for (const child of ctor.namedChildren) {
    if (child.type !== 'class_parameter') continue;
    const isVar = isVarBinding(child);
    if (isVar === null) continue;
    if (hasJvmField(child) || hasConst(child)) continue;
    const nameNode = propertyNameNode(child);
    if (!nameNode) continue;
    const mods = child.children.find((c) => c.type === 'modifiers') ?? null;
    out.push({
      name: nameNode.text,
      type: propertyTypeText(child),
      isVar,
      skipGetter: false,
      skipSetter: false,
      visibility: kotlinVisibility(mods),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      declaratorNode: nameNode,
    });
  }
  return out;
}

function collectBodyProperties(body: Parser.SyntaxNode | null): KtProperty[] {
  if (!body) return [];
  const out: KtProperty[] = [];
  for (const child of body.children) {
    if (child.type !== 'property_declaration') continue;
    const isVar = isVarBinding(child);
    if (isVar === null) continue;
    if (hasJvmField(child) || hasConst(child)) continue;
    const nameNode = propertyNameNode(child);
    if (!nameNode) continue;
    const custom = customAccessors(child);
    const mods = child.children.find((c) => c.type === 'modifiers') ?? null;
    out.push({
      name: nameNode.text,
      type: propertyTypeText(child),
      isVar,
      skipGetter: custom.getter,
      skipSetter: custom.setter,
      visibility: kotlinVisibility(mods),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      declaratorNode: nameNode,
    });
  }
  return out;
}

function findKtClasses(root: Parser.SyntaxNode): KtClass[] {
  const classes: KtClass[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    if (KOTLIN_TYPE_DECLS.has(node.type)) {
      const name = jvmTypeSimpleName(node) ?? (node.type === 'companion_object' ? 'Companion' : '');
      if (name) {
        const ctor = node.children.find((c) => c.type === 'primary_constructor') ?? null;
        const body = node.children.find((c) => c.type === 'class_body') ?? null;
        const properties = [...collectClassParameters(ctor), ...collectBodyProperties(body)];
        if (properties.length > 0) {
          classes.push({
            node,
            name,
            properties,
            existingMethods: collectExistingMethods(body),
          });
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return classes;
}

function planAccessors(cls: KtClass): PlannedJvmAccessor[] {
  const planned: PlannedJvmAccessor[] = [];
  for (const prop of cls.properties) {
    const useIs = kotlinUsesIsPrefix(prop.type);
    if (!prop.skipGetter) {
      const gName = jvmGetterName(prop.name, useIs);
      if (!hasExistingAccessor(cls.existingMethods, gName, 0)) {
        planned.push({
          kind: 'getter',
          name: gName,
          returnType: prop.type,
          parameterTypes: [],
          visibility: prop.visibility,
          startLine: prop.startLine,
          endLine: prop.endLine,
          classNode: cls.node,
          declaratorNode: prop.declaratorNode,
        });
      }
    }
    if (prop.isVar && !prop.skipSetter) {
      const sName = jvmSetterName(prop.name, useIs);
      if (!hasExistingAccessor(cls.existingMethods, sName, 1)) {
        planned.push({
          kind: 'setter',
          name: sName,
          returnType: 'void',
          parameterTypes: [prop.type],
          visibility: prop.visibility,
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
