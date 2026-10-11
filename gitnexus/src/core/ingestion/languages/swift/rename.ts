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
import { canonicalName } from './identifiers.js';

const names = new Set(['simple_identifier', 'type_identifier']);
const keywords = new Set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (parent.type === 'parameter' && node.type === 'simple_identifier') return 'binding';
  if (parent.type === 'value_argument_label' || parent.type === 'statement_label')
    return 'unrelated';
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent)
    if (ancestor.type === 'import_declaration') return 'imported';
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
  if (parent.type === 'navigation_suffix') return undefined;
  if (
    ['navigation_expression'].includes(parent.type) &&
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
    kind:
      node.type === 'type_identifier' || parent.type === 'user_type'
        ? ('type-reference' as const)
        : ('read' as const),
  };
}

export const swiftRenameProvider: RenameProvider = {
  canonicalName,
  validateName(name) {
    const canonical = canonicalName(name);
    if (
      !(
        /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(canonical) &&
        (!keywords.has(canonical) || name.startsWith('`'))
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
        newText: oldText.startsWith('`') ? '`' + canonicalName(newName) + '`' : newName,
      };
    });
  },
  symbolFamily(context) {
    const name = (def: typeof context.target) => canonicalName(simpleQualifiedName(def) ?? '');
    const method = (def: typeof context.target) =>
      ['Method', 'Function'].includes(def.type) && !!def.ownerId;
    const declarationGroup = (def: typeof context.target) =>
      context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node?.parent
        ?.parent?.id;
    const declaration = (def: typeof context.target) =>
      context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node?.parent;
    const isInstance = (def: typeof context.target) =>
      !declaration(def)?.namedChildren.some(
        (node) =>
          node.type === 'modifiers' &&
          node.children.some((child) => ['private', 'static'].includes(child.text)),
      );
    return graphRenameFamily(context, {
      requiresBaseMember: (def) =>
        declaration(def)?.namedChildren.some(
          (node) =>
            node.type === 'modifiers' && node.children.some((child) => child.text === 'override'),
        ) === true,
      matches: (left, right) =>
        method(left) &&
        method(right) &&
        isInstance(left) &&
        isInstance(right) &&
        name(left) === name(right),
      sameDeclarationGroup: (left, right) =>
        (['Method', 'Function'].includes(left.type) &&
          ['Method', 'Function'].includes(right.type) &&
          !left.ownerId &&
          !right.ownerId &&
          left.filePath === right.filePath &&
          declarationGroup(left) !== undefined &&
          declarationGroup(left) === declarationGroup(right) &&
          name(left) === name(right)) ||
        (method(left) &&
          method(right) &&
          left.ownerId === right.ownerId &&
          name(left) === name(right)) ||
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
