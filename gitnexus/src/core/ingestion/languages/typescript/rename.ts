import type Parser from 'tree-sitter';
import { CLASS_KINDS, SupportedLanguages, type TypeRef } from 'gitnexus-shared';
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
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';

export const canonicalTypeScriptName = (name: string): string =>
  name.replace(
    /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
    (escape, braced: string | undefined, fixed: string | undefined) => {
      const value = Number.parseInt(braced ?? fixed!, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
    },
  );
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
    if (node.type === 'member_expression') return false;
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

function checkReceiver(context: RenameOccurrenceContext): RenameIssue | void {
  const { site, indexes, files } = context;
  if (!site?.explicitReceiver) return;
  const name = site.explicitReceiver.name;
  const claim = lookupNameClaim(site.inScope, name, indexes, {
    position: site.atRange,
    purpose: 'value',
  });
  const type = claim.typeBinding;
  if (!type) return;
  const source = claim.scope && files.get(claim.scope.filePath);
  if (!source?.tree)
    return issue('The receiver has no inspectable source binding.', 'ambiguous_reference');
  if (
    type.source === 'decorator-unknown' ||
    (type.declaredSpelling && type.declaredSpelling !== type.rawName)
  )
    return issue('The receiver type does not prove an object identity.', 'ambiguous_reference');
  const constructor = receiverConstructor(source.tree.rootNode, name, type);
  if (type.source !== 'self') {
    const scope = constructor && innermostRenameScope(source.parsed, constructor);
    const owners =
      constructor?.type === 'identifier' && scope
        ? lookupNameClaim(scope, canonicalTypeScriptName(constructor.text), indexes, {
            position: nodeRange(constructor),
            purpose: 'value',
          }).bindings
        : [];
    const expected = lookupNameClaim(type.declaredAtScope, type.rawName, indexes, {
      position: type.lookupPosition ?? site.atRange,
      purpose: 'type',
    }).bindings;
    const ids = new Set(
      owners
        .filter((owner) => CLASS_KINDS.includes(owner.def.type))
        .map((owner) => owner.def.nodeId),
    );
    if (ids.size !== 1 || !expected.some((owner) => ids.has(owner.def.nodeId)))
      return issue(
        'A structural type annotation cannot prove the receiver constructor.',
        'ambiguous_reference',
      );
  }
  for (const occurrence of source.occurrences) {
    const node = occurrence.node;
    if (occurrence.name !== name || !node || !receiverWrite(node)) continue;
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
      lookupNameClaim(scope, name, indexes, { position: nodeRange(node), purpose: 'value' });
    if (
      !written ||
      !written.scope ||
      written.claims.length === 0 ||
      written.scope.id === claim.scope?.id
    )
      return issue('The receiver binding is reassigned.', 'ambiguous_reference');
  }
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
