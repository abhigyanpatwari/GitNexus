import type { ExportChecker } from '../../export-detection.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const accessModifiers = new Set(['public', 'private', 'protected']);

function explicitAccess(declaration: SyntaxNode): string | undefined {
  let first = declaration.firstNamedChild;
  if (
    first === undefined &&
    (declaration.type === 'method_declaration' || declaration.type === 'constructor_declaration')
  ) {
    // Partial syntax nodes can expose only the declaration text.
    return /^\s*(public|protected|private)(?=\s|\/|@)/u.exec(declaration.text)?.[1];
  }
  while (first?.type === 'line_comment' || first?.type === 'block_comment') {
    first = first.nextNamedSibling;
  }
  if (first?.type === 'modifiers') {
    return first.children.find((token) => accessModifiers.has(token.type))?.type;
  }
  return undefined;
}

/** Java access modifiers apply to the declaration that owns the name. */
export const javaExportChecker: ExportChecker = (node) => {
  let declaration: SyntaxNode | null =
    node.type === 'identifier' || node.type === 'type_identifier' ? node.parent : node;
  if (declaration?.type === 'variable_declarator') declaration = declaration.parent;
  if (!declaration) return false;
  if (declaration.type === 'enum_constant') return true;
  if (declaration.type === 'formal_parameter' || declaration.type === 'spread_parameter') {
    // The graph represents a record component by its public accessor method.
    return declaration.parent?.parent?.type === 'record_declaration';
  }
  if (!declaration.type.endsWith('_declaration')) return false;

  const access = explicitAccess(declaration);
  if (access) return access === 'public';
  const body = declaration.parent?.type;
  return body === 'interface_body' || body === 'annotation_type_body';
};
