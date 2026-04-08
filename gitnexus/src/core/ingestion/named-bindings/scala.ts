import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

const cleanScalaName = (text: string): string => text.replace(/`/g, '').trim();

/**
 * Extract a binding from a single selector node (identifier, renamed, wildcard).
 */
function extractFromSelector(selectorNode: SyntaxNode): NamedBinding | null {
  // Scala 2 "=>" rename or Scala 3 "as" rename
  if (
    selectorNode.type === 'arrow_renamed_identifier' ||
    selectorNode.type === 'as_renamed_identifier'
  ) {
    const nameNode = selectorNode.childForFieldName('name');
    const aliasNode = selectorNode.childForFieldName('alias');
    if (!nameNode || !aliasNode || aliasNode.text === '_') return null;
    return { local: cleanScalaName(aliasNode.text), exported: cleanScalaName(nameNode.text) };
  }

  if (selectorNode.type === 'namespace_wildcard') return null;

  if (selectorNode.type === 'identifier') {
    const name = cleanScalaName(selectorNode.text);
    return { local: name, exported: name };
  }

  return null;
}

/**
 * Extract named bindings from Scala import declarations.
 *
 * Scala import forms:
 *   import com.example.User              → local="User", exported="User"
 *   import com.example.{User, Order}     → two bindings
 *   import com.example.{User => U}       → local="U", exported="User"
 *   import com.example.{User as U}       → local="U", exported="User" (Scala 3)
 *   import com.example.{User => _}       → excluded, null
 *   import com.example._                 → wildcard, no named binding
 *   import com.example.*                 → wildcard, no named binding (Scala 3)
 */
export function extractScalaNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  if (importNode.type !== 'import_declaration') return undefined;

  const bindings: NamedBinding[] = [];

  // Check for namespace_selectors: import com.example.{A, B, C => D}
  const selectors = findChild(importNode, 'namespace_selectors');
  if (selectors) {
    for (let i = 0; i < selectors.namedChildCount; i++) {
      const child = selectors.namedChild(i);
      if (!child) continue;
      const binding = extractFromSelector(child);
      if (binding) bindings.push(binding);
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  // Check for a standalone renamed import (not inside selectors)
  const renamed =
    findChild(importNode, 'arrow_renamed_identifier') ??
    findChild(importNode, 'as_renamed_identifier');
  if (renamed) {
    const binding = extractFromSelector(renamed);
    return binding ? [binding] : undefined;
  }

  // Check for namespace_wildcard: import com.example._ or import com.example.*
  if (findChild(importNode, 'namespace_wildcard')) return undefined;

  // Simple import: import com.example.User
  const pathNode = findChild(importNode, '_namespace_expression') ?? importNode.firstNamedChild;
  const fullText = cleanScalaName(pathNode?.text ?? '').replace(/^_root_\./, '');
  if (!fullText || fullText.endsWith('._') || fullText.endsWith('.*')) return undefined;

  const segments = fullText.split('.');
  const name = segments[segments.length - 1];
  if (!name) return undefined;

  return [{ local: name, exported: name }];
}
