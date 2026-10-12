import type Parser from 'tree-sitter';
import { CLASS_KINDS, type SymbolDefinition } from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameSemanticContext,
  RenameSource,
} from '../../rename-provider.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import {
  canonicalizeRenameBindings,
  containsRange,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  rangeKey,
  walkNamedNodes,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { extractMixedChain } from '../../utils/call-analysis.js';
import { encodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import { pythonStringLiteral } from './string-literal.js';

const canonicalName = (name: string): string => name.normalize('NFKC');
const keywords = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
);
// Definition kinds whose parameters (not fields) a keyword argument label binds.
const CALLABLE_KINDS: readonly string[] = ['Function', 'Method', 'Constructor'];
const unsupported = (message: string, code = 'unsupported_occurrence'): RenameIssue => ({
  code,
  message,
  status: 'unsupported',
});

// https://docs.python.org/3/reference/expressions.html#private-name-mangling
// A class-body identifier with two leading underscores and fewer than two
// trailing ones is rewritten to `_Class__name`; written external spellings differ.
const isPrivateName = (name: string): boolean => name.startsWith('__') && !name.endsWith('__');
// https://docs.python.org/3/reference/lexical_analysis.html#reserved-classes-of-identifiers
// `__name__` is reserved for the data model: the interpreter looks these members up
// implicitly (len(), iteration, construction, ...), so no written token proves a use.
const isSpecialName = (name: string): boolean => /^__.+__$/s.test(name);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (parent.type === 'aliased_import' && parent.childForFieldName('alias')?.id === node.id)
    return 'alias';
  if (
    parent.type === 'dotted_name' &&
    (parent.parent?.type === 'import_from_statement' || parent.parent?.type === 'aliased_import')
  )
    return 'imported';
  if (parent.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id)
    return 'unrelated';
  if (
    parent.type === 'parameters' ||
    (['default_parameter', 'typed_default_parameter'].includes(parent.type) &&
      parent.childForFieldName('name')?.id === node.id) ||
    (['typed_parameter', 'list_splat_pattern', 'dictionary_splat_pattern'].includes(parent.type) &&
      parent.firstNamedChild?.id === node.id)
  )
    return 'binding';
  return 'name';
}

function bareReference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    ['dotted_name', 'aliased_import', 'global_statement', 'nonlocal_statement'].includes(
      parent.type,
    )
  )
    return undefined;
  if (
    parent.childForFieldName('name')?.id === node.id &&
    ['function_definition', 'class_definition'].includes(parent.type)
  )
    return undefined;
  const range = nodeRange(node);
  const scope = innermostRenameScope(source.parsed, node);
  if (!scope) return undefined;
  if (parent.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id) {
    const receiver = parent.childForFieldName('object');
    if (!receiver) return undefined;
    const chain = extractMixedChain(receiver);
    const receiverChain = chain?.baseReceiverName
      ? encodeReceiverChain(chain.baseReceiverName, chain.chain)
      : undefined;
    return {
      name: canonicalName(node.text),
      nameRange: range,
      atRange: nodeRange(parent),
      inScope: scope,
      kind: 'read' as const,
      explicitReceiver: { name: receiver.text },
      ...(receiverChain ? { receiverChain } : {}),
    };
  }
  // The provider's lexical claims establish assignment/comprehension ownership.
  return {
    name: canonicalName(node.text),
    nameRange: range,
    atRange: range,
    inScope: scope,
    kind: 'read' as const,
  };
}

function within(node: Parser.SyntaxNode, container: Parser.SyntaxNode): boolean {
  return containsRange(nodeRange(container), nodeRange(node));
}

function bindsInClassBody(token: Parser.SyntaxNode, declaration: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node && node.id !== declaration.id; node = node.parent) {
    if (node.type !== 'function_definition' && node.type !== 'lambda') continue;
    const body = node.childForFieldName('body');
    if (body && within(token, body)) return false;
    const parameters = node.childForFieldName('parameters');
    if (parameters && within(token, parameters)) {
      let parameter = token;
      while (parameter.parent && parameter.parent.id !== parameters.id)
        parameter = parameter.parent;
      const value = parameter.childForFieldName('value');
      const annotation = parameter.childForFieldName('type');
      if (!(value && within(token, value)) && !(annotation && within(token, annotation)))
        return false;
    }
  }
  return true;
}

function hasMangledNames(className: Parser.SyntaxNode): boolean {
  const declaration = className.parent;
  if (declaration?.type !== 'class_definition') return false;
  const pending = [...declaration.namedChildren];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'class_definition') {
      if (isPrivateName(node.childForFieldName('name')?.text ?? '')) return true;
      const body = node.childForFieldName('body');
      pending.push(...node.namedChildren.filter((child) => child.id !== body?.id));
      continue;
    }
    if (
      node.type === 'identifier' &&
      (isPrivateName(node.text) ||
        (node.text === '__slots__' && bindsInClassBody(node, declaration)))
    )
      return true;
    pending.push(...node.namedChildren);
  }
  return false;
}

function receiverWrite(token: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node; node = node.parent) {
    if (node.type === 'attribute') return false;
    if (
      node.type.includes('assignment') ||
      node.type === 'for_statement' ||
      node.type === 'for_in_clause' ||
      node.type === 'named_expression'
    ) {
      const left = node.childForFieldName('left') ?? node.childForFieldName('name');
      if (left && within(token, left)) return true;
    }
    if (node.type.includes('statement') || node.type.includes('definition')) return false;
  }
  return false;
}

function checkModuleExports(
  context: RenameSemanticContext,
  targetName: string,
): RenameIssue | void {
  const oldName = canonicalName(targetName);
  const newName = canonicalName(context.newName);
  for (const source of context.files.values()) {
    // An unaliased import can publish the selected definition from another
    // module. Unrelated modules and nested declarations do not share that name.
    const moduleBinding = lookupNameClaim(source.parsed.moduleScope, oldName, context.indexes, {
      purpose: 'value',
    });
    if (!moduleBinding.bindings.some((binding) => binding.def.nodeId === context.target.nodeId))
      continue;
    for (const occurrence of source.occurrences) {
      const node = occurrence.node;
      if (occurrence.name !== '__all__' || !node) continue;
      const parent = node.parent;
      if (parent?.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id)
        continue;
      const scope = innermostRenameScope(source.parsed, node);
      if (!scope) continue;
      // Class-body assignments become visible after their value is evaluated;
      // looking up the left-hand token itself would select an outer __all__.
      const assignment =
        parent?.type === 'assignment' && parent.childForFieldName('left')?.id === node.id;
      const claim = lookupNameClaim(scope, '__all__', context.indexes, {
        position: assignment
          ? { startLine: parent.endPosition.row + 1, startCol: parent.endPosition.column }
          : nodeRange(node),
        purpose: 'value',
      });
      if ((claim.scope?.id ?? scope) !== source.parsed.moduleScope) continue;
      const value = parent?.childForFieldName('right');
      if (
        assignment &&
        value &&
        ['list', 'tuple'].includes(value.type) &&
        value.namedChildren.every((item) => {
          if (item.type === 'comment') return true;
          const name = pythonStringLiteral(item);
          return name !== undefined && name !== oldName && name !== newName;
        })
      )
        continue;
      // Mutations, aliases, and computed lists need a complete export-value
      // model. Only a literal sequence with unrelated names proves safety.
      return unsupported(
        `A Python module export list may contain the selected symbol or its destination name: ${source.path}:${node.startPosition.row + 1}.`,
      );
    }
  }
}

function checkMemberNames(context: RenameSemanticContext, targetName: string): RenameIssue | void {
  const names = [canonicalName(targetName), canonicalName(context.newName)];
  if (names.some(isPrivateName))
    return unsupported(
      'A private Python member requires its mangled external spellings in the symbol family.',
      'unsupported_symbol_family',
    );
  if (names.some(isSpecialName))
    return unsupported(
      'A Python special-method or data-model name has implicit uses that written references do not show.',
      'unsupported_symbol_family',
    );
}

/** Two classes can share one instance when either lies on the other's method resolution order. */
function relatedOwners(context: RenameSemanticContext, left: string, right: string): boolean {
  const { methodDispatch } = context.indexes;
  return (
    left === right ||
    methodDispatch.mroFor(left).includes(right) ||
    methodDispatch.mroFor(right).includes(left)
  );
}

/**
 * A keyword label is an ordinary token for the callee's parameter, but a
 * synthesized constructor (dataclass, NamedTuple, ...) binds it to the field.
 * Only a callee proven to be another function or an unrelated class keeps it unrelated.
 */
function checkKeywordLabels(
  context: RenameSemanticContext,
  targetName: string,
): RenameIssue | void {
  const ownerId = context.target.ownerId;
  if (!ownerId) return;
  const names = new Set([canonicalName(targetName), canonicalName(context.newName)]);
  for (const source of context.files.values()) {
    let occurrencesByRange: Map<string, RenameOccurrence> | undefined;
    for (const occurrence of source.occurrences) {
      const label = occurrence.node;
      if (occurrence.role !== 'unrelated' || !names.has(occurrence.name) || !label) continue;
      const call = label.parent?.parent?.parent;
      // Class keywords reach the metaclass and __init_subclass__, never instance fields.
      if (call?.type === 'class_definition') continue;
      const callee = call?.type === 'call' ? call.childForFieldName('function') : undefined;
      const calleeName =
        callee?.type === 'attribute' ? callee.childForFieldName('attribute') : callee;
      occurrencesByRange ??= new Map(
        source.occurrences.map((candidate) => [rangeKey(candidate.range), candidate]),
      );
      const site =
        calleeName?.type === 'identifier'
          ? occurrencesByRange.get(rangeKey(nodeRange(calleeName)))?.referenceSite
          : undefined;
      const binding = site && context.referenceBindings.get(site);
      const callables =
        binding?.status === 'resolved' && binding.targetDefIds.length
          ? binding.targetDefIds.map((id) => context.indexes.defs.get(id))
          : undefined;
      const bindsOtherCallable = (def: SymbolDefinition | undefined): boolean =>
        def !== undefined &&
        (CALLABLE_KINDS.includes(def.type) ||
          (CLASS_KINDS.includes(def.type) && !relatedOwners(context, def.nodeId, ownerId)));
      if (callables?.every(bindsOtherCallable)) continue;
      return unsupported(
        `A keyword argument label may bind the selected field or its destination name through a synthesized constructor: ${source.path}:${label.startPosition.row + 1}.`,
        'ambiguous_reference',
      );
    }
  }
}

function pythonSymbolFamily(
  context: RenameSemanticContext,
): readonly SymbolDefinition[] | RenameIssue {
  return graphRenameFamily(context, {
    matches: (left, right) =>
      left.type === 'Method' &&
      right.type === 'Method' &&
      canonicalName(simpleQualifiedName(left) ?? '') ===
        canonicalName(simpleQualifiedName(right) ?? ''),
  });
}

export const pythonRenameProvider: RenameProvider = {
  canonicalName,
  symbolFamily: pythonSymbolFamily,
  validateName(name) {
    if (
      !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name) ||
      !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(canonicalName(name)) ||
      keywords.has(canonicalName(name))
    )
      return { code: 'invalid_name', message: 'Choose a valid nonreserved Python identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => node.type === 'identifier',
    skip: (node) => node.type === 'comment',
    role,
    canonicalName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalName),
    reference: bareReference,
  }),
  checkSafety(context) {
    const targetName = simpleQualifiedName(context.target) ?? '';
    const exportIssue = checkModuleExports(context, targetName);
    if (exportIssue) return exportIssue;
    if (context.target.ownerId) {
      const nameIssue = checkMemberNames(context, targetName);
      if (nameIssue) return nameIssue;
      if (
        !CALLABLE_KINDS.includes(context.target.type) &&
        !CLASS_KINDS.includes(context.target.type)
      ) {
        const labelIssue = checkKeywordLabels(context, targetName);
        if (labelIssue) return labelIssue;
      }
    }
    if (CLASS_KINDS.includes(context.target.type)) {
      const source = context.files.get(context.target.filePath);
      const name = source?.occurrences.find(
        (occurrence) => occurrence.definitionId === context.target.nodeId,
      )?.node;
      if (name && hasMangledNames(name))
        return unsupported(
          'Renaming a Python class with private-name or slot coupling requires a complete symbol-family plan.',
          'unsupported_symbol_family',
        );
    }
    const ownerId = context.target.ownerId;
    if (!ownerId) return;
    let familyOwners: ReadonlySet<string> | undefined;
    // A string literal attribute name is meaningful only on the relevant receiver.
    for (const source of context.files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (
          node.type !== 'call' ||
          !['getattr', 'setattr', 'delattr', 'hasattr'].includes(
            node.childForFieldName('function')?.text ?? '',
          )
        )
          continue;
        const args = node
          .childForFieldName('arguments')
          ?.namedChildren.filter((child) => child.type !== 'comment');
        const attribute = args?.[1] && pythonStringLiteral(args[1]);
        // Runtime attribute strings are exact; Python only normalizes identifiers.
        // The destination name can collide with an existing dynamic attribute.
        if (
          attribute !== undefined &&
          attribute !== canonicalName(targetName) &&
          attribute !== canonicalName(context.newName)
        )
          continue;
        const receiver = args?.[0];
        if (!receiver) continue;
        const scope = innermostRenameScope(source.parsed, receiver);
        const claim =
          scope &&
          lookupNameClaim(scope, receiver.text, context.indexes, {
            position: nodeRange(receiver),
            purpose: 'value',
          });
        const type = claim && claim.typeBinding;
        if (!type) return unsupported('A dynamic attribute receiver cannot be proven unrelated.');
        const owners = lookupNameClaim(type.declaredAtScope, type.rawName, context.indexes, {
          position: nodeRange(receiver),
          purpose: 'type',
        }).bindings;
        // A receiver that inherits the declaring class (or may hold a subclass instance)
        // reaches the selected member without naming its declaring owner.
        if (
          !owners.length ||
          owners.some((owner) => relatedOwners(context, owner.def.nodeId, ownerId))
        )
          return unsupported(
            'Dynamic attribute access may denote the selected member or its destination name.',
          );
        if (!familyOwners) {
          // An override family can select a member that the receiver inherits from a sibling.
          const family = pythonSymbolFamily(context);
          if ('code' in family) return family;
          familyOwners = new Set(family.flatMap((member) => member.ownerId ?? []));
        }
        const selectedOwners = familyOwners;
        if (
          owners.some((owner) =>
            [...selectedOwners].some((id) => relatedOwners(context, owner.def.nodeId, id)),
          )
        )
          return unsupported(
            'Dynamic attribute access may denote a member of the selected override family.',
          );
      }
    }
  },
  checkOccurrence(context) {
    const { site } = context;
    if (!site?.explicitReceiver) return;
    const name = site.explicitReceiver.name;
    const claim = lookupNameClaim(site.inScope, name, context.indexes, {
      position: site.atRange,
      purpose: 'value',
    });
    const type = claim.typeBinding;
    if (
      type?.source === 'decorator-unknown' ||
      (type?.declaredSpelling && type.declaredSpelling !== type.rawName)
    )
      return unsupported(
        'The receiver type does not prove an object identity.',
        'ambiguous_reference',
      );
    const source = claim.scope && context.files.get(claim.scope.filePath);
    if (!source) return;
    for (const occurrence of source.occurrences) {
      const node = occurrence.node;
      if (occurrence.name !== name || !node || !receiverWrite(node)) continue;
      if (
        type?.source === 'constructor-inferred' &&
        type.bindingRange &&
        containsRange(type.bindingRange, nodeRange(node))
      )
        continue;
      const scope = innermostRenameScope(source.parsed, node);
      const written =
        scope &&
        lookupNameClaim(scope, name, context.indexes, {
          position: nodeRange(node),
          purpose: 'value',
        });
      if (
        !written ||
        !written.scope ||
        written.claims.length === 0 ||
        written.scope.id === claim.scope?.id
      )
        return unsupported('The receiver binding is reassigned.', 'ambiguous_reference');
    }
  },
};
