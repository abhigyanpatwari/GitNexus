import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractKotlinNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_header > identifier + import_alias > simple_identifier
  if (importNode.type !== 'import_header') return undefined;

  const fullIdent = findChild(importNode, 'identifier');
  if (!fullIdent) return undefined;

  const fullText = fullIdent.text;
  const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;

  const importAlias = findChild(importNode, 'import_alias');
  if (importAlias) {
    // Aliased: import com.example.User as U
    const aliasIdent = findChild(importAlias, 'simple_identifier');
    if (!aliasIdent) return undefined;
    return [{ local: aliasIdent.text, exported: exportedName }];
  }

  // Non-aliased: import com.example.User → local="User", exported="User"
  // Also handles top-level function imports: import models.getUser → local="getUser"
  // Skip wildcard imports (ending in *)
  if (fullText.endsWith('.*') || fullText.endsWith('*')) return undefined;
  // Skip class-member imports (e.g., import util.OneArg.writeAudit) where the
  // second-to-last segment is PascalCase (a class name). Multiple member imports
  // with the same function name would collide in NamedImportMap, breaking
  // arity-based disambiguation. Top-level function imports (import models.getUser)
  // and class imports (import models.User) have package-only prefixes.
  const segments = fullText.split('.');
  if (segments.length >= 3) {
    const parentSegment = segments[segments.length - 2];
    if (parentSegment[0] && parentSegment[0] === parentSegment[0].toUpperCase()) return undefined;
  }
  return [{ local: exportedName, exported: exportedName }];
}
