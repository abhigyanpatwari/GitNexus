import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractPhpNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // namespace_use_declaration > namespace_use_clause* (flat)
  // namespace_use_declaration > namespace_use_group > namespace_use_clause* (grouped)
  if (importNode.type !== 'namespace_use_declaration') return undefined;

  // Skip 'use function' and 'use const' declarations — these import callables/constants,
  // not class types, and should not be added to namedImportMap as type bindings.
  const useTypeNode = importNode.childForFieldName?.('type');
  if (useTypeNode && (useTypeNode.text === 'function' || useTypeNode.text === 'const')) {
    return undefined;
  }

  const bindings: NamedBinding[] = [];

  // Collect all clauses — from direct children AND from namespace_use_group
  const clauses: SyntaxNode[] = [];
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (child?.type === 'namespace_use_clause') {
      clauses.push(child);
    } else if (child?.type === 'namespace_use_group') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const groupChild = child.namedChild(j);
        if (groupChild?.type === 'namespace_use_clause') clauses.push(groupChild);
      }
    }
  }

  for (const clause of clauses) {
    // Flat imports: qualified_name + name (alias)
    let qualifiedName: SyntaxNode | null = null;
    const names: SyntaxNode[] = [];
    for (let j = 0; j < clause.namedChildCount; j++) {
      const child = clause.namedChild(j);
      if (child?.type === 'qualified_name') qualifiedName = child;
      else if (child?.type === 'name') names.push(child);
    }

    if (qualifiedName && names.length > 0) {
      // Flat aliased import: use App\Models\Repo as R;
      const fullText = qualifiedName.text;
      const exportedName = fullText.includes('\\') ? fullText.split('\\').pop()! : fullText;
      bindings.push({ local: names[0].text, exported: exportedName });
    } else if (qualifiedName && names.length === 0) {
      // Flat non-aliased import: use App\Models\User;
      const fullText = qualifiedName.text;
      const lastSegment = fullText.includes('\\') ? fullText.split('\\').pop()! : fullText;
      bindings.push({ local: lastSegment, exported: lastSegment });
    } else if (!qualifiedName && names.length >= 2) {
      // Grouped aliased import: {Repo as R} — first name = exported, second = alias
      bindings.push({ local: names[1].text, exported: names[0].text });
    } else if (!qualifiedName && names.length === 1) {
      // Grouped non-aliased import: {User} in use App\Models\{User, Repo as R}
      bindings.push({ local: names[0].text, exported: names[0].text });
    }
  }
  return bindings.length > 0 ? bindings : undefined;
}
