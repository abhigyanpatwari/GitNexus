import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { cppAnonymousNamespaceSegment } from '../../class-extractors/configs/c-cpp.js';

const CPP_OUT_OF_LINE_SCOPE_TYPES = new Set([
  'namespace_definition',
  'class_specifier',
  'struct_specifier',
  'union_specifier',
]);

function splitCppScopeText(raw: string): string[] {
  const segments: string[] = [];
  let angleDepth = 0;
  let parenDepth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (parenDepth === 0 && ch === '<') {
      angleDepth += 1;
    } else if (parenDepth === 0 && ch === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (angleDepth === 0 && parenDepth === 0 && ch === ':' && raw[i + 1] === ':') {
      const segment = raw.slice(start, i).trim();
      if (segment) segments.push(segment);
      i += 1;
      start = i + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

/** Find the inner `function_declarator` of a C/C++ function declaration/definition. */
export function findCppFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
  let declarator = node.childForFieldName?.('declarator');
  if (!declarator) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (
        c?.type === 'function_declarator' ||
        c?.type === 'pointer_declarator' ||
        c?.type === 'reference_declarator'
      ) {
        declarator = c;
        break;
      }
    }
  }
  while (
    declarator &&
    (declarator.type === 'pointer_declarator' ||
      declarator.type === 'reference_declarator' ||
      declarator.type === 'parenthesized_declarator')
  ) {
    let nextDeclarator = declarator.childForFieldName?.('declarator');
    if (!nextDeclarator) {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (
          c?.type === 'function_declarator' ||
          c?.type === 'pointer_declarator' ||
          c?.type === 'reference_declarator' ||
          c?.type === 'parenthesized_declarator'
        ) {
          nextDeclarator = c;
          break;
        }
      }
    }
    declarator = nextDeclarator;
  }
  return declarator?.type === 'function_declarator' ? declarator : null;
}

/** Extract the leaf name node from a C++ `qualified_identifier` chain (`N::Box::save` -> `save`). */
export function unwrapCppQualifiedNameNode(qualNode: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = qualNode;
  while (current?.type === 'qualified_identifier') {
    let nextNode = current.childForFieldName?.('name');
    if (!nextNode) {
      for (let i = 0; i < current.childCount; i++) {
        const c = current.child(i);
        if (
          c?.type === 'qualified_identifier' ||
          c?.type === 'identifier' ||
          c?.type === 'operator_name' ||
          c?.type === 'destructor_name'
        ) {
          nextNode = c;
          break;
        }
      }
    }
    if (!nextNode) return null;
    current = nextNode;
  }
  return current;
}

/**
 * Derive the normalized qualified owner path (`N.Box`, `N.Box<bool>`, `@anon1.Item`)
 * for an out-of-line C++ method definition (`void N::Box::save() {}`), respecting
 * enclosing namespace blocks while avoiding redundant prefix duplication (`namespace N { void N::Box::save() {} }`)
 * and honoring explicit `::` global-root anchoring (`void ::Box::save() {}`).
 */
export function resolveCppDetachedOwnerName(node: SyntaxNode): string | undefined {
  if (node.type !== 'function_definition') return undefined;
  const funcDeclarator = findCppFunctionDeclarator(node);
  if (!funcDeclarator) return undefined;

  let innerDeclarator = funcDeclarator.childForFieldName?.('declarator');
  if (innerDeclarator?.type === 'parenthesized_declarator') {
    innerDeclarator =
      innerDeclarator.childForFieldName?.('declarator') ??
      innerDeclarator.namedChildren?.find((c) => c.type === 'qualified_identifier') ??
      null;
  }
  if (innerDeclarator?.type !== 'qualified_identifier') return undefined;

  const isGlobalRoot = innerDeclarator.text.trimStart().startsWith('::');
  const qualifierScopes: string[] = [];
  let cursor: SyntaxNode | null = innerDeclarator;
  while (cursor?.type === 'qualified_identifier') {
    const scopeNode = cursor.childForFieldName?.('scope');
    if (scopeNode?.text) {
      qualifierScopes.push(...splitCppScopeText(scopeNode.text));
    }
    cursor = cursor.childForFieldName?.('name') ?? null;
  }
  if (qualifierScopes.length === 0) return undefined;
  if (isGlobalRoot) return qualifierScopes.join('.');

  const ancestorScopes: string[][] = [];
  let anc = node.parent;
  while (anc) {
    if (CPP_OUT_OF_LINE_SCOPE_TYPES.has(anc.type)) {
      if (anc.type === 'namespace_definition' && !anc.childForFieldName?.('name')) {
        ancestorScopes.push([cppAnonymousNamespaceSegment(anc)]);
      } else {
        const nameText = anc.childForFieldName?.('name')?.text;
        if (nameText) ancestorScopes.push(splitCppScopeText(nameText));
      }
    }
    anc = anc.parent;
  }
  const enclosingScopes = ancestorScopes.reverse().flat();
  if (enclosingScopes.length === 0) return qualifierScopes.join('.');

  // If the out-of-line qualifier repeats a suffix of the enclosing namespace chain
  // (e.g. `namespace N { void N::Box::save() {} }`), avoid doubling it while keeping
  // the final owning class segment intact.
  let overlap = 0;
  const maxOverlap = Math.min(enclosingScopes.length, qualifierScopes.length - 1);
  for (let k = maxOverlap; k >= 1; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (enclosingScopes[enclosingScopes.length - k + i] !== qualifierScopes[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = k;
      break;
    }
  }

  return [...enclosingScopes, ...qualifierScopes.slice(overlap)].join('.');
}
