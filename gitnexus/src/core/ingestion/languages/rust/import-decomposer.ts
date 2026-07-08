import type { CaptureMatch } from 'gitnexus-shared';
import { syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Decompose a Rust `use_declaration` into individual import captures.
 * Handles simple paths, grouped imports ({A, B}), wildcards (*),
 * renames (as), and `pub use` re-exports.
 */
export function splitRustUseDeclaration(node: SyntaxNode): CaptureMatch[] {
  if (node.type !== 'use_declaration') return [];

  const isReexport = hasVisibilityModifier(node);
  const argument = getUseArgument(node);
  if (argument === null) return [];

  return decomposeUseArgument(argument, '', isReexport, node);
}

function hasVisibilityModifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'visibility_modifier') return true;
  }
  return false;
}

function getUseArgument(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (
      child.type === 'scoped_identifier' ||
      child.type === 'scoped_use_list' ||
      child.type === 'use_wildcard' ||
      child.type === 'use_as_clause' ||
      child.type === 'identifier' ||
      child.type === 'use_list'
    ) {
      return child;
    }
  }
  return null;
}

function decomposeUseArgument(
  node: SyntaxNode,
  prefixPath: string,
  isReexport: boolean,
  anchor: SyntaxNode,
): CaptureMatch[] {
  switch (node.type) {
    case 'scoped_identifier': {
      const path = buildScopedPath(node);
      const segments = path.split('::');
      const name = segments[segments.length - 1];
      return [
        makeImportCapture(
          anchor,
          isReexport ? 'reexport' : 'named',
          joinPaths(prefixPath, path),
          name,
          undefined,
        ),
      ];
    }

    case 'scoped_use_list': {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const pathStr = pathNode ? buildNodePath(pathNode) : '';
      const fullPrefix = joinPaths(prefixPath, pathStr);
      if (listNode === null) return [];
      return decomposeUseList(listNode, fullPrefix, isReexport, anchor);
    }

    case 'use_list': {
      return decomposeUseList(node, prefixPath, isReexport, anchor);
    }

    case 'use_wildcard': {
      const wcPath = buildWildcardPath(node);
      return [makeImportCapture(anchor, 'wildcard', joinPaths(prefixPath, wcPath), '*', undefined)];
    }

    case 'use_as_clause': {
      const pathChild = node.childForFieldName('path');
      const aliasChild = node.childForFieldName('alias');
      if (pathChild === null || aliasChild === null) return [];
      const originalName =
        pathChild.type === 'scoped_identifier' ? buildScopedPath(pathChild) : pathChild.text;
      const aliasName = aliasChild.text;
      const segments = originalName.split('::');
      const importedName = segments[segments.length - 1];
      return [
        makeImportCapture(
          anchor,
          isReexport ? 'reexport' : 'named',
          joinPaths(prefixPath, originalName),
          importedName,
          aliasName,
        ),
      ];
    }

    case 'identifier': {
      return [
        makeImportCapture(
          anchor,
          isReexport ? 'reexport' : 'named',
          joinPaths(prefixPath, node.text),
          node.text,
          undefined,
        ),
      ];
    }

    default:
      return [];
  }
}

function decomposeUseList(
  listNode: SyntaxNode,
  prefix: string,
  isReexport: boolean,
  anchor: SyntaxNode,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (let i = 0; i < listNode.namedChildCount; i++) {
    const child = listNode.namedChild(i);
    if (child === null) continue;

    if (child.type === 'self') {
      // `use crate::models::{self}` — imports the module itself
      const segments = prefix.split('::').filter(Boolean);
      const name = segments[segments.length - 1] ?? 'self';
      out.push(makeImportCapture(anchor, 'namespace', prefix, name, undefined));
    } else {
      out.push(...decomposeUseArgument(child, prefix, isReexport, anchor));
    }
  }
  return out;
}

function buildScopedPath(node: SyntaxNode): string {
  if (node.type === 'scoped_identifier') {
    const parts: string[] = [];
    collectScopedParts(node, parts);
    return parts.join('::');
  }
  return node.text;
}

function collectScopedParts(node: SyntaxNode, parts: string[]): void {
  if (node.type === 'scoped_identifier') {
    const pathNode = node.childForFieldName('path');
    const nameNode = node.childForFieldName('name');
    if (pathNode) collectScopedParts(pathNode, parts);
    if (nameNode) parts.push(nameNode.text);
  } else {
    parts.push(node.text);
  }
}

function buildNodePath(node: SyntaxNode): string {
  if (node.type === 'scoped_identifier') {
    return buildScopedPath(node);
  }
  return node.text;
}

function buildWildcardPath(node: SyntaxNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (child.type === 'scoped_identifier') return buildScopedPath(child);
    if (child.type === 'identifier') return child.text;
  }
  return '';
}

function joinPaths(prefix: string, suffix: string): string {
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  return `${prefix}::${suffix}`;
}

function makeImportCapture(
  anchor: SyntaxNode,
  kind: string,
  source: string,
  name: string,
  alias: string | undefined,
): CaptureMatch {
  return {
    '@import.statement': syntheticCapture('@import.statement', anchor, anchor.text),
    '@import.kind': syntheticCapture('@import.kind', anchor, kind),
    '@import.source': syntheticCapture('@import.source', anchor, source),
    '@import.name': syntheticCapture('@import.name', anchor, alias ?? name),
    ...(alias !== undefined
      ? {
          '@import.alias': syntheticCapture('@import.alias', anchor, alias),
          '@import.original-name': syntheticCapture('@import.original-name', anchor, name),
        }
      : {}),
  };
}
