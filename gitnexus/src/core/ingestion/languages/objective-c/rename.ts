import type Parser from 'tree-sitter';
import type {
  Capture,
  CaptureMatch,
  ParsedFile,
  ReferenceSite,
  SymbolDefinition,
} from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameSemanticContext,
  RenameSource,
} from '../../rename-provider.js';
import { syntheticCapture } from '../../utils/ast-helpers.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  rangeKey,
  walkNamedNodes,
} from '../rename-tree-sitter.js';
import {
  getObjectiveCFileFacts,
  objectiveCDeclaratorName,
  objectiveCSelectorParts,
  parseContainer,
  type ObjCFileFacts,
  type ObjCMemberFact,
} from './facts.js';

/** The provider's normal source facts carry identities; this layer retains their written names. */
export interface ObjectiveCRenameEvidence {
  readonly facts: ObjCFileFacts;
  readonly symbolFamilies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly messages: ReadonlyMap<ReferenceSite, { line: number; column: number }>;
  readonly directReferences: ReadonlyMap<ReferenceSite, string>;
}
const evidence = new WeakMap<ParsedFile, ObjectiveCRenameEvidence>();
export const objectiveCRenameEvidence = (
  parsed: ParsedFile,
): ObjectiveCRenameEvidence | undefined => evidence.get(parsed);

/** Share this resolution pass's families without changing earlier evidence snapshots. */
export function setObjectiveCRenameFamilies(
  parsed: ParsedFile,
  symbolFamilies: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const existing = evidence.get(parsed);
  if (existing) evidence.set(parsed, { ...existing, symbolFamilies });
}

interface WrittenName {
  readonly name: string;
  readonly nodes: readonly Parser.SyntaxNode[];
  readonly anchor: Parser.SyntaxNode;
  readonly role?: RenameOccurrence['role'];
  readonly lexical?: boolean;
}

const names = new Set(['identifier', 'type_identifier', 'field_identifier']);
const containers = new Set(['class_interface', 'class_implementation', 'protocol_declaration']);
const methods = new Set(['method_definition', 'method_declaration']);
const nonNames = new Set([
  'self',
  'super',
  'nil',
  'Nil',
  'YES',
  'NO',
  'id',
  'Class',
  'instancetype',
]);
const keywords = new Set(
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Complex _Imaginary self super nil Nil YES NO id Class instancetype'.split(
    ' ',
  ),
);
const invalid = (message: string): RenameIssue => ({ code: 'invalid_name', message });
const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_symbol_family',
  message,
  status: 'unsupported',
});

function canonicalName(name: string, context?: { readonly definition?: SymbolDefinition }): string {
  const qualified = context?.definition?.qualifiedName;
  const category = qualified?.match(/^objc:category:([^:]+):([^:]+)$/);
  if (category && name === `${category[1]} (${category[2]})`) return category[2];
  if (qualified?.startsWith('objc:') && name === qualified.slice(qualified.lastIndexOf('.') + 1))
    name = qualified;
  if (name.startsWith('objc:method:')) return name.slice(name.search(/:[+-]:/) + 3);
  return name.startsWith('objc:') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

function capture(tag: string, node: Parser.SyntaxNode, text = node.text): Capture {
  return syntheticCapture(tag, node, text);
}

function declaration(
  kind: string,
  written: WrittenName,
  qualifiedName: string,
  bindingName = written.name,
): CaptureMatch {
  const first = written.nodes[0]!;
  const last = written.nodes.at(-1)!;
  return {
    [`@declaration.${kind}`]: capture(`@declaration.${kind}`, written.anchor),
    '@declaration.name': {
      ...capture('@declaration.name', first, written.name),
      range: {
        ...nodeRange(first),
        endLine: last.endPosition.row + 1,
        endCol: last.endPosition.column,
      },
    },
    '@declaration.qualified_name': capture('@declaration.qualified_name', first, qualifiedName),
    '@declaration.binding-name': capture('@declaration.binding-name', first, bindingName),
  };
}

function enclosing(
  node: Parser.SyntaxNode,
  types: ReadonlySet<string>,
): Parser.SyntaxNode | undefined {
  for (let current = node.parent; current; current = current.parent)
    if (types.has(current.type)) return current;
  return undefined;
}

/** Add exact declaration, lexical, and reference captures to the provider's existing facts. */
function sourceCaptures(
  root: Parser.SyntaxNode,
  facts: ObjCFileFacts,
  base: readonly CaptureMatch[],
) {
  const captures = base.filter((match) => match['@scope.module'] || match['@import.statement']);
  const written: WrittenName[] = [];
  const occupied = new Set<number>();
  const all = [
    ...walkNamedNodes(
      root,
      (node) =>
        node.type === 'comment' || node.type === 'string_literal' || node.type === 'preproc_arg',
    ),
  ];
  const ownerByNode = new Map<number, string>();
  const directReferences = new Map<string, string>();
  const addDeclaration = (
    kind: string,
    node: Parser.SyntaxNode,
    tokens: readonly Parser.SyntaxNode[],
    name: string,
    qualified: string,
    binding = name,
    lexical = false,
  ) => {
    if (!tokens.length) return;
    const item = { name, nodes: tokens, anchor: node, lexical };
    written.push(item);
    tokens.forEach((token) => occupied.add(token.id));
    captures.push(declaration(kind, item, qualified, binding));
  };
  for (const node of all) {
    if (containers.has(node.type)) {
      const identifiers = node.namedChildren.filter((child) => child.type === 'identifier');
      const first = identifiers[0];
      const fact = parseContainer(node, facts.filePath);
      if (!fact || !first) continue;
      ownerByNode.set(node.id, fact.qualifiedName);
      captures.push({ '@scope.class': capture('@scope.class', node) });
      if (fact.kind === 'extension') continue;
      const token =
        fact.kind === 'category'
          ? identifiers.find((item) => item.text === fact.categoryName)
          : first;
      if (token)
        addDeclaration(fact.label.toLowerCase(), node, [token], token.text, fact.qualifiedName);
    } else if (methods.has(node.type)) {
      const pieces = objectiveCSelectorParts(node);
      const selector = pieces
        .map((piece) => `${piece.node.text}${piece.colon ? ':' : ''}`)
        .join('');
      const owner = enclosing(node, containers);
      const qn = owner && ownerByNode.get(owner.id);
      const fact = facts.methods.find(
        (item) =>
          item.ownerQualifiedName === qn &&
          item.selector === selector &&
          item.startLine === node.startPosition.row &&
          item.methodKind === node.child(0)?.text,
      );
      if (!fact) continue;
      captures.push({ '@scope.function': capture('@scope.function', node) });
      addDeclaration(
        'method',
        node,
        pieces.map((part) => part.node),
        selector,
        fact.qualifiedName,
        `${fact.methodKind}${selector}`,
      );
    } else if (node.type === 'function_definition' || node.type === 'block_literal') {
      captures.push({ '@scope.function': capture('@scope.function', node) });
    } else if (
      node.type === 'parameter_list' &&
      node.parent?.type === 'function_declarator' &&
      enclosing(node, new Set(['parameter_declaration', 'declaration', 'function_definition']))
        ?.type !== 'function_definition'
    ) {
      // Prototype and function-pointer type parameter names end at their list.
      captures.push({ '@scope.function': capture('@scope.function', node) });
    } else if (node.type === 'compound_statement' || node.type === 'for_statement') {
      captures.push({ '@scope.block': capture('@scope.block', node) });
    }
  }
  for (const fact of [...facts.functions, ...facts.members]) {
    const type = 'kind' in fact ? (fact.kind === 'property' ? 'property' : 'variable') : 'function';
    const candidates = all.filter(
      (node) =>
        names.has(node.type) &&
        node.text === fact.name &&
        node.startPosition.row >= fact.startLine &&
        node.endPosition.row <= fact.endLine &&
        !occupied.has(node.id),
    );
    const token = candidates.find((node) => {
      const declaration = enclosing(
        node,
        new Set(
          type === 'function'
            ? ['function_declarator']
            : ['property_declaration', 'instance_variable'],
        ),
      );
      return declaration !== undefined;
    });
    if (!token) continue;
    const anchor = enclosing(
      token,
      new Set(
        type === 'function'
          ? ['function_definition', 'declaration']
          : ['property_declaration', 'instance_variable'],
      ),
    );
    if (anchor) addDeclaration(type, anchor, [token], fact.name, fact.qualifiedName);
  }
  // Parameters and locals need real ownership too: a homonym must stop lookup.
  for (const node of all) {
    let tokens: readonly Parser.SyntaxNode[] = [];
    if (node.type === 'method_parameter' || node.type === 'keyword_declarator') {
      const token = [...node.namedChildren].reverse().find((child) => child.type === 'identifier');
      if (token) tokens = [token];
    } else if (node.type === 'parameter_declaration' || node.type === 'declaration') {
      tokens = node
        .childrenForFieldName('declarator')
        .flatMap((declarator) => objectiveCDeclaratorName(declarator) ?? []);
    }
    for (const token of tokens)
      if (!occupied.has(token.id))
        addDeclaration('variable', token, [token], token.text, token.text, token.text, true);
  }
  for (const node of all) {
    if (node.type !== 'message_expression') continue;
    const pieces = objectiveCSelectorParts(node);
    if (!pieces.length) continue;
    const tokens = pieces.map((part) => part.node);
    tokens.forEach((token) => occupied.add(token.id));
    const name = pieces.map((part) => `${part.node.text}${part.colon ? ':' : ''}`).join('');
    written.push({ name, nodes: tokens, anchor: node });
    const nameCapture = declaration('method', { name, nodes: tokens, anchor: node }, name)[
      '@declaration.name'
    ]!;
    captures.push({
      '@reference.call.member': capture('@reference.call.member', node),
      '@reference.name': { ...nameCapture, name: '@reference.name' },
      '@reference.receiver': capture(
        '@reference.receiver',
        node.childForFieldName('receiver') ?? node.firstNamedChild!,
      ),
    });
  }
  for (const node of all) {
    if (!names.has(node.type) || occupied.has(node.id)) continue;
    const parent = node.parent;
    const unrelated =
      nonNames.has(node.text) ||
      parent?.type === 'property_attribute' ||
      parent?.type === 'module_import' ||
      parent?.type === 'preproc_def' ||
      parent?.type === 'preproc_function_def' ||
      parent?.type === 'labeled_statement';
    written.push({
      name: node.text,
      nodes: [node],
      anchor: node,
      role: unrelated ? 'unrelated' : 'name',
    });
    if (unrelated) continue;
    if (parent?.type === 'selector_expression') continue;
    if (parent?.type === 'property_implementation') {
      const owner = enclosing(parent, containers);
      const ownerName = owner && ownerByNode.get(owner.id);
      if (ownerName)
        directReferences.set(
          rangeKey(nodeRange(node)),
          `${node.previousSibling?.text === '=' ? 'objc:ivar' : 'objc:property'}:${ownerName}:${node.text}`,
        );
    }
    const isCall =
      parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id;
    const isType =
      node.type === 'type_identifier' ||
      (parent && containers.has(parent.type)) ||
      parent?.type === 'class_declaration';
    const tag = isCall ? '@reference.call' : isType ? '@reference.type' : '@reference.read';
    captures.push({
      [tag]: capture(tag, isCall ? parent! : node),
      '@reference.name': capture('@reference.name', node),
    });
  }
  return { captures, written, directReferences };
}

async function parseSource(
  input: Parameters<RenameProvider['parseSource']>[0],
): Promise<RenameSource> {
  let written: WrittenName[] = [];
  let facts: ObjCFileFacts | undefined;
  let directReferences = new Map<string, string>();
  const parsed = await createTreeSitterRenameSource({ isName: () => false })({
    ...input,
    languageProvider: {
      ...input.languageProvider,
      emitScopeCaptures(text, path, tree, options) {
        const base = input.languageProvider.emitScopeCaptures!(text, path, tree, options);
        facts = getObjectiveCFileFacts(path)!;
        const inventory = sourceCaptures((tree as Parser.Tree).rootNode, facts, base);
        written = inventory.written;
        directReferences = inventory.directReferences;
        return inventory.captures;
      },
    },
  });
  const definitions = new Map(
    parsed.parsed.localDefs.map((def) => [rangeKey(def.nameRange!), def]),
  );
  const references = new Map(
    parsed.parsed.referenceSites.map((site) => [rangeKey(site.nameRange!), site]),
  );
  const messages = new Map<ReferenceSite, { line: number; column: number }>();
  const occurrences: RenameOccurrence[] = written.map((item) => {
    const first = item.nodes[0]!;
    const last = item.nodes.at(-1)!;
    const range = {
      ...nodeRange(first),
      endLine: last.endPosition.row + 1,
      endCol: last.endPosition.column,
    };
    const referenceSite = references.get(rangeKey(range));
    if (referenceSite && item.anchor.type === 'message_expression')
      messages.set(referenceSite, {
        line: item.anchor.startPosition.row,
        column: item.anchor.startPosition.column,
      });
    return {
      name: item.name,
      node: first,
      range,
      role: item.role,
      spans: item.nodes.map((node) => ({
        start: node.startIndex,
        length: node.endIndex - node.startIndex,
      })),
      definitionId: definitions.get(rangeKey(range))?.nodeId,
      referenceSite,
    };
  });
  const claims = new Map<string, NonNullable<ParsedFile['scopes'][number]['nameClaims']>>();
  for (const item of written) {
    if (!item.lexical) continue;
    const token = item.nodes[0]!;
    const scope = innermostRenameScope(parsed.parsed, token);
    if (!scope) continue;
    const range = nodeRange(token);
    claims.set(scope, [
      ...(claims.get(scope) ?? []),
      {
        name: item.name,
        range,
        kind: 'binding',
        availableFrom: { startLine: range.endLine, startCol: range.endCol },
        inactive: 'outer',
      },
    ]);
  }
  const result = {
    ...parsed,
    occurrences,
    parsed: {
      ...parsed.parsed,
      scopes: parsed.parsed.scopes.map((scope) => ({
        ...scope,
        nameClaims: [...(scope.nameClaims ?? []), ...(claims.get(scope.id) ?? [])],
      })),
      captureSideChannel: { kind: 'objective-c', facts },
    },
  };
  evidence.set(result.parsed, {
    facts: facts!,
    messages,
    symbolFamilies: new Map(),
    directReferences: new Map(
      [...references].flatMap(([range, site]) =>
        directReferences.has(range) ? [[site, directReferences.get(range)!] as const] : [],
      ),
    ),
  });
  return result;
}

export const objectiveCRenameProvider: RenameProvider = {
  canonicalName,
  parseSource,
  validateName(name) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*(?::(?:[A-Za-z_][A-Za-z0-9_]*:)*)?$/.test(name) ||
      keywords.has(name)
    )
      return invalid('Choose a valid Objective-C identifier or complete selector.');
  },
  checkSafety(context) {
    const oldName = canonicalName(context.target.qualifiedName ?? '');
    const oldArity = oldName.split(':').length - 1;
    const newArity = context.newName.split(':').length - 1;
    if (context.target.type === 'Method' ? oldArity !== newArity : newArity !== 0)
      return invalid('The replacement must preserve the full Objective-C selector arity.');
    const property = propertyForTarget(context);
    const family = familyNames(context);
    if (property?.accessors?.custom)
      return unsupported(
        'This property has explicit getter/setter names; its accessor contract needs a separate rename plan.',
      );
    if (
      property &&
      [...context.files.values()].some((source) =>
        objectiveCRenameEvidence(source.parsed)?.facts.propertyImplementations?.some(
          (implementation) =>
            implementation.dynamic &&
            family.has(
              `objc:property:${implementation.ownerQualifiedName}:${implementation.property}`,
            ),
        ),
      )
    )
      return unsupported('This property uses @dynamic; runtime accessor ownership is unavailable.');
    const spellings = new Set(
      [...family]
        .filter((name): name is string => name !== undefined)
        .map((name) => canonicalName(name)),
    );
    if (property) {
      spellings.add(property.accessors?.getter ?? property.name);
      if (property.accessors?.setter) spellings.add(property.accessors.setter);
      spellings.add(`_${property.name}`);
    }
    for (const source of context.files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type === 'selector_expression') {
          const selector = node.text
            .slice(node.text.indexOf('(') + 1, node.text.lastIndexOf(')'))
            .replace(/\s+/g, '');
          if (spellings.has(selector))
            return unsupported('A selector literal has no statically bound owner.');
        }
        if (node.type === 'preproc_arg') {
          const identifiers = new Set(node.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
          if ([...spellings].some((spelling) => identifiers.has(spelling.split(':')[0])))
            return unsupported(
              'A macro body contains the selected name; expansion ownership is unavailable.',
            );
        }
        if (node.type === 'call_expression') {
          const callee = node.childForFieldName('function')?.text;
          if (
            (context.target.type === 'Class' &&
              ['NSClassFromString', 'objc_getClass', 'objc_lookUpClass'].includes(callee ?? '')) ||
            ((context.target.type === 'Method' || property) &&
              ['NSSelectorFromString', 'sel_registerName', 'sel_getUid'].includes(callee ?? ''))
          )
            return unsupported(
              'Runtime name construction prevents complete static rename coverage.',
            );
        }
      }
      if (
        (context.target.type === 'Method' || property) &&
        objectiveCRenameEvidence(source.parsed)?.facts.messages.some(
          (message) =>
            message.selector.startsWith('performSelector:') ||
            message.selector === 'methodForSelector:' ||
            message.selector === 'forwardInvocation:' ||
            (property &&
              [
                'valueForKey:',
                'setValue:forKey:',
                'valueForKeyPath:',
                'setValue:forKeyPath:',
              ].includes(message.selector)),
        )
      )
        return unsupported(
          'A runtime selector or property lookup prevents complete static rename coverage.',
        );
    }
    if (property) {
      const replacement = renamedProperty(context, property);
      if (!replacement)
        return invalid('Use the corresponding ordinary property, setter or backing-ivar name.');
      const owners = new Set([property.ownerQualifiedName]);
      for (const source of context.files.values()) {
        const facts = objectiveCRenameEvidence(source.parsed)?.facts;
        for (const member of [...(facts?.members ?? []), ...(facts?.methods ?? [])]) {
          if (family.has(member.qualifiedName)) owners.add(member.ownerQualifiedName);
        }
      }
      const replacements = new Set(
        [...owners].flatMap((owner) => [
          `objc:property:${owner}:${replacement}`,
          `objc:ivar:${owner}:_${replacement}`,
          `objc:method:${owner}:${property.accessors?.methodKind ?? '-'}:${replacement}`,
          ...(property.accessors?.setter
            ? [
                `objc:method:${owner}:${property.accessors.methodKind}:set${replacement[0].toUpperCase()}${replacement.slice(1)}:`,
              ]
            : []),
        ]),
      );
      if (
        context.definitions.some(
          (def) => !family.has(def.qualifiedName) && replacements.has(def.qualifiedName ?? ''),
        )
      )
        return {
          code: 'name_collision',
          message: 'The replacement conflicts with a property accessor or backing ivar.',
        };
    }
    const prefix = context.target.qualifiedName?.slice(0, -oldName.length);
    if (context.definitions.some((def) => def.qualifiedName === `${prefix}${context.newName}`))
      return {
        code: 'name_collision',
        message: 'The replacement already names a declaration on this Objective-C owner.',
      };
  },
  symbolFamily(context) {
    const family = familyNames(context);
    return context.definitions.filter((definition) => family.has(definition.qualifiedName));
  },
  checkOccurrence({ occurrence, selected }) {
    if (!selected || !occurrence.node) return;
    const selector = enclosing(occurrence.node, new Set([...methods, 'message_expression']));
    if (!selector) return;
    const parts = objectiveCSelectorParts(selector);
    if (!parts.some((part) => part.node.id === occurrence.node!.id)) return;
    const arity =
      selector.type === 'message_expression'
        ? selector.children.filter((child) => child.text === ':').length
        : selector.namedChildren.filter(
            (child) => child.type === 'method_parameter' || child.type === 'keyword_declarator',
          ).length;
    if (arity !== parts.filter((part) => part.colon).length)
      return unsupported(
        'The selected selector contains an unnamed piece whose complete source shape is not represented.',
      );
  },
  rewrite(context) {
    const { source, occurrence } = context;
    let { newName } = context;
    const property = propertyForTarget(context);
    if (property) {
      const replacement = renamedProperty(context, property)!;
      newName =
        occurrence.name === property.accessors?.setter
          ? `set${replacement[0].toUpperCase()}${replacement.slice(1)}:`
          : occurrence.name === `_${property.name}`
            ? `_${replacement}`
            : occurrence.name === property.name || occurrence.name === property.accessors?.getter
              ? replacement
              : occurrence.name;
    }
    const parts = newName.endsWith(':') ? newName.slice(0, -1).split(':') : [newName];
    if (parts.length !== occurrence.spans.length)
      return invalid('The replacement does not match the written selector shape.');
    return occurrence.spans
      .map((span, index) => ({
        ...span,
        oldText: source.content.slice(span.start, span.start + span.length),
        newText: parts[index]!,
      }))
      .filter((replacement) => replacement.oldText !== replacement.newText);
  },
};

function familyNames(context: RenameSemanticContext): Set<string | undefined> {
  const qualified = context.target.qualifiedName;
  const family = new Set([qualified]);
  for (const source of context.files.values()) {
    for (const member of objectiveCRenameEvidence(source.parsed)?.symbolFamilies.get(
      qualified ?? '',
    ) ?? [])
      family.add(member);
  }
  return family;
}

function propertyForTarget(context: RenameSemanticContext): ObjCMemberFact | undefined {
  const family = familyNames(context);
  const properties: ObjCMemberFact[] = [];
  for (const source of context.files.values()) {
    properties.push(
      ...(objectiveCRenameEvidence(source.parsed)?.facts.members.filter(
        (member) => member.kind === 'property' && family.has(member.qualifiedName),
      ) ?? []),
    );
  }
  return (
    properties.find((property) => property.accessors?.custom) ??
    properties.find((property) => property.accessors?.setter) ??
    properties[0]
  );
}

function renamedProperty(
  context: RenameSemanticContext,
  property: ObjCMemberFact,
): string | undefined {
  const oldName = canonicalName(context.target.qualifiedName ?? '');
  if (oldName === property.accessors?.setter) {
    if (!/^set[A-Z][A-Za-z0-9_]*:$/.test(context.newName)) return undefined;
    const suffix = context.newName.slice(3, -1);
    return suffix[0].toLowerCase() + suffix.slice(1);
  }
  if (oldName === `_${property.name}`)
    return context.newName.startsWith('_') ? context.newName.slice(1) : undefined;
  return context.newName;
}
