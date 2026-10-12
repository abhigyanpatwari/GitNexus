import type Parser from 'tree-sitter';
import { CLASS_KINDS, SupportedLanguages, type SymbolDefinition } from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameSemanticContext,
  RenameSource,
} from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  rangeKey,
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

// Callees whose labels bind their own parameters, never a property.
const CALLABLE_KINDS: readonly string[] = ['Function', 'Method'];
// An alias or namespace hides the constructor a label would bind.
const OPAQUE_TYPE_KINDS: readonly string[] = [
  'TypeAlias',
  'Typedef',
  'Namespace',
  'Template',
  'Category',
];

/** Two types can share one instance when either lies on the other's method resolution order. */
function relatedTypes(context: RenameSemanticContext, left: string, right: string): boolean {
  const { methodDispatch } = context.indexes;
  return (
    left === right ||
    methodDispatch.mroFor(left).includes(right) ||
    methodDispatch.mroFor(right).includes(left)
  );
}

/** The identifier an argument list calls; undefined when its syntax shape is not understood. */
function calleeName(label: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const invocation = label.parent?.parent?.parent;
  if (invocation?.type === 'call_suffix') {
    const callee = invocation.parent?.firstNamedChild;
    const name =
      callee?.type === 'navigation_expression' ? callee.lastNamedChild?.lastNamedChild : callee;
    return name?.type === 'simple_identifier' ? name : undefined;
  }
  // A supertype initializer or annotation names its class as a type.
  if (invocation?.type === 'constructor_invocation') {
    const type = invocation.firstNamedChild;
    const name = type?.type === 'user_type' ? type.lastNamedChild : undefined;
    return name?.type === 'type_identifier' ? name : undefined;
  }
  return undefined;
}

/** Whether a `val`/`var` parameter of the class's primary constructor has one of these spellings. */
function declaresPrimaryProperty(
  declaration: Parser.SyntaxNode | undefined,
  names: ReadonlySet<string>,
) {
  // An unreadable declaration cannot prove that the label binds only a plain parameter.
  if (!declaration) return true;
  return declaration.namedChildren.some(
    (child) =>
      child.type === 'primary_constructor' &&
      child.namedChildren.some(
        (parameter) =>
          parameter.type === 'class_parameter' &&
          parameter.namedChildren.some((part) => part.type === 'binding_pattern_kind') &&
          names.has(
            canonicalName(
              parameter.namedChildren.find((part) => part.type === 'simple_identifier')?.text ?? '',
            ),
          ),
      ),
  );
}

/**
 * A named argument label is an ordinary token for the callee's parameter, but a
 * primary-constructor `val`/`var` is a parameter and a property at once, and a data
 * class `copy()` repeats it. Only a callee proven to be another function, or a type
 * whose own primary constructor declares neither the selected nor the destination
 * name as a property, keeps the label unrelated.
 */
function checkNamedArgumentLabels(context: RenameSemanticContext): RenameIssue | void {
  const { target } = context;
  const ownerId = target.ownerId;
  if (!ownerId || target.type !== 'Property') return;
  const names = new Set([
    canonicalName(simpleQualifiedName(target) ?? ''),
    canonicalName(context.newName),
  ]);
  const declarations = new Map<string, Parser.SyntaxNode | undefined>();
  const declarationOf = (type: SymbolDefinition): Parser.SyntaxNode | undefined => {
    if (!declarations.has(type.nodeId))
      declarations.set(
        type.nodeId,
        context.files
          .get(type.filePath)
          ?.occurrences.find((occurrence) => occurrence.definitionId === type.nodeId)?.node
          ?.parent ?? undefined,
      );
    return declarations.get(type.nodeId);
  };
  for (const source of context.files.values()) {
    let occurrencesByRange: Map<string, RenameOccurrence> | undefined;
    for (const occurrence of source.occurrences) {
      const label = occurrence.node;
      if (
        occurrence.role !== 'unrelated' ||
        !names.has(occurrence.name) ||
        label?.parent?.type !== 'value_argument'
      )
        continue;
      occurrencesByRange ??= new Map(
        source.occurrences.map((candidate) => [rangeKey(candidate.range), candidate]),
      );
      const name = calleeName(label);
      const site = name && occurrencesByRange.get(rangeKey(nodeRange(name)))?.referenceSite;
      const binding = site && context.referenceBindings.get(site);
      const callees =
        binding?.status === 'resolved' && binding.targetDefIds.length
          ? binding.targetDefIds.map((id) => context.indexes.defs.get(id))
          : undefined;
      const bindsProperty = (callee: SymbolDefinition | undefined): boolean => {
        if (callee && CALLABLE_KINDS.includes(callee.type)) return false;
        const type =
          callee?.type === 'Constructor' && callee.ownerId
            ? context.indexes.defs.get(callee.ownerId)
            : callee;
        return (
          !type ||
          !CLASS_KINDS.includes(type.type) ||
          OPAQUE_TYPE_KINDS.includes(type.type) ||
          (relatedTypes(context, type.nodeId, ownerId) &&
            declaresPrimaryProperty(declarationOf(type), names))
        );
      };
      if (callees && !callees.some(bindsProperty)) continue;
      return {
        code: 'ambiguous_reference',
        message: `A named argument label may bind the selected property or its destination name through a constructor or copy() parameter: ${source.path}:${label.startPosition.row + 1}.`,
        status: 'unsupported',
      };
    }
  }
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
  checkSafety: checkNamedArgumentLabels,
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
