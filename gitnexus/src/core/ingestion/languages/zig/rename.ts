import type Parser from 'tree-sitter';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  walkNamedNodes,
} from '../rename-tree-sitter.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';

const keywords = new Set(
  'addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return section struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while'.split(
    ' ',
  ),
);
function canonicalName(name: string): string {
  if (!name.startsWith('@"') || !name.endsWith('"')) return name;
  return name
    .slice(2, -1)
    .replace(
      /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|([nrt\\'"]))/g,
      (escape, hex: string | undefined, unicode: string | undefined, simple: string | undefined) =>
        hex
          ? String.fromCharCode(Number.parseInt(hex, 16))
          : unicode
            ? String.fromCodePoint(Number.parseInt(unicode, 16))
            : ({ n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' }[simple!] ?? escape),
    );
}
function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (parent && ['break_label', 'block_label'].includes(parent.type)) return 'unrelated';
  if (
    (parent?.type === 'parameter' && parent.childForFieldName('name')?.id === node.id) ||
    parent?.type === 'payload'
  )
    return 'binding';
  return 'name';
}
function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    (parent.type === 'field_expression' && parent.childForFieldName('member')?.id === node.id) ||
    (parent.childForFieldName('name')?.id === node.id &&
      ['function_declaration', 'variable_declaration', 'container_field'].includes(parent.type))
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
  };
}

export const zigRenameProvider: RenameProvider = {
  canonicalName,
  checkSafety(context) {
    const name = canonicalName(simpleQualifiedName(context.target) ?? '');
    for (const source of context.files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type !== 'builtin_function' || node.firstNamedChild?.text !== '@field') continue;
        const args = node.namedChildren.find((child) => child.type === 'arguments')?.namedChildren;
        const [receiver, field] = args ?? [];
        if (field?.type === 'string' && canonicalName(`@${field.text}`) !== name) continue;
        const scope = receiver && innermostRenameScope(source.parsed, receiver);
        const claim =
          scope &&
          receiver &&
          lookupNameClaim(scope, canonicalName(receiver.text), context.indexes, {
            position: nodeRange(receiver),
            purpose: 'value',
          });
        const type = claim && claim.typeBinding;
        const owners =
          type &&
          lookupNameClaim(type.declaredAtScope, type.rawName, context.indexes, {
            position: nodeRange(node),
            purpose: 'type',
          }).bindings;
        if (
          context.target.ownerId &&
          owners?.length &&
          owners.every((owner) => owner.def.nodeId !== context.target.ownerId)
        )
          continue;
        return {
          code: 'unsupported_occurrence',
          status: 'unsupported',
          message: 'A reflected field access may denote the selected symbol.',
        };
      }
    }
  },
  validateName(name) {
    const quoted =
      /^@"(?:[^"\\\r\n]|\\(?:[nrt\\'"]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}))+"$/.test(name);
    if (!quoted && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === '_' || keywords.has(name)))
      return {
        code: 'invalid_name',
        message: 'Choose a valid Zig identifier or quoted identifier.',
      };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => node.type === 'identifier',
    skip: (node) => node.type === 'comment',
    role,
    canonicalName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalName),
    reference,
  }),
};
