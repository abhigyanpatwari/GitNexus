import type Parser from 'tree-sitter';
import { CLASS_KINDS, SupportedLanguages } from 'gitnexus-shared';
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
  'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (
    (parent.type === 'parameter' && parent.firstNamedChild?.id === node.id) ||
    parent.type === 'lambda_parameters'
  )
    return 'binding';
  if (parent.type === 'import_alias') return 'alias';
  if (
    parent.type === 'value_argument' &&
    parent.firstNamedChild?.id === node.id &&
    parent.children.some((child) => child.text === '=')
  )
    return 'unrelated';
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'import_header') return 'imported';
    if (ancestor.type === 'package_header' || ancestor.type === 'label') return 'unrelated';
  }
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    (parent.namedChildren.find((child) => names.has(child.type))?.id === node.id &&
      /declaration|definition|signature|declarator/.test(parent.type))
  )
    return undefined;
  // A qualified member has its own semantic receiver; never reinterpret it as a bare lexical read.
  if (parent.type === 'navigation_suffix') return undefined;
  if (
    ['navigation_expression', 'user_type'].includes(parent.type) &&
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

export const kotlinRenameProvider: RenameProvider = {
  canonicalName,
  interoperatesWithSourceProvider: (provider) => provider.id === SupportedLanguages.Java,
  interopNames(name) {
    const suffix = name[0].toUpperCase() + name.slice(1);
    return [
      `get${suffix}`,
      `set${suffix}`,
      ...(/^is[A-Z]/.test(name) ? [`set${name.slice(2)}`] : []),
    ];
  },
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
          node.type === 'modifiers' && node.children.some((child) => child.text === 'private'),
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
        (left.type === 'Function' &&
          right.type === 'Function' &&
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
