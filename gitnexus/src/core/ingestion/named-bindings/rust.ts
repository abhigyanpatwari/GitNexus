import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractRustNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // use_declaration may contain use_as_clause at any depth
  if (importNode.type !== 'use_declaration') return undefined;

  const bindings: NamedBinding[] = [];
  collectRustBindings(importNode, bindings);
  return bindings.length > 0 ? bindings : undefined;
}

function collectRustBindings(node: SyntaxNode, bindings: NamedBinding[]): void {
  if (node.type === 'use_as_clause') {
    // First identifier = exported name, second identifier = local alias
    const idents: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') idents.push(child.text);
      // For scoped_identifier, extract the last segment
      if (child?.type === 'scoped_identifier') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) idents.push(nameNode.text);
      }
    }
    if (idents.length === 2) {
      bindings.push({ local: idents[1], exported: idents[0] });
    }
    return;
  }

  // Terminal identifier in a use_list: use crate::models::{User, Repo}
  if (node.type === 'identifier' && node.parent?.type === 'use_list') {
    bindings.push({ local: node.text, exported: node.text });
    return;
  }

  // Skip scoped_identifier that serves as path prefix in scoped_use_list
  // e.g. use crate::models::{User, Repo} — the path node "crate::models" is not an importable symbol
  if (node.type === 'scoped_identifier' && node.parent?.type === 'scoped_use_list') {
    return; // path prefix — the use_list sibling handles the actual symbols
  }

  // Terminal scoped_identifier: use crate::models::User;
  // Only extract if this is a leaf (no deeper use_list/use_as_clause/scoped_use_list)
  if (node.type === 'scoped_identifier') {
    let hasDeeper = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'use_list' || child?.type === 'use_as_clause' || child?.type === 'scoped_use_list') {
        hasDeeper = true;
        break;
      }
    }
    if (!hasDeeper) {
      const nameNode = node.childForFieldName?.('name');
      if (nameNode) {
        bindings.push({ local: nameNode.text, exported: nameNode.text });
      }
      return;
    }
  }

  // Recurse into children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectRustBindings(child, bindings);
  }
}
