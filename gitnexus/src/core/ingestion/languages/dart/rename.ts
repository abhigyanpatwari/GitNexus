import type Parser from 'tree-sitter';
import { CLASS_KINDS } from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';

const canonicalName = (name: string): string => name;
const names = new Set(['identifier', 'type_identifier']);
const keywords = new Set(
  'assert break case catch class const continue default do else enum extends false final finally for if in is new null rethrow return super switch this throw true try var void while with'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (parent.type === 'formal_parameter' && parent.childForFieldName('name')?.id === node.id)
    return 'binding';
  if (
    parent.type === 'label' ||
    (parent.type === 'argument' &&
      parent.firstNamedChild?.id === node.id &&
      parent.children.some((child) => child.text === ':'))
  )
    return 'unrelated';
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent)
    if (ancestor.type === 'import_or_export') return 'imported';
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
    ['unconditional_assignable_selector', 'conditional_assignable_selector'].includes(parent.type)
  )
    return undefined;
  if (
    ['selector'].includes(parent.type) &&
    parent.namedChildCount > 1 &&
    parent.lastNamedChild?.id === node.id
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  return {
    name: canonicalName(node.text),
    atRange: range,
    nameRange: range,
    inScope,
    kind: node.type === 'type_identifier' ? ('type-reference' as const) : ('read' as const),
  };
}

export const dartRenameProvider: RenameProvider = {
  canonicalName,
  validateName(name) {
    const canonical = canonicalName(name);
    if (!(/^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(canonical) && !keywords.has(canonical)))
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
  symbolFamily(context) {
    const name = (def: typeof context.target) => canonicalName(simpleQualifiedName(def) ?? '');
    const method = (def: typeof context.target) =>
      ['Method', 'Function'].includes(def.type) && !!def.ownerId;
    const sameMethod = (left: typeof context.target, right: typeof context.target) =>
      method(left) && method(right) && left.ownerId === right.ownerId && name(left) === name(right);
    const isInstance = (def: typeof context.target) => {
      const signature = context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node
        ?.parent?.parent;
      return signature?.type !== 'method_signature' || !hasKeyword(signature, 'static');
    };
    // Static members are not inherited; syntax proves their family stays in one owner.
    if (method(context.target) && !isInstance(context.target))
      return context.definitions.filter((definition) => sameMethod(context.target, definition));
    return graphRenameFamily(context, {
      matches: (left, right) =>
        method(left) &&
        method(right) &&
        isInstance(left) &&
        isInstance(right) &&
        name(left) === name(right),
      sameDeclarationGroup: (left, right) =>
        sameMethod(left, right) ||
        (CLASS_KINDS.includes(left.type) &&
          right.type === 'Constructor' &&
          right.ownerId === left.nodeId &&
          name(left) === name(right)) ||
        (CLASS_KINDS.includes(right.type) &&
          left.type === 'Constructor' &&
          left.ownerId === right.nodeId &&
          name(left) === name(right)),
    });
  },
};
