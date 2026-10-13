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

// Callees whose labels bind their own parameters, never a property.
const CALLABLE_KINDS: readonly string[] = ['Function', 'Method'];
// An alias or namespace hides the initializer a label would bind.
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
  const invocation = label.parent?.parent?.parent?.parent;
  if (invocation?.type !== 'call_suffix') return undefined;
  const callee = invocation.parent?.firstNamedChild;
  const name =
    callee?.type === 'navigation_expression' ? callee.lastNamedChild?.lastNamedChild : callee;
  return name?.type === 'simple_identifier' ? name : undefined;
}

/**
 * Swift synthesizes a memberwise initializer, labeled by the stored properties, for a
 * struct unless its own body declares an initializer (an extension does not suppress it).
 */
function synthesizesMemberwiseInit(declaration: Parser.SyntaxNode | undefined): boolean {
  // An unreadable declaration cannot prove that the label binds only an explicit initializer.
  if (!declaration) return true;
  return (
    declaration.childForFieldName('declaration_kind')?.text === 'struct' &&
    !declaration
      .childForFieldName('body')
      ?.namedChildren.some((member) => member.type === 'init_declaration')
  );
}

/**
 * An argument label is an ordinary token for the callee's parameter, but the memberwise
 * initializer of a struct labels its parameters with the stored property names. Only a
 * callee proven to be another function, or a type without such an initializer, keeps
 * the label unrelated.
 */
function checkArgumentLabels(context: RenameSemanticContext): RenameIssue | void {
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
        label?.parent?.type !== 'value_argument_label'
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
            synthesizesMemberwiseInit(declarationOf(type)))
        );
      };
      if (callees && !callees.some(bindsProperty)) continue;
      return {
        code: 'ambiguous_reference',
        message: `An argument label may bind the selected property or its destination name through a memberwise initializer: ${source.path}:${label.startPosition.row + 1}.`,
        status: 'unsupported',
      };
    }
  }
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
  // Objective-C calls a Swift member exposed with `@objc` by its own name.
  interoperatesWithSourceProvider: (provider) => provider.id === SupportedLanguages.ObjectiveC,
  checkSafety: checkArgumentLabels,
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
