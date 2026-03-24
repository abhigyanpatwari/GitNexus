import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractJavaNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_declaration > scoped_identifier "com.example.models.User"
  // Wildcard imports (.*) don't produce named bindings
  if (importNode.type !== 'import_declaration') return undefined;

  // Check for asterisk (wildcard import) and static modifier
  let isStatic = false;
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (child?.type === 'asterisk') return undefined;
    if (child?.text === 'static') isStatic = true;
  }

  const scopedId = findChild(importNode, 'scoped_identifier');
  if (!scopedId) return undefined;

  const fullText = scopedId.text;
  const lastDot = fullText.lastIndexOf('.');
  if (lastDot === -1) return undefined;

  const name = fullText.slice(lastDot + 1);
  // Non-static: skip lowercase names — those are package imports, not class imports.
  // Static: allow lowercase — `import static models.UserFactory.getUser` imports a method.
  if (!isStatic && name[0] && name[0] === name[0].toLowerCase()) return undefined;

  return [{ local: name, exported: name }];
}
