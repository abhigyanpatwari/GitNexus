import type Parser from 'tree-sitter';
import {
  CLASS_KINDS,
  SupportedLanguages,
  type ReferenceSite,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameOccurrenceContext,
  RenameProvider,
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
import { resolveDefGraphId, simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { buildGraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { canonicalTypeScriptName } from './identifiers.js';
import { decodeReceiverChain } from '../../utils/receiver-chain-codec.js';

export { canonicalTypeScriptName } from './identifiers.js';

const receiverGraphLookups = new WeakMap<KnowledgeGraph, ReturnType<typeof buildGraphNodeLookup>>();
// Each rename plan owns one immutable source workspace and its lexical indexes.
const importedReceiverWrites = new WeakMap<
  RenameOccurrenceContext['files'],
  Map<string, boolean>
>();

const intermediateFieldSafety = new WeakMap<
  RenameOccurrenceContext['files'],
  Map<string, RenameIssue | null>
>();

const names = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'private_property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'statement_identifier',
]);
const keywordNames = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield implements interface let package private protected public static await'.split(
    ' ',
  ),
);
const issue = (message: string, code = 'unsupported_occurrence'): RenameIssue => ({
  code,
  message,
  status: 'unsupported',
});
const isReceiverIssue = (value: SymbolDefinition | RenameIssue | undefined): value is RenameIssue =>
  value !== undefined && 'code' in value;

function jsxTagRole(node: Parser.SyntaxNode): 'intrinsic' | 'component' | undefined {
  const parent = node.parent;
  if (
    parent &&
    ['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'].includes(
      parent.type,
    ) &&
    parent.childForFieldName('name')?.id === node.id
  )
    return /^[a-z]/.test(node.text) ? 'intrinsic' : 'component';
  return undefined;
}

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (parent.type === 'import_specifier')
    return parent.childForFieldName('alias')?.id === node.id ? 'alias' : 'imported';
  if (parent.type === 'export_specifier' && parent.parent?.parent?.childForFieldName('source'))
    return parent.childForFieldName('alias')?.id === node.id ? 'alias' : 'imported';
  if (
    node.type === 'statement_identifier' ||
    jsxTagRole(node) === 'intrinsic' ||
    (parent.type === 'jsx_attribute' && parent.firstNamedChild?.id === node.id) ||
    parent.childForFieldName('key')?.id === node.id ||
    (parent.type === 'export_specifier' && parent.childForFieldName('alias')?.id === node.id)
  )
    return 'unrelated';
  if (
    ((parent.type === 'required_parameter' || parent.type === 'optional_parameter') &&
      parent.childForFieldName('pattern')?.id === node.id) ||
    parent.type === 'formal_parameters' ||
    (parent.type === 'arrow_function' && parent.childForFieldName('parameter')?.id === node.id)
  )
    return 'binding';
  return 'name';
}

function bareReference(node: Parser.SyntaxNode, source: RenameSource) {
  if (node.type !== 'identifier' && node.type !== 'shorthand_property_identifier') return undefined;
  const parent = node.parent;
  if (
    !parent ||
    parent.type.includes('import') ||
    parent.type.includes('pattern') ||
    (parent.childForFieldName('name')?.id === node.id &&
      /declaration|definition|declarator/.test(parent.type))
  )
    return undefined;
  // An export specifier with a source names an imported symbol, handled by imports.
  if (parent.type === 'export_specifier' && parent.parent?.parent?.childForFieldName('source'))
    return undefined;
  const scope = innermostRenameScope(source.parsed, node);
  if (!scope) return undefined;
  const range = nodeRange(node);
  return {
    name: canonicalTypeScriptName(node.text),
    atRange: range,
    nameRange: range,
    inScope: scope,
    kind: 'read' as const,
  };
}

function receiverConstructor(
  root: Parser.SyntaxNode,
  name: string,
  type: TypeRef,
): Parser.SyntaxNode | undefined {
  if (!type.bindingRange) return undefined;
  for (const node of walkNamedNodes(root)) {
    if (
      node.type !== 'variable_declarator' ||
      rangeKey(nodeRange(node)) !== rangeKey(type.bindingRange)
    )
      continue;
    const value = node.childForFieldName('value');
    if (
      canonicalTypeScriptName(node.childForFieldName('name')?.text ?? '') === name &&
      value?.type === 'new_expression'
    )
      return value.childForFieldName('constructor') ?? undefined;
  }
  return undefined;
}

function receiverWrite(token: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node; node = node.parent) {
    if (node.type === 'member_expression' || node.type === 'subscript_expression') return false;
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      return (
        !!name &&
        containsRange(nodeRange(name), nodeRange(token)) &&
        node.childForFieldName('value') !== null
      );
    }
    if (node.type.includes('assignment') || node.type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      if (left && containsRange(nodeRange(left), nodeRange(token))) return true;
    }
    if (node.type === 'update_expression') return true;
    if (node.type.includes('statement') || node.type.includes('declaration')) return false;
  }
  return false;
}

function hoistedVarScope(token: Parser.SyntaxNode): number | undefined {
  let declaration: Parser.SyntaxNode | null = token;
  while (declaration && declaration.type !== 'variable_declarator') {
    if (/statement|declaration/.test(declaration.type)) return undefined;
    declaration = declaration.parent;
  }
  if (!declaration?.parent?.children.some((child) => child.type === 'var')) return undefined;
  for (let node: Parser.SyntaxNode | null = declaration.parent; node; node = node.parent)
    if (
      [
        'program',
        'function_declaration',
        'function_expression',
        'arrow_function',
        'generator_function_declaration',
        'generator_function',
        'method_definition',
        'class_static_block',
      ].includes(node.type)
    )
      return node.id;
  return undefined;
}

function importedReceiverIsReassigned(
  context: RenameOccurrenceContext,
  source: RenameSource,
  declarationId: string,
): boolean {
  let cache = importedReceiverWrites.get(context.files);
  if (!cache) {
    cache = new Map();
    importedReceiverWrites.set(context.files, cache);
  }
  const cached = cache.get(declarationId);
  if (cached !== undefined) return cached;
  for (const other of context.files.values()) {
    if (other === source) continue;
    for (const occurrence of other.occurrences) {
      const node = occurrence.node;
      if (!node || !receiverWrite(node)) continue;
      const scope = innermostRenameScope(other.parsed, node);
      let written = scope
        ? lookupNameClaim(scope, occurrence.name, context.indexes, {
            position: nodeRange(node),
            purpose: 'value',
          })
        : undefined;
      // Assignment inference describes a value, not a new lexical declaration.
      // Continue only when the provider's complete claims prove this scope
      // declares no binding; the eventual import must still resolve by identity.
      while (
        written?.scope?.lookupPolicy?.nameClaimsComplete &&
        written.claims.length === 0 &&
        written.bindings.length === 0 &&
        written.imports.length === 0 &&
        (written.typeBinding?.source === 'constructor-inferred' ||
          written.typeBinding?.source === 'assignment-inferred')
      ) {
        const parent = written.scope.lookupPolicy.parentScope ?? written.scope.parent;
        if (!parent) break;
        written = lookupNameClaim(parent, occurrence.name, context.indexes, {
          // Resolve the binding being written, before this write's blocker.
          position: nodeRange(node),
          purpose: 'value',
        });
      }
      if (written && written.bindings.some(({ def }) => def.nodeId === declarationId)) {
        cache.set(declarationId, true);
        return true;
      }
    }
  }
  cache.set(declarationId, false);
  return false;
}

function constructorOwner(
  context: RenameOccurrenceContext,
  source: RenameSource,
  constructor: Parser.SyntaxNode | undefined,
): SymbolDefinition | undefined {
  const scope = constructor && innermostRenameScope(source.parsed, constructor);
  const bindings =
    constructor?.type === 'identifier' && scope
      ? lookupNameClaim(scope, canonicalTypeScriptName(constructor.text), context.indexes, {
          position: nodeRange(constructor),
          purpose: 'value',
        }).bindings
      : [];
  const owners = new Map(
    bindings
      .filter(({ def }) => CLASS_KINDS.includes(def.type))
      .map(({ def }) => [def.nodeId, def]),
  );
  return owners.size === 1 ? owners.values().next().value : undefined;
}

function provesReceiverType(
  context: RenameOccurrenceContext,
  constructedOwner: SymbolDefinition,
  type: TypeRef,
  position = context.site?.atRange,
): boolean {
  const expected = lookupNameClaim(type.declaredAtScope, type.rawName, context.indexes, {
    position: type.lookupPosition ?? position,
    purpose: 'type',
  }).bindings;
  const ancestry = new Set([
    constructedOwner.nodeId,
    ...context.indexes.methodDispatch.mroFor(constructedOwner.nodeId),
  ]);
  let provenAnnotation = expected.some(
    ({ def }) =>
      ancestry.has(def.nodeId) ||
      context.indexes.methodDispatch
        .implementorsOf(def.nodeId)
        .some((owner) => ancestry.has(owner)),
  );
  if (!provenAnnotation) {
    let lookup = receiverGraphLookups.get(context.graph);
    if (!lookup) {
      lookup = buildGraphNodeLookup(context.graph);
      receiverGraphLookups.set(context.graph, lookup);
    }
    const ancestors = new Set(
      context.definitions
        .filter((definition) => ancestry.has(definition.nodeId))
        .map((definition) => resolveDefGraphId(definition.filePath, definition, lookup)),
    );
    const declaredOwners = new Set(
      expected.map(({ def }) => resolveDefGraphId(def.filePath, def, lookup)),
    );
    ancestors.delete(undefined);
    declaredOwners.delete(undefined);
    // An annotation alone is structural. A constructor plus an explicit
    // implementation edge proves which declaration family owns this value.
    for (const edge of context.graph.iterRelationshipsByType('IMPLEMENTS')) {
      if (ancestors.has(edge.sourceId) && declaredOwners.has(edge.targetId)) {
        provenAnnotation = true;
        break;
      }
    }
  }
  return provenAnnotation;
}

function checkReceiverBinding(
  context: RenameOccurrenceContext,
  name: string,
  site: Pick<ReferenceSite, 'inScope' | 'atRange'> | undefined = context.site,
): SymbolDefinition | RenameIssue | undefined {
  const { indexes, files } = context;
  if (!site) return;
  const claim = lookupNameClaim(site.inScope, name, indexes, {
    position: site.atRange,
    purpose: 'value',
  });
  const type = claim.typeBinding;
  if (!type) return;
  const imported =
    claim.imports.length > 0
      ? new Map(claim.bindings.map(({ def }) => [def.nodeId, def]))
      : undefined;
  if (imported && imported.size !== 1)
    return issue('The imported receiver has no unique declaration.', 'ambiguous_reference');
  const importedDefinition = imported?.values().next().value;
  const bindingName = importedDefinition
    ? canonicalTypeScriptName(simpleQualifiedName(importedDefinition) ?? '')
    : name;
  const sourcePath = importedDefinition?.filePath ?? claim.scope?.filePath;
  const source = sourcePath && files.get(sourcePath);
  if (!source?.tree)
    return issue('The receiver has no inspectable source binding.', 'ambiguous_reference');
  if (
    type.source === 'decorator-unknown' ||
    (type.declaredSpelling && type.declaredSpelling !== type.rawName)
  )
    return issue('The receiver type does not prove an object identity.', 'ambiguous_reference');
  const constructor = receiverConstructor(source.tree.rootNode, bindingName, type);
  if (
    importedDefinition &&
    !constructor?.parent?.parent?.parent?.children.some((child) => child.type === 'const')
  )
    return issue('The imported receiver is not a constructor-proven const.', 'ambiguous_reference');
  const owner =
    type.source === 'self'
      ? lookupNameClaim(type.declaredAtScope, type.rawName, indexes, {
          position: type.lookupPosition ?? site.atRange,
          purpose: 'type',
        }).bindings.find(({ def }) => CLASS_KINDS.includes(def.type))?.def
      : constructorOwner(context, source, constructor);
  if (type.source !== 'self' && (!owner || !provesReceiverType(context, owner, type, site.atRange)))
    return issue(
      'A structural type annotation cannot prove the receiver constructor.',
      'ambiguous_reference',
    );
  const bindingScope = constructor
    ? innermostRenameScope(source.parsed, constructor)
    : claim.scope?.id;
  for (const occurrence of source.occurrences) {
    const node = occurrence.node;
    if (occurrence.name !== bindingName || !node || !receiverWrite(node)) continue;
    if (constructor?.parent?.parent?.childForFieldName('name')?.id === node.id) continue;
    if (
      constructor &&
      hoistedVarScope(node) !== undefined &&
      hoistedVarScope(node) === hoistedVarScope(constructor)
    )
      return issue('A hoisted receiver binding is reassigned.', 'ambiguous_reference');
    const scope = innermostRenameScope(source.parsed, node);
    const written =
      scope &&
      lookupNameClaim(scope, bindingName, indexes, { position: nodeRange(node), purpose: 'value' });
    if (
      !written ||
      !written.scope ||
      written.claims.length === 0 ||
      written.scope.id === bindingScope
    )
      return issue('The receiver binding is reassigned.', 'ambiguous_reference');
  }
  if (
    importedDefinition &&
    importedReceiverIsReassigned(context, source, importedDefinition.nodeId)
  )
    return issue('The imported receiver binding is reassigned.', 'ambiguous_reference');
  return owner;
}

function ownedMembers(
  context: RenameOccurrenceContext,
  owner: SymbolDefinition,
  name: string,
): readonly SymbolDefinition[] {
  for (const ownerId of [owner.nodeId, ...context.indexes.methodDispatch.mroFor(owner.nodeId)]) {
    const members = new Map(
      [
        ...context.model.fields.lookupAllByOwner(ownerId, name),
        ...context.model.methods.lookupAllByOwner(ownerId, name),
      ]
        .filter((def) => context.indexes.defs.has(def.nodeId))
        .map((def) => [def.nodeId, def]),
    );
    if (members.size) return [...members.values()];
  }
  return [];
}

function isMemberWrite(member: Parser.SyntaxNode): boolean {
  for (let parent = member.parent; parent; parent = parent.parent) {
    // Writing a descendant does not replace this receiver slot.
    if (parent.type === 'member_expression' || parent.type === 'subscript_expression') return false;
    if (parent.type.includes('assignment') || parent.type === 'for_in_statement') {
      const left = parent.childForFieldName('left');
      return !!left && containsRange(nodeRange(left), nodeRange(member));
    }
    if (parent.type === 'update_expression') return true;
    if (parent.type === 'unary_expression')
      return parent.children.some((child) => child.text === 'delete');
    if (parent.type.includes('statement') || parent.type.includes('declaration')) return false;
  }
  return false;
}

function hasUnrelatedConstructedReceiver(
  context: RenameOccurrenceContext,
  source: RenameSource,
  member: Parser.SyntaxNode,
  field: SymbolDefinition,
): boolean {
  const receiver = member.childForFieldName('object');
  if (!receiver || !['identifier', 'this', 'super'].includes(receiver.type)) return false;
  const inScope = innermostRenameScope(source.parsed, receiver);
  if (!inScope) return false;
  const owner = checkReceiverBinding(context, canonicalTypeScriptName(receiver.text), {
    inScope,
    atRange: nodeRange(receiver),
  });
  if (!owner || isReceiverIssue(owner)) return false;
  const members = ownedMembers(
    context,
    owner,
    canonicalTypeScriptName(simpleQualifiedName(field) ?? ''),
  );
  return members.length > 0 && members.every((candidate) => candidate.nodeId !== field.nodeId);
}

function checkIntermediateField(
  context: RenameOccurrenceContext,
  field: SymbolDefinition,
): RenameIssue | void {
  let cache = intermediateFieldSafety.get(context.files);
  if (!cache) {
    cache = new Map();
    intermediateFieldSafety.set(context.files, cache);
  }
  if (cache.has(field.nodeId)) return cache.get(field.nodeId) ?? undefined;
  const name = canonicalTypeScriptName(simpleQualifiedName(field) ?? '');
  // The same provider policy protects both selected members and the mutable
  // slots that establish a selected member's receiver identity.
  let problem = typescriptRenameProvider.checkSafety?.({
    ...context,
    target: field,
    newName: name,
  });
  for (const source of context.files.values()) {
    if (problem) break;
    if (source.tree) {
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type !== 'subscript_expression' || !isMemberWrite(node)) continue;
        const key = node.childForFieldName('index');
        if (key?.type === 'number') continue;
        if (key?.type === 'string' && !key.text.includes('\\') && key.text.slice(1, -1) !== name)
          continue;
        if (hasUnrelatedConstructedReceiver(context, source, node, field)) continue;
        problem = issue('A computed access may replace an intermediate receiver field.');
        break;
      }
    }
    if (problem) break;
    for (const occurrence of source.occurrences) {
      const member = occurrence.node?.parent;
      if (
        occurrence.name !== name ||
        member?.type !== 'member_expression' ||
        member.childForFieldName('property')?.id !== occurrence.node?.id ||
        !isMemberWrite(member)
      )
        continue;
      const binding =
        occurrence.referenceSite && context.referenceBindings.get(occurrence.referenceSite);
      if (
        binding?.status === 'resolved' &&
        binding.targetDefIds.length > 0 &&
        binding.targetDefIds.every((id) => id !== field.nodeId) &&
        hasUnrelatedConstructedReceiver(context, source, member, field)
      )
        continue;
      problem = issue(
        'An intermediate receiver field is reassigned or has an unproven write.',
        'ambiguous_reference',
      );
      break;
    }
  }
  cache.set(field.nodeId, problem ? problem : null);
  return problem;
}

function checkReceiver(context: RenameOccurrenceContext): RenameIssue | void {
  const { site } = context;
  if (!site?.explicitReceiver) return;
  const chain = decodeReceiverChain(site.receiverChain);
  const base = checkReceiverBinding(
    context,
    chain ? canonicalTypeScriptName(chain.baseReceiverName) : site.explicitReceiver.name,
  );
  if (isReceiverIssue(base)) return base;
  if (!chain) {
    const receiver = context.occurrence.node?.parent?.childForFieldName('object');
    if (
      site.receiverChain ||
      (receiver && !['identifier', 'this', 'super'].includes(receiver.type))
    )
      return issue('The receiver chain has no complete constructor proof.', 'ambiguous_reference');
    return;
  }
  if (!base || chain.truncated || chain.steps.some((step) => step.kind !== 'field'))
    return issue('The receiver chain has no complete constructor proof.', 'ambiguous_reference');
  let owner = base;
  for (const step of chain.steps) {
    if (step.kind !== 'field')
      return issue('The receiver chain has no complete constructor proof.', 'ambiguous_reference');
    const members = ownedMembers(context, owner, canonicalTypeScriptName(step.name));
    const field = members.length === 1 ? members[0] : undefined;
    const source = field && context.files.get(field.filePath);
    const declaration = source?.occurrences.find(
      (occurrence) => occurrence.definitionId === field?.nodeId,
    )?.node?.parent;
    const value = declaration?.childForFieldName('value');
    const constructor =
      value?.type === 'new_expression' ? value.childForFieldName('constructor') : undefined;
    const constructed = source && constructorOwner(context, source, constructor ?? undefined);
    const scope = source && declaration && innermostRenameScope(source.parsed, declaration);
    const type =
      scope &&
      context.indexes.scopeTree
        .getScope(scope)
        ?.typeBindings.get(canonicalTypeScriptName(step.name));
    if (
      !field ||
      !constructed ||
      !type ||
      declaration?.children.some((node) => node.text === 'static') ||
      (type.declaredSpelling && type.declaredSpelling !== type.rawName) ||
      !provesReceiverType(context, constructed, type)
    )
      return issue(
        'An intermediate receiver field has no proven constructor identity.',
        'ambiguous_reference',
      );
    if (
      step === chain.steps[0] &&
      (chain.baseReceiverName === 'this' || chain.baseReceiverName === 'super')
    ) {
      // An inherited method can run on a descendant whose field initializer
      // replaces this slot. Only a concrete constructor fixes the root owner.
      for (const [descendantId, ancestors] of context.indexes.methodDispatch.mroByOwnerDefId) {
        if (!ancestors.includes(base.nodeId)) continue;
        const descendant = context.indexes.defs.get(descendantId);
        const inherited =
          descendant && ownedMembers(context, descendant, canonicalTypeScriptName(step.name));
        if (!inherited || inherited.length !== 1 || inherited[0]?.nodeId !== field.nodeId)
          return issue(
            'A descendant replaces a polymorphic intermediate receiver field.',
            'ambiguous_reference',
          );
      }
    }
    const problem = checkIntermediateField(context, field);
    if (problem) return problem;
    owner = constructed;
  }
  const members = ownedMembers(context, owner, site.name);
  if (members.length > 0 && members.every((member) => context.targetDefIds.includes(member.nodeId)))
    return;
  // An explicit override/implementation family can have a different written
  // declaration from the concrete constructor's member.
  const family = context.selected && typescriptRenameProvider.symbolFamily?.(context);
  if (
    Array.isArray(family) &&
    members.length > 0 &&
    members.every((member) => family.some((def) => def.nodeId === member.nodeId))
  )
    return;
  return issue(
    'The receiver chain does not prove the written member identity.',
    'ambiguous_reference',
  );
}

function isConstantLiteralReceiver(
  node: Parser.SyntaxNode,
  source: RenameSource,
  context: Parameters<NonNullable<RenameProvider['checkSafety']>>[0],
): boolean {
  const scope = innermostRenameScope(source.parsed, node);
  if (!scope) return false;
  const claim = lookupNameClaim(scope, canonicalTypeScriptName(node.text), context.indexes, {
    position: nodeRange(node),
    purpose: 'value',
  });
  if (claim.bindings.length !== 1) return false;
  const def = claim.bindings[0]!.def;
  const bindingSource = context.files.get(def.filePath);
  const declaration = bindingSource?.occurrences.find(
    (occurrence) => occurrence.definitionId === def.nodeId,
  )?.node?.parent;
  return (
    declaration?.type === 'variable_declarator' &&
    declaration.parent?.children.some((child) => child.type === 'const') === true &&
    ['array', 'object', 'string', 'number', 'true', 'false', 'null'].includes(
      declaration.childForFieldName('value')?.type ?? '',
    )
  );
}

export const typescriptRenameProvider: RenameProvider = {
  acceptsSourceProvider: (provider) =>
    [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript, SupportedLanguages.Vue].includes(
      provider.id,
    ),
  canonicalName: canonicalTypeScriptName,
  symbolFamily(context) {
    const method = (def: typeof context.target) =>
      context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node?.parent;
    const isPrivate = (def: typeof context.target) =>
      (simpleQualifiedName(def) ?? '').startsWith('#') ||
      method(def)?.children.some((node) => node.text === 'private') === true;
    return graphRenameFamily(context, {
      matches: (left, right) =>
        left.type === 'Method' &&
        right.type === 'Method' &&
        !isPrivate(left) &&
        !isPrivate(right) &&
        canonicalTypeScriptName(simpleQualifiedName(left) ?? '') ===
          canonicalTypeScriptName(simpleQualifiedName(right) ?? ''),
      canCouple: (left, right) =>
        !!method(left) &&
        !!method(right) &&
        !method(left)!.children.some((node) => node.type === 'static') &&
        !method(right)!.children.some((node) => node.type === 'static'),
    });
  },
  validateName(name) {
    const canonical = canonicalTypeScriptName(name);
    if (
      !/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(canonical) ||
      keywordNames.has(canonical)
    )
      return { code: 'invalid_name', message: 'Choose a valid nonreserved identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => names.has(node.type),
    skip: (node) => node.type === 'comment',
    role,
    canonicalName: canonicalTypeScriptName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalTypeScriptName),
    reference: bareReference,
  }),
  checkOccurrence(context) {
    for (let node = context.occurrence.node?.parent; node; node = node.parent)
      if (node.type === 'with_statement')
        return issue('A dynamic with environment prevents lexical rename proof.');
    return checkReceiver(context);
  },
  checkSafety(context) {
    const targetSource = context.files.get(context.target.filePath);
    const declaration = targetSource?.occurrences.find(
      (occurrence) => occurrence.definitionId === context.target.nodeId,
    )?.node?.parent;
    // Script-level function declarations also create global-object properties.
    const scriptGlobal =
      context.target.type === 'Function' &&
      declaration?.parent?.type === 'program' &&
      !targetSource?.tree?.rootNode.namedChildren.some(
        (node) => node.type === 'import_statement' || node.type === 'export_statement',
      );
    if (!context.target.ownerId && !scriptGlobal) return;
    for (const source of context.files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type !== 'subscript_expression') continue;
        const key = node.childForFieldName('index');
        if (key?.type === 'number') continue;
        if (key?.type === 'string' && !key.text.includes('\\')) {
          const value = key.text.slice(1, -1);
          if (
            value !== simpleQualifiedName(context.target) &&
            value !== canonicalTypeScriptName(context.newName)
          )
            continue;
        }
        const receiver = node.childForFieldName('object');
        if (!receiver || !['identifier', 'this'].includes(receiver.type))
          return issue('A computed member receiver cannot be proven unrelated.');
        if (isConstantLiteralReceiver(receiver, source, context)) continue;
        const scope = innermostRenameScope(source.parsed, receiver);
        const claim =
          scope &&
          lookupNameClaim(scope, receiver.text, context.indexes, {
            position: nodeRange(receiver),
            purpose: 'value',
          });
        const type = claim && claim.typeBinding;
        if (!type) return issue('A computed member receiver cannot be proven unrelated.');
        const owners = lookupNameClaim(type.declaredAtScope, type.rawName, context.indexes, {
          position: nodeRange(receiver),
          purpose: 'type',
        }).bindings;
        if (!owners.length || owners.some((owner) => owner.def.nodeId === context.target.ownerId))
          return issue('A computed access may denote the selected member.');
      }
    }
  },
  rewrite({ source, occurrence, newName }) {
    return occurrence.spans.map((span) => ({
      ...span,
      oldText: source.content.slice(span.start, span.start + span.length),
      newText:
        occurrence.node?.type === 'private_property_identifier'
          ? `#${newName}`
          : occurrence.node?.type === 'shorthand_property_identifier' ||
              occurrence.node?.type === 'shorthand_property_identifier_pattern'
            ? `${source.content.slice(span.start, span.start + span.length)}: ${newName}`
            : newName,
    }));
  },
  validateRewrite({ source, updated, edits }) {
    let delta = 0;
    for (const edit of edits) {
      const original = source.occurrences.find((item) =>
        item.spans.some((span) => span.start === edit.start),
      );
      const replacement = updated.occurrences.find((item) =>
        item.spans.some((span) => span.start === edit.start + delta),
      );
      if (
        original?.node &&
        jsxTagRole(original.node) &&
        (!replacement?.node || jsxTagRole(original.node) !== jsxTagRole(replacement.node))
      )
        return {
          code: 'invalid_name',
          message: 'The name changes a JSX component into an intrinsic tag.',
        };
      delta += edit.newText.length - edit.length;
    }
  },
};
