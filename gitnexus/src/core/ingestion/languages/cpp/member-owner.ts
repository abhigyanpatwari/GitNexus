/**
 * Owner path of an out-of-line C++ member (`void N::Box::save() {}`).
 *
 * The declarator already names the class. Prepending every lexical namespace
 * on top of that path double-qualifies (`namespace N { void N::Box::save() {} }`
 * → `N.N.Box`). A one-segment declarator (`void Box::save()` inside `namespace
 * N`) is relative and must pick up `N`. A leading `::` is anchored at the
 * global namespace.
 *
 * When the class is declared in this translation unit, the path is the class
 * node's own qualified name, so the out-of-line definition and the in-class
 * member share one id. Template arguments stay in the spelling the in-class
 * member already uses (`N.Box<bool>`).
 */

import type { ClassExtractor } from '../../class-types.js';
import { cppAnonymousNamespaceSegment } from '../../class-extractors/configs/c-cpp.js';
import { memberOwnerName, type SyntaxNode } from '../../utils/ast-helpers.js';
import { splitQualifiedName } from '../../utils/qualified-name.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

const TYPE_NODES = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);
const WRAPPER_NODES = new Set([
  'template_declaration',
  'linkage_specification',
  'declaration',
  'declaration_list',
]);

const typeBaseName = (text: string): string => {
  const stripped = stripTemplateArguments(text.replace(/\s+/g, ''));
  const parts = splitQualifiedName(stripped);
  return parts[parts.length - 1] ?? stripped;
};

/**
 * Join a lexical namespace chain with a declarator path.
 *
 * A multi-segment declarator is already a qualified path. If its first
 * component repeats an enclosing namespace, the path is absolute from that
 * namespace (`N` + `N::Box` → `N.Box`). Otherwise the written path is kept
 * (`M` + `N::Box` → `N.Box`), which is what lookup finds when `N` is not a
 * member of `M`. A single segment is relative and takes the enclosing chain.
 */
export function joinCppMemberOwner(
  enclosing: readonly string[],
  declarator: readonly string[],
  globalRoot: boolean,
): string | undefined {
  const parts = declarator.map((segment) => segment.replace(/\s+/g, '')).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (globalRoot) return parts.join('.');
  if (parts.length >= 2) {
    const head = typeBaseName(parts[0]);
    const at = enclosing.lastIndexOf(head);
    if (at >= 0) return [...enclosing.slice(0, at), ...parts].join('.');
    return parts.join('.');
  }
  return [...enclosing, ...parts].join('.');
}

const qualifierSegments = (node: SyntaxNode): string[] => {
  if (node.type === 'qualified_identifier') {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    return [...(scope ? qualifierSegments(scope) : []), ...(name ? qualifierSegments(name) : [])];
  }
  const text = node.text.replace(/\s+/g, '');
  return text.length > 0 ? [text] : [];
};

const isFunctionDeclaratorName = (qual: SyntaxNode): boolean => {
  let current: SyntaxNode | null = qual.parent;
  for (let guard = 0; current && guard < 8; guard += 1) {
    if (current.type === 'function_declarator') return true;
    if (
      current.type === 'parenthesized_declarator' ||
      current.type === 'pointer_declarator' ||
      current.type === 'reference_declarator' ||
      current.type === 'abstract_pointer_declarator' ||
      current.type === 'abstract_reference_declarator'
    ) {
      current = current.parent;
      continue;
    }
    return false;
  }
  return false;
};

const qualifiedNameInDeclarator = (node: SyntaxNode): SyntaxNode | null => {
  if (node.type === 'qualified_identifier' && isFunctionDeclaratorName(node)) return node;
  const inner = node.childForFieldName('declarator');
  if (inner) {
    const found = qualifiedNameInDeclarator(inner);
    if (found) return found;
  }
  if (node.type === 'parenthesized_declarator') {
    for (const child of node.namedChildren ?? []) {
      const found = qualifiedNameInDeclarator(child);
      if (found) return found;
    }
  }
  return null;
};

const qualifiedFunctionName = (node: SyntaxNode): SyntaxNode | null => {
  if (node.type === 'qualified_identifier') {
    return isFunctionDeclaratorName(node) ? node : null;
  }
  const declarator = node.childForFieldName('declarator');
  if (declarator) return qualifiedNameInDeclarator(declarator);
  if (node.type === 'template_declaration') {
    const inner = node.namedChildren?.find(
      (child) => child.type === 'function_definition' || child.type === 'declaration',
    );
    return inner ? qualifiedFunctionName(inner) : null;
  }
  return null;
};

const enclosingNamespaceSegments = (node: SyntaxNode): string[] => {
  const segments: string[] = [];
  let current = node.parent;
  for (let guard = 0; current && guard < 4096; guard += 1) {
    if (current.type === 'namespace_definition') {
      const name = current.childForFieldName('name');
      if (name?.text) segments.unshift(...splitQualifiedName(name.text));
      else {
        const anon = cppAnonymousNamespaceSegment(current);
        if (anon) segments.unshift(anon);
      }
    }
    current = current.parent;
  }
  return segments;
};

const templateParameterNames = (node: SyntaxNode): string[] | null => {
  let current = node.parent;
  for (let guard = 0; current && guard < 32; guard += 1) {
    if (current.type === 'template_declaration') {
      const list =
        current.childForFieldName('parameters') ??
        current.namedChildren?.find((child) => child.type === 'template_parameter_list');
      if (!list) return [];
      const names: string[] = [];
      for (const param of list.namedChildren ?? []) {
        const name =
          param.childForFieldName('name') ??
          param.namedChildren?.find(
            (child) => child.type === 'type_identifier' || child.type === 'identifier',
          );
        if (name?.text) names.push(name.text);
      }
      return names;
    }
    if (current.type === 'translation_unit') break;
    current = current.parent;
  }
  return null;
};

/** `Box<T>` on a primary out-of-line definition is the class `Box`, not a specialization. */
const lookupArguments = (
  segment: string,
  primaryParams: readonly string[] | null,
): string[] | undefined => {
  const args = extractTemplateArguments(segment.replace(/\s+/g, ''));
  if (args === undefined) return undefined;
  if (
    primaryParams !== null &&
    args.length === primaryParams.length &&
    args.every((arg, index) => arg === primaryParams[index])
  ) {
    return undefined;
  }
  return args;
};

const scopeChildren = (node: SyntaxNode): readonly SyntaxNode[] => {
  const body = node.childForFieldName('body');
  if (body?.namedChildren && body.namedChildren.length > 0) return body.namedChildren;
  return node.namedChildren ?? [];
};

const namespaceMatches = (node: SyntaxNode, base: string): boolean => {
  const name = node.childForFieldName('name');
  if (!name?.text) return false;
  const parts = splitQualifiedName(name.text);
  return parts.length === 1 && parts[0] === base;
};

const typeMatches = (node: SyntaxNode, base: string, args: string[] | undefined): boolean => {
  const name = node.childForFieldName('name');
  if (!name?.text) return false;
  const text = name.text.replace(/\s+/g, '');
  if (typeBaseName(text) !== base) return false;
  const nameArgs = extractTemplateArguments(text);
  if (args === undefined) return nameArgs === undefined;
  return nameArgs !== undefined && nameArgs.join(',') === args.join(',');
};

const lookupDirect = (
  node: SyntaxNode,
  base: string,
  args: string[] | undefined,
  depth: number,
): SyntaxNode | null => {
  if (depth > 64) return null;
  for (const child of scopeChildren(node)) {
    if (WRAPPER_NODES.has(child.type)) {
      const wrapped = lookupDirect(child, base, args, depth + 1);
      if (wrapped) return wrapped;
      continue;
    }
    if (TYPE_NODES.has(child.type) && typeMatches(child, base, args)) return child;
    if (child.type === 'namespace_definition' && namespaceMatches(child, base)) return child;
  }
  return null;
};

const findClass = (
  qual: SyntaxNode,
  segments: readonly string[],
  globalRoot: boolean,
): SyntaxNode | null => {
  const primaryParams = templateParameterNames(qual);
  const names = segments.map((segment) => ({
    base: typeBaseName(segment),
    args: lookupArguments(segment, primaryParams),
  }));
  if (names.some((name) => name.base.length === 0)) return null;

  const scopes: SyntaxNode[] = [];
  if (globalRoot) {
    scopes.push(qual.tree.rootNode);
  } else {
    let current: SyntaxNode | null = qual.parent;
    for (let guard = 0; current && guard < 4096; guard += 1) {
      if (current.type === 'namespace_definition' || current.type === 'translation_unit') {
        scopes.push(current);
      }
      current = current.parent;
    }
    if (scopes.length === 0) scopes.push(qual.tree.rootNode);
  }

  for (const scope of scopes) {
    let cursor = lookupDirect(scope, names[0].base, names[0].args, 0);
    if (!cursor) continue;
    let matched = true;
    for (let index = 1; index < names.length; index += 1) {
      const next = lookupDirect(cursor, names[index].base, names[index].args, 0);
      if (!next) {
        matched = false;
        break;
      }
      cursor = next;
    }
    if (matched && TYPE_NODES.has(cursor.type)) return cursor;
  }
  return null;
};

const ownerFromQualifiedName = (qual: SyntaxNode, classes: ClassExtractor): string | undefined => {
  const scope = qual.childForFieldName('scope');
  if (!scope) return undefined;
  const segments = qualifierSegments(scope);
  if (segments.length === 0) return undefined;
  const globalRoot = qual.text.trimStart().startsWith('::');
  const found = findClass(qual, segments, globalRoot);
  if (found) {
    const raw = segments[segments.length - 1].replace(/\s+/g, '');
    const primary = lookupArguments(raw, templateParameterNames(qual)) === undefined;
    const spelled = primary ? stripTemplateArguments(raw) : raw;
    const base = typeBaseName(spelled);
    const qualified =
      classes.extractQualifiedName(found, base) ?? classes.qualifyScopeName?.(found, base) ?? null;
    if (qualified !== null) return memberOwnerName(spelled, qualified);
  }
  return joinCppMemberOwner(enclosingNamespaceSegments(qual), segments, globalRoot);
};

/** `LanguageProvider.resolveDetachedOwnerName` for C++ out-of-line members. */
export const resolveCppDetachedOwnerName = (
  node: SyntaxNode,
  classes: ClassExtractor,
): string | undefined => {
  const qual = qualifiedFunctionName(node);
  if (!qual) return undefined;
  return ownerFromQualifiedName(qual, classes);
};
