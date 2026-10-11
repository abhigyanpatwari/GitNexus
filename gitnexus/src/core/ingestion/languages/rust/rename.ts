import type Parser from 'tree-sitter';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
} from '../../scope-resolution/graph-bridge/node-lookup.js';

const canonicalName = (name: string): string => name.replace(/^r#/, '').normalize('NFC');
const keywords = new Set(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do final gen macro override priv typeof unsized virtual yield try'.split(
    ' ',
  ),
);
const names = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'shorthand_field_identifier',
]);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'use_as_clause')
      return parent.childForFieldName('alias')?.id === node.id ? 'alias' : 'imported';
    if (parent.type === 'use_declaration') return 'imported';
    if (
      (parent.type === 'parameter' && parent.childForFieldName('pattern')?.id === node.id) ||
      parent.type === 'closure_parameters'
    )
      return 'binding';
    if (
      !['scoped_identifier', 'scoped_type_identifier', 'use_list', 'scoped_use_list'].includes(
        parent.type,
      )
    )
      break;
  }
  if (node.parent?.type === 'label') return 'unrelated';
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    node.type === 'field_identifier' ||
    parent.type === 'lifetime' ||
    parent.type === 'label'
  )
    return undefined;
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent)
    if (ancestor.type === 'token_tree' || ancestor.type === 'token_tree_pattern') return undefined;
  if (
    (parent.childForFieldName('name')?.id === node.id && parent.type.endsWith('_item')) ||
    parent.childForFieldName('pattern')?.id === node.id
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  return {
    name: canonicalName(node.text),
    nameRange: range,
    atRange: range,
    inScope,
    kind: 'read' as const,
    ...(node.type === 'type_identifier' ? { lookupPurpose: 'type' as const } : {}),
  };
}

export const rustRenameProvider: RenameProvider = {
  canonicalName,
  matchesGraphIdentity({ definition, definitions, node, graph }) {
    let name = definition.qualifiedName;
    if (!name) return false;
    const owner =
      definition.ownerId && definitions.find((def) => def.nodeId === definition.ownerId);
    if (owner?.qualifiedName && !name.startsWith(`${owner.qualifiedName}.`))
      name = `${owner.qualifiedName}.${name}`;
    if (definition.namespacePrefix && !name.startsWith(`${definition.namespacePrefix}.`))
      name = `${definition.namespacePrefix}.${name}`;
    return (
      buildGraphNodeLookup(graph).get(qualifiedKey(definition.filePath, node.label, name)) ===
      node.id
    );
  },
  symbolFamily(context) {
    return graphRenameFamily(context, {
      matches: (left, right) =>
        !!left.ownerId &&
        !!right.ownerId &&
        canonicalName(simpleQualifiedName(left) ?? '') ===
          canonicalName(simpleQualifiedName(right) ?? ''),
    });
  },
  validateName(name) {
    const raw = name.startsWith('r#');
    const normalized = canonicalName(name);
    if (
      !/^[_\p{XID_Start}][_\p{XID_Continue}]*$/u.test(normalized) ||
      normalized === '_' ||
      (!raw && keywords.has(normalized)) ||
      (raw && ['crate', 'self', 'Self', 'super'].includes(normalized))
    )
      return { code: 'invalid_name', message: 'Choose a valid Rust identifier or raw identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => names.has(node.type),
    skip: (node) => ['line_comment', 'block_comment'].includes(node.type),
    role,
    canonicalName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalName),
    reference,
  }),
};
