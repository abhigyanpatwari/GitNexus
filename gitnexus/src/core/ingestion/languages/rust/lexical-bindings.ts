import type { NameClaim } from 'gitnexus-shared';
import { nodeToCapture, walkNamedTree, type SyntaxNode } from '../../utils/ast-helpers.js';
import { splitRustUseDeclaration } from './import-decomposer.js';

const SCOPE_TYPES = new Set([
  'source_file',
  'function_item',
  'function_signature_item',
  'closure_expression',
  'block',
  'if_expression',
  'match_expression',
  'match_arm',
  'for_expression',
  'while_expression',
  'loop_expression',
  'mod_item',
  'struct_item',
  'trait_item',
  'impl_item',
  'enum_item',
  'union_item',
]);

/** Pattern identifiers own values even when no useful target/type was indexed. */
function patternNames(pattern: SyntaxNode): string[] {
  if (pattern.type === 'identifier' || pattern.type === 'shorthand_field_identifier') {
    return [pattern.text];
  }
  if (
    ['scoped_identifier', 'scoped_type_identifier', 'type_identifier', 'generic_type'].includes(
      pattern.type,
    )
  ) {
    return [];
  }
  if (pattern.type === 'field_pattern') {
    const nested = pattern.childForFieldName('pattern');
    if (nested !== null) return patternNames(nested);
    const name = pattern.childForFieldName('name');
    return name?.type === 'shorthand_field_identifier' ? [name.text] : [];
  }
  const type = pattern.childForFieldName('type');
  return pattern.namedChildren.flatMap((child) =>
    child.id === type?.id ? [] : patternNames(child),
  );
}

function ownerOf(node: SyntaxNode | null): SyntaxNode | null {
  while (node !== null && !SCOPE_TYPES.has(node.type)) node = node.parent;
  return node;
}

/** One AST pass. Captures carry these plain facts through serial and worker parsing. */
export function collectRustNameClaims(root: SyntaxNode): ReadonlyMap<number, readonly NameClaim[]> {
  const byScope = new Map<number, NameClaim[]>();
  const add = (
    owner: SyntaxNode | null,
    names: readonly string[],
    anchor: SyntaxNode,
    extra: Partial<NameClaim> = {},
  ) => {
    if (owner === null || names.length === 0) return;
    const claims = byScope.get(owner.id) ?? [];
    for (const name of names) {
      if (name === '_') continue;
      claims.push({
        name,
        range: nodeToCapture('', anchor).range,
        kind: 'binding',
        purpose: 'value',
        ...extra,
      });
    }
    byScope.set(owner.id, claims);
  };
  walkNamedTree(root, (node) => {
    if (node.type === 'use_declaration') {
      const names = splitRustUseDeclaration(node)
        .filter((match) => match['@import.kind']?.text !== 'wildcard')
        .flatMap((match) =>
          match['@import.name'] === undefined ? [] : [match['@import.name'].text],
        );
      add(ownerOf(node.parent), names, node, { kind: 'import', purpose: 'both', hoisted: true });
    } else if (node.type === 'let_declaration') {
      const pattern = node.childForFieldName('pattern');
      if (pattern !== null)
        add(ownerOf(node.parent), patternNames(pattern), node, {
          availableFrom: { startLine: node.endPosition.row + 1, startCol: node.endPosition.column },
          inactive: 'outer',
        });
    } else if (node.type === 'parameter') {
      const pattern = node.childForFieldName('pattern');
      if (pattern !== null) add(ownerOf(node.parent), patternNames(pattern), node);
    } else if (node.type === 'closure_expression') {
      const parameters = node.childForFieldName('parameters');
      for (const parameter of parameters?.namedChildren ?? []) {
        if (parameter.type !== 'parameter') add(node, patternNames(parameter), parameter);
      }
    } else if (node.type === 'for_expression') {
      const pattern = node.childForFieldName('pattern');
      if (pattern !== null) add(node.childForFieldName('body'), patternNames(pattern), pattern);
    } else if (node.type === 'match_arm') {
      const pattern = node.childForFieldName('pattern');
      if (pattern !== null) add(node, patternNames(pattern), pattern);
    } else if (node.type === 'let_condition') {
      const pattern = node.childForFieldName('pattern');
      let control = node.parent;
      while (control !== null && !['if_expression', 'while_expression'].includes(control.type))
        control = control.parent;
      if (pattern !== null && control !== null) {
        add(
          control.childForFieldName('consequence') ?? control.childForFieldName('body'),
          patternNames(pattern),
          pattern,
        );
      }
    } else if (
      [
        'function_item',
        'const_item',
        'static_item',
        'struct_item',
        'enum_item',
        'union_item',
        'trait_item',
        'type_item',
        'mod_item',
      ].includes(node.type)
    ) {
      const name = node.childForFieldName('name');
      if (name !== null)
        add(ownerOf(node.parent), [name.text], node, {
          hoisted: true,
          purpose: ['function_item', 'const_item', 'static_item'].includes(node.type)
            ? 'value'
            : ['trait_item', 'type_item'].includes(node.type)
              ? 'type'
              : 'both',
        });
    }
  });
  return byScope;
}
