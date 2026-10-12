import type Parser from 'tree-sitter';
import { SupportedLanguages, type BindingRef } from 'gitnexus-shared';
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

/**
 * Builtins that look a member up by a spelled name, mapped to what their first
 * argument denotes: `@field(value, name)` takes a value, while `@hasDecl(T, name)`
 * and `@hasField(T, name)` take a type. Renaming a member changes every such
 * lookup, so the literal can neither stay nor be rewritten without proof.
 */
const reflectionSubjects: ReadonlyMap<string, 'value' | 'type'> = new Map([
  ['@field', 'value'],
  ['@hasDecl', 'type'],
  ['@hasField', 'type'],
]);
/** Only a written container declaration proves an owner; an alias or parameter does not. */
const containerTypes: ReadonlySet<string> = new Set(['Struct', 'Enum', 'Union']);

export const zigRenameProvider: RenameProvider = {
  canonicalName,
  // An indexed C source may call a function exported with `export fn`.
  interoperatesWithSourceProvider: (provider) => provider.id === SupportedLanguages.C,
  checkSafety(context) {
    // A literal equal to the destination flips `@hasDecl`/`@hasField` from false to true.
    const names = new Set([
      canonicalName(simpleQualifiedName(context.target) ?? ''),
      canonicalName(context.newName),
    ]);
    const lookups: Array<{
      source: RenameSource;
      node: Parser.SyntaxNode;
      subject: 'value' | 'type';
    }> = [];
    let mixesInMembers = false;
    for (const source of context.files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type === 'using_namespace_declaration') mixesInMembers = true;
        const subject =
          node.type === 'builtin_function'
            ? reflectionSubjects.get(node.firstNamedChild?.text ?? '')
            : undefined;
        if (subject) lookups.push({ source, node, subject });
      }
    }
    for (const { source, node, subject } of lookups) {
      const args = node.namedChildren.find((child) => child.type === 'arguments')?.namedChildren;
      const [receiver, field] = args ?? [];
      if (field?.type === 'string' && !names.has(canonicalName(`@${field.text}`))) continue;
      const scope = receiver && innermostRenameScope(source.parsed, receiver);
      let owners: readonly BindingRef[] | undefined;
      if (scope && receiver && subject === 'type') {
        owners =
          receiver.type === 'identifier'
            ? lookupNameClaim(scope, canonicalName(receiver.text), context.indexes, {
                position: nodeRange(receiver),
                purpose: 'type',
              }).bindings
            : undefined;
      } else if (scope && receiver) {
        const type = lookupNameClaim(scope, canonicalName(receiver.text), context.indexes, {
          position: nodeRange(receiver),
          purpose: 'value',
        }).typeBinding;
        owners =
          type &&
          lookupNameClaim(type.declaredAtScope, type.rawName, context.indexes, {
            position: nodeRange(node),
            purpose: 'type',
          }).bindings;
      }
      // `usingnamespace` republishes one container's declarations under another.
      if (
        !mixesInMembers &&
        context.target.ownerId &&
        owners?.length &&
        owners.every(
          (owner) =>
            containerTypes.has(owner.def.type) && owner.def.nodeId !== context.target.ownerId,
        )
      )
        continue;
      return {
        code: 'unsupported_occurrence',
        status: 'unsupported',
        message: 'A reflected member lookup may denote the selected or destination name.',
      };
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
