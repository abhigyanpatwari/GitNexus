import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractPythonNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // Handle: from x import User, Repo as R
  if (importNode.type === 'import_from_statement') {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < importNode.namedChildCount; i++) {
      const child = importNode.namedChild(i);
      if (!child) continue;

      if (child.type === 'dotted_name') {
        // Skip the module_name (first dotted_name is the source module)
        const fieldName = importNode.childForFieldName?.('module_name');
        if (fieldName && child.startIndex === fieldName.startIndex) continue;

        // This is an imported name: from x import User
        const name = child.text;
        if (name) bindings.push({ local: name, exported: name });
      }

      if (child.type === 'aliased_import') {
        // from x import Repo as R
        const dottedName = findChild(child, 'dotted_name');
        const aliasIdent = findChild(child, 'identifier');
        if (dottedName && aliasIdent) {
          bindings.push({ local: aliasIdent.text, exported: dottedName.text });
        }
      }
    }

    return bindings.length > 0 ? bindings : undefined;
  }

  // Handle: import numpy as np  (import_statement with aliased_import child)
  // Tagged with isModuleAlias so applyImportResult routes these directly to
  // moduleAliasMap (e.g. "np" → "numpy.py") instead of namedImportMap.
  if (importNode.type === 'import_statement') {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < importNode.namedChildCount; i++) {
      const child = importNode.namedChild(i);
      if (!child || child.type !== 'aliased_import') continue;

      const dottedName = findChild(child, 'dotted_name');
      const aliasIdent = findChild(child, 'identifier');
      if (dottedName && aliasIdent) {
        bindings.push({ local: aliasIdent.text, exported: dottedName.text, isModuleAlias: true });
      }
    }

    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}
