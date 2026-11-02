import type Parser from 'tree-sitter';
import { CLASS_KINDS, type NameClaim, type ReferenceSite } from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { graphRenameFamily } from '../rename-family.js';
import { isRubySingleton } from './member-dispatch.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  rangeKey,
  walkNamedNodes,
} from '../rename-tree-sitter.js';

const keywords = new Set(
  'BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (
    parent &&
    ['method_parameters', 'block_parameters', 'lambda_parameters'].includes(parent.type)
  )
    return 'binding';
  if (
    parent &&
    [
      'optional_parameter',
      'keyword_parameter',
      'splat_parameter',
      'hash_splat_parameter',
      'block_parameter',
    ].includes(parent.type) &&
    parent.childForFieldName('name')?.id === node.id
  )
    return 'binding';
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource): ReferenceSite | undefined {
  const parent = node.parent;
  if (
    !parent ||
    (['method', 'singleton_method', 'class', 'module'].includes(parent.type) &&
      parent.childForFieldName('name')?.id === node.id)
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  const qualified =
    parent.type === 'scope_resolution' && parent.childForFieldName('name')?.id === node.id
      ? parent.text
      : undefined;
  return {
    name: node.text,
    nameRange: range,
    atRange: range,
    inScope,
    kind: node.type === 'constant' ? 'type-reference' : 'read',
    ...(qualified ? { rawQualifiedName: qualified } : {}),
  };
}

const parseSource = createTreeSitterRenameSource({
  isName: (node) =>
    node.type === 'setter' ||
    (['identifier', 'constant', 'instance_variable', 'class_variable', 'global_variable'].includes(
      node.type,
    ) &&
      node.parent?.type !== 'setter'),
  skip: (node) => node.type === 'comment',
  role,
  reference,
});

export const rubyRenameProvider: RenameProvider = {
  validateName(name) {
    if (!/^[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{M}]*[!?=]?$/u.test(name) || keywords.has(name))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved Ruby identifier.' };
  },
  async parseSource(input) {
    const source = await parseSource(input);
    const setters = new Map(
      source.occurrences.flatMap((occurrence) => {
        const call = occurrence.node?.parent;
        const assignment = call?.parent;
        return call?.type === 'call' &&
          assignment?.type === 'assignment' &&
          assignment.childForFieldName('left')?.id === call.id &&
          call.childForFieldName('method')?.id === occurrence.node?.id
          ? [[rangeKey(occurrence.range), occurrence] as const]
          : [];
      }),
    );
    const referenceSites = source.parsed.referenceSites.flatMap((site) => {
      const setter = site.nameRange && setters.get(rangeKey(site.nameRange));
      if (!setter) return [site];
      if (site.kind === 'call') return [];
      return [
        {
          ...site,
          name: `${site.name}=`,
          kind: 'call' as const,
          callForm: 'member' as const,
          arity: 1,
        },
      ];
    });
    const claims = new Map<string, NameClaim[]>();
    for (const occurrence of source.occurrences) {
      if (occurrence.role !== 'binding' || !occurrence.node) continue;
      const scope = innermostRenameScope(source.parsed, occurrence.node);
      if (!scope) continue;
      claims.set(scope, [
        ...(claims.get(scope) ?? []),
        {
          name: occurrence.name,
          range: occurrence.range,
          kind: 'binding',
          hoisted: true,
          purpose: 'value',
        },
      ]);
    }
    return {
      ...source,
      occurrences: source.occurrences.map((occurrence) =>
        setters.has(rangeKey(occurrence.range))
          ? {
              ...occurrence,
              name: `${occurrence.name}=`,
              referenceSite: referenceSites.find(
                (site) => site.nameRange && rangeKey(site.nameRange) === rangeKey(occurrence.range),
              ),
            }
          : occurrence,
      ),
      parsed: {
        ...source.parsed,
        referenceSites,
        scopes: source.parsed.scopes.map((scope) => ({
          ...scope,
          nameClaims: [...(scope.nameClaims ?? []), ...(claims.get(scope.id) ?? [])],
        })),
      },
    };
  },
  symbolFamily(context) {
    return graphRenameFamily(context, {
      matches: (left, right) =>
        left.type === 'Method' &&
        right.type === 'Method' &&
        simpleQualifiedName(left) === simpleQualifiedName(right) &&
        isRubySingleton(left) === isRubySingleton(right),
    });
  },
  checkSafety({ target, newName, files, indexes }) {
    if (CLASS_KINDS.includes(target.type) && !/^[A-Z]/.test(newName))
      return {
        code: 'invalid_name',
        message: 'Ruby constants must begin with an uppercase letter.',
      };
    if (simpleQualifiedName(target)?.endsWith('=') !== newName.endsWith('='))
      return { code: 'invalid_name', message: 'A Ruby setter must keep its trailing equals sign.' };
    if (target.type !== 'Method' && target.type !== 'Function') return;
    for (const source of files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (
          node.type !== 'call' ||
          !['send', '__send__', 'public_send', 'method', 'public_method'].includes(
            node.childForFieldName('method')?.text ?? '',
          )
        )
          continue;
        const selector = node.childForFieldName('arguments')?.firstNamedChild;
        const literal =
          selector?.type === 'simple_symbol'
            ? selector.text.slice(1)
            : selector?.type === 'string' && selector.firstNamedChild?.type === 'string_content'
              ? selector.firstNamedChild.text
              : undefined;
        if (literal && literal !== simpleQualifiedName(target)) continue;
        const receiver = node.childForFieldName('receiver');
        const scope = innermostRenameScope(source.parsed, receiver ?? node);
        const type =
          scope &&
          lookupNameClaim(scope, receiver?.text ?? 'self', indexes, {
            position: nodeRange(node),
            purpose: 'value',
          }).typeBinding;
        const owners = type
          ? lookupNameClaim(type.declaredAtScope, type.rawName, indexes, {
              position: nodeRange(node),
              purpose: 'type',
            }).bindings
          : [];
        if (
          target.ownerId &&
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
          message: 'Dynamic Ruby dispatch may refer to the selected declaration.',
        };
      }
    }
  },
  rewrite({ source, occurrence, newName }) {
    const assignment = occurrence.node?.parent?.parent;
    const implicitSetter =
      occurrence.name.endsWith('=') &&
      occurrence.node?.type !== 'setter' &&
      assignment?.type === 'assignment';
    return occurrence.spans.map((span) => ({
      ...span,
      oldText: source.content.slice(span.start, span.start + span.length),
      newText: implicitSetter ? newName.replace(/=$/, '') : newName,
    }));
  },
};
