import type Parser from 'tree-sitter';
import { CLASS_KINDS } from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';

const canonicalName = (name: string): string =>
  name
    .replace(/^@/, '')
    .replace(
      /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g,
      (escape, short: string | undefined, long: string | undefined) => {
        const value = Number.parseInt(short ?? long!, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
      },
    );
const names = new Set(['identifier']);
const keywords = new Set(
  'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (
    (parent.type === 'parameter' && parent.childForFieldName('name')?.id === node.id) ||
    parent.type === 'implicit_parameter'
  )
    return 'binding';
  if (
    (parent.type === 'argument' && parent.childForFieldName('name')?.id === node.id) ||
    parent.type === 'labeled_statement' ||
    parent.type === 'goto_statement'
  )
    return 'unrelated';
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'using_directive')
      return ancestor.childForFieldName('name')?.id === node.id &&
        ancestor.children.some((child) => child.text === '=')
        ? 'alias'
        : 'imported';
  }
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    (parent.childForFieldName('name')?.id === node.id &&
      /declaration|definition|signature|declarator/.test(parent.type))
  )
    return undefined;
  // A qualified member has its own semantic receiver; never reinterpret it as a bare lexical read.
  if (
    ['member_access_expression', 'qualified_name', 'alias_qualified_name'].includes(parent.type) &&
    parent.namedChildCount > 1 &&
    parent.lastNamedChild?.id === node.id
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  const isType =
    parent.childForFieldName('type')?.id === node.id ||
    parent.childForFieldName('returns')?.id === node.id ||
    [
      'type_argument_list',
      'base_list',
      'type_parameter_constraint',
      'nullable_type',
      'array_type',
    ].includes(parent.type);
  return {
    name: canonicalName(node.text),
    atRange: range,
    nameRange: range,
    inScope,
    kind: isType ? ('type-reference' as const) : ('read' as const),
  };
}

export const csharpRenameProvider: RenameProvider = {
  canonicalName,
  validateName(name) {
    const canonical = canonicalName(name);
    if (
      !(
        /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(canonical) &&
        (!keywords.has(canonical) || name.startsWith('@'))
      )
    )
      return { code: 'invalid_name', message: 'Choose a valid nonreserved identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => names.has(node.type),
    skip: (node) => node.type.includes('comment'),
    role,
    canonicalName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalName),
    reference,
  }),
  rewrite({ source, occurrence, newName }) {
    return occurrence.spans.map((span) => {
      const oldText = source.content.slice(span.start, span.start + span.length);
      return {
        ...span,
        oldText,
        newText: oldText.startsWith('@') ? '@' + canonicalName(newName) : newName,
      };
    });
  },
  symbolFamily(context) {
    const name = (def: typeof context.target) => canonicalName(simpleQualifiedName(def) ?? '');
    const isTypeNamedMember = (def: typeof context.target) =>
      def.type === 'Constructor' ||
      context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node?.parent
        ?.type === 'destructor_declaration';
    const method = (def: typeof context.target) =>
      ['Method', 'Function'].includes(def.type) && !!def.ownerId;
    const isInstance = (def: typeof context.target) =>
      !context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)
        ?.node?.parent?.namedChildren.some(
          (node) => node.type === 'modifier' && ['private', 'static'].includes(node.text),
        );
    return graphRenameFamily(context, {
      matches: (left, right) =>
        method(left) &&
        method(right) &&
        isInstance(left) &&
        isInstance(right) &&
        name(left) === name(right),
      sameDeclarationGroup: (left, right) =>
        (method(left) &&
          method(right) &&
          left.ownerId === right.ownerId &&
          name(left) === name(right)) ||
        (CLASS_KINDS.includes(left.type) &&
          isTypeNamedMember(right) &&
          right.ownerId === left.nodeId &&
          name(left) === name(right)) ||
        (CLASS_KINDS.includes(right.type) &&
          isTypeNamedMember(left) &&
          left.ownerId === right.nodeId &&
          name(left) === name(right)),
    });
  },
};
