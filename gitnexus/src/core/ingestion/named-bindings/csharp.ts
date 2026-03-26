import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractCSharpNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // using_directive — three forms:
  //   using Alias = NS.Type;          → aliasIdent + qualifiedName
  //   using static NS.Type;           → static + qualifiedName (no alias)
  //   using NS;                       → qualifiedName only (namespace, not capturable)
  if (importNode.type !== 'using_directive') return undefined;

  let aliasIdent: SyntaxNode | null = null;
  let qualifiedName: SyntaxNode | null = null;
  let isStatic = false;
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (child?.text === 'static') isStatic = true;
  }
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (child?.type === 'identifier' && !aliasIdent) aliasIdent = child;
    else if (child?.type === 'qualified_name') qualifiedName = child;
  }

  // Form 1: using Alias = NS.Type;
  if (aliasIdent && qualifiedName) {
    const fullText = qualifiedName.text;
    const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;
    return [{ local: aliasIdent.text, exported: exportedName }];
  }

  // Form 2: using static NS.Type; — last segment is the class name
  if (isStatic && qualifiedName) {
    const fullText = qualifiedName.text;
    const lastSegment = fullText.includes('.') ? fullText.split('.').pop()! : fullText;
    return [{ local: lastSegment, exported: lastSegment }];
  }

  // Form 3: using NS; — namespace import, can't resolve to per-symbol bindings
  return undefined;
}
