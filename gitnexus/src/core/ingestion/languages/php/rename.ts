import type Parser from 'tree-sitter';
import {
  CLASS_KINDS,
  type BindingRef,
  type ParsedFile,
  type ReferenceSite,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { graphRenameFamily } from '../rename-family.js';
import { extractMixedChain } from '../../utils/call-analysis.js';
import { encodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  walkNamedNodes,
} from '../rename-tree-sitter.js';

const keywords = new Set(
  'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'.split(
    ' ',
  ),
);

function insensitiveDefinition(definition: SymbolDefinition): boolean {
  return (
    CLASS_KINDS.includes(definition.type) ||
    ((definition.type === 'Function' || definition.type === 'Method') &&
      !simpleQualifiedName(definition)?.startsWith('$'))
  );
}

function canonicalBindings(parsed: ParsedFile): ParsedFile {
  return {
    ...parsed,
    scopes: parsed.scopes.map((scope) => {
      const bindings = new Map<string, BindingRef[]>();
      for (const [name, values] of scope.bindings)
        for (const value of values) {
          const key = insensitiveDefinition(value.def) ? name.toLowerCase() : name;
          bindings.set(key, [...(bindings.get(key) ?? []), value]);
        }
      return {
        ...scope,
        bindings,
        typeBindings: new Map(
          [...scope.typeBindings].map(([name, type]) => [
            name,
            {
              ...type,
              rawName: type.rawName.startsWith('$') ? type.rawName : type.rawName.toLowerCase(),
            },
          ]),
        ),
      };
    }),
    parsedImports: parsed.parsedImports.map((entry) =>
      (entry.kind === 'named' || entry.kind === 'alias') && entry.importedSymbolKind !== 'const'
        ? {
            ...entry,
            localName: entry.localName.toLowerCase(),
            importedName: entry.importedName.toLowerCase(),
            ...(entry.kind === 'alias' ? { alias: entry.alias.toLowerCase() } : {}),
          }
        : entry,
    ),
    referenceSites: parsed.referenceSites.map((site) => ({
      ...site,
      name:
        site.kind === 'call' || site.kind === 'type-reference' || site.kind === 'inherits'
          ? site.name.toLowerCase()
          : site.name,
      ...(site.explicitReceiver && !site.explicitReceiver.name.startsWith('$')
        ? { explicitReceiver: { name: site.explicitReceiver.name.toLowerCase() } }
        : {}),
    })),
  };
}

function importClause(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'namespace_use_clause') return parent;
    if (parent.type === 'namespace_use_declaration') break;
  }
  return undefined;
}

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const clause = importClause(node);
  if (clause)
    return clause.childForFieldName('alias')?.id === node.id ||
      (clause.namedChildCount > 1 && clause.lastNamedChild?.id === node.id)
      ? 'alias'
      : 'imported';
  const parent = node.parent;
  if (parent?.type === 'namespace_name' || parent?.type === 'namespace_definition')
    return 'unrelated';
  if (
    node.type === 'variable_name' &&
    parent &&
    ['simple_parameter', 'variadic_parameter'].includes(parent.type)
  )
    return 'binding';
  if (parent?.type === 'argument' && parent.childForFieldName('name')?.id === node.id)
    return 'unrelated';
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource): ReferenceSite | undefined {
  const parent = node.parent;
  if (
    !parent ||
    (/declaration|definition/.test(parent.type) && parent.childForFieldName('name')?.id === node.id)
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  if (
    parent.type === 'member_access_expression' &&
    parent.childForFieldName('name')?.id === node.id
  ) {
    const receiver = parent.childForFieldName('object');
    const chain = receiver && extractMixedChain(receiver);
    const receiverChain = chain?.baseReceiverName
      ? encodeReceiverChain(chain.baseReceiverName, chain.chain)
      : undefined;
    return receiver
      ? {
          name: node.text,
          nameRange: range,
          atRange: nodeRange(parent),
          inScope,
          kind: 'read',
          explicitReceiver: { name: receiver.text },
          ...(receiverChain ? { receiverChain } : {}),
        }
      : undefined;
  }
  return {
    name: parent.type === 'named_type' ? node.text.toLowerCase() : node.text,
    nameRange: range,
    atRange: range,
    inScope,
    kind: parent.type === 'named_type' ? 'type-reference' : 'read',
  };
}

export const phpRenameProvider: RenameProvider = {
  canonicalName(name, context) {
    const definition = context?.definition;
    if (definition && insensitiveDefinition(definition)) return name.toLowerCase();
    const node = context?.occurrence?.node;
    if (node && importClause(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.children.some((child) => child.type === 'const')) return name;
        if (parent.type === 'namespace_use_declaration') break;
      }
      return name.toLowerCase();
    }
    if (
      node?.type === 'variable_name' &&
      [
        'property_element',
        'property_promotion_parameter',
        'scoped_property_access_expression',
      ].includes(node.parent?.type ?? '')
    )
      return name.replace(/^\$/, '');
    return context?.site?.kind === 'call' ||
      (node?.type === 'name' &&
        /call_expression|object_creation_expression|named_type|class_declaration|method_declaration|function_definition/.test(
          node.parent?.type ?? '',
        ))
      ? name.toLowerCase()
      : name;
  },
  validateName(name) {
    if (
      !/^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*$/.test(name) ||
      keywords.has(name.toLowerCase())
    )
      return { code: 'invalid_name', message: 'Choose a valid nonreserved PHP identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) =>
      node.type === 'variable_name' ||
      (node.type === 'name' && node.parent?.type !== 'variable_name'),
    skip: (node) => node.type === 'comment',
    role,
    transformParsed: canonicalBindings,
    reference,
  }),
  symbolFamily(context) {
    return graphRenameFamily(context, {
      matches: (left, right) =>
        left.type === 'Method' &&
        right.type === 'Method' &&
        simpleQualifiedName(left)?.toLowerCase() === simpleQualifiedName(right)?.toLowerCase(),
    });
  },
  checkSafety({ target, newName, files, indexes }) {
    if (
      CLASS_KINDS.includes(target.type) &&
      target.filePath
        .split('/')
        .at(-1)
        ?.replace(/\.php$/i, '') === simpleQualifiedName(target) &&
      newName !== simpleQualifiedName(target) &&
      [...indexes.imports.values()].some((imports) =>
        imports.some((entry) => entry.targetDefId === target.nodeId),
      )
    )
      return {
        code: 'unsupported_occurrence',
        status: 'unsupported',
        message: 'Renaming this PHP class import also requires its autoload filename to change.',
      };
    for (const source of files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (target.type === 'Function' && node.type === 'function_call_expression') {
          const selector = node.childForFieldName('function');
          if (selector && !['name', 'qualified_name', 'relative_name'].includes(selector.type)) {
            const literal =
              selector.namedChildCount === 1 && selector.firstNamedChild?.type === 'string_content'
                ? selector.firstNamedChild.text
                : undefined;
            if (literal && literal.toLowerCase() !== simpleQualifiedName(target)?.toLowerCase())
              continue;
            const scope = innermostRenameScope(source.parsed, selector);
            const bindings = scope
              ? lookupNameClaim(scope, selector.text, indexes, {
                  position: nodeRange(selector),
                  purpose: 'value',
                }).bindings
              : [];
            if (
              bindings.length &&
              bindings.every(({ def }) => def.type === 'Function' && def.nodeId !== target.nodeId)
            )
              continue;
            return {
              code: 'unsupported_occurrence',
              status: 'unsupported',
              message: 'Dynamic PHP calls may refer to the selected function.',
            };
          }
        }
        if (!target.ownerId) continue;
        if (
          ![
            'member_call_expression',
            'nullsafe_member_call_expression',
            'member_access_expression',
            'nullsafe_member_access_expression',
          ].includes(node.type)
        )
          continue;
        const name = node.childForFieldName('name');
        if (!name || name.type === 'name') continue;
        const literal =
          name.namedChildCount === 1 && name.firstNamedChild?.type === 'string_content'
            ? name.firstNamedChild.text
            : undefined;
        if (
          literal &&
          (target.type === 'Method'
            ? literal.toLowerCase() !== simpleQualifiedName(target)?.toLowerCase()
            : literal !== simpleQualifiedName(target))
        )
          continue;
        const receiver = node.childForFieldName('object');
        const scope = receiver && innermostRenameScope(source.parsed, receiver);
        const type =
          scope &&
          receiver &&
          lookupNameClaim(scope, receiver.text, indexes, {
            position: nodeRange(receiver),
            purpose: 'value',
          }).typeBinding;
        const owners = type
          ? lookupNameClaim(type.declaredAtScope, type.rawName, indexes, {
              position: nodeRange(node),
              purpose: 'type',
            }).bindings
          : [];
        if (
          owners.length &&
          owners.every(
            ({ def }) =>
              def.nodeId !== target.ownerId &&
              !indexes.methodDispatch.mroFor(def.nodeId).includes(target.ownerId!) &&
              !indexes.methodDispatch.mroFor(target.ownerId!).includes(def.nodeId),
          )
        )
          continue;
        return {
          code: 'unsupported_occurrence',
          status: 'unsupported',
          message: 'Dynamic PHP member access may refer to the selected declaration.',
        };
      }
    }
  },
  rewrite({ source, occurrence, newName }) {
    return occurrence.spans.map((span) => ({
      ...span,
      oldText: source.content.slice(span.start, span.start + span.length),
      newText: occurrence.node?.type === 'variable_name' ? `$${newName}` : newName,
    }));
  },
};
