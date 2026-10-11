import type Parser from 'tree-sitter';
import type { NameClaim } from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
} from '../../scope-resolution/graph-bridge/node-lookup.js';

const keywords = new Set(
  'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(
    ' ',
  ),
);
const names = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'package_identifier',
  'label_name',
]);
function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (node.type === 'label_name' || parent?.type === 'package_clause') return 'unrelated';
  if (parent?.type === 'import_spec') return 'alias';
  if (
    parent &&
    [
      'parameter_declaration',
      'variadic_parameter_declaration',
      'type_parameter_declaration',
    ].includes(parent.type) &&
    node.type === 'identifier'
  )
    return 'binding';
  return 'name';
}

const parseSource = createTreeSitterRenameSource({
  isName: (node) => names.has(node.type),
  skip: (node) => node.type === 'comment',
  role,
  reference,
});

function withLexicalClaims(source: RenameSource): RenameSource {
  const parameters = new Map<string, NameClaim[]>();
  for (const occurrence of source.occurrences) {
    if (occurrence.role !== 'binding' || !occurrence.node) continue;
    const scope = innermostRenameScope(source.parsed, occurrence.node);
    if (scope)
      parameters.set(scope, [
        ...(parameters.get(scope) ?? []),
        {
          name: occurrence.name,
          range: occurrence.range,
          kind: 'binding',
          purpose: 'value',
          hoisted: true,
        },
      ]);
  }
  return {
    ...source,
    parsed: {
      ...source.parsed,
      scopes: source.parsed.scopes.map((scope) => {
        const claims: NameClaim[] = [
          ...(scope.nameClaims ?? []),
          ...(parameters.get(scope.id) ?? []),
        ];
        for (const [name, bindings] of scope.bindings)
          for (const binding of bindings) {
            const { def } = binding;
            if (
              binding.origin !== 'local' ||
              !['Variable', 'Const'].includes(def.type) ||
              !def.declarationRange
            )
              continue;
            claims.push({
              name,
              range: def.nameRange ?? def.declarationRange,
              kind: 'binding',
              purpose: 'value',
              ...(scope.kind === 'Module'
                ? { hoisted: true }
                : {
                    inactive: 'outer',
                    availableFrom: {
                      startLine: def.declarationRange.endLine,
                      startCol: def.declarationRange.endCol,
                    },
                  }),
            });
          }
        return { ...scope, nameClaims: claims };
      }),
    },
  };
}
function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    node.type === 'field_identifier' ||
    node.type === 'label_name' ||
    parent.type === 'import_spec' ||
    parent.type === 'package_clause'
  )
    return undefined;
  if (
    parent.childForFieldName('name')?.id === node.id &&
    ['function_declaration', 'method_declaration', 'var_spec', 'const_spec', 'type_spec'].includes(
      parent.type,
    )
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  return {
    name: node.text,
    nameRange: range,
    atRange: range,
    inScope,
    kind: 'read' as const,
    ...(node.type === 'type_identifier' ? { lookupPurpose: 'type' as const } : {}),
  };
}

export const goRenameProvider: RenameProvider = {
  matchesGraphIdentity({ definition, node, graph, files }) {
    const ownName = definition.qualifiedName;
    if (!ownName) return false;
    const packageName = files
      .get(definition.filePath)
      ?.tree?.rootNode.namedChildren.find((child) => child.type === 'package_clause')
      ?.namedChildren.find((child) => child.type === 'package_identifier')?.text;
    if (node.properties.qualifiedName)
      return (
        node.properties.qualifiedName === (packageName ? `${packageName}.${ownName}` : ownName)
      );
    return (
      buildGraphNodeLookup(graph).get(qualifiedKey(definition.filePath, node.label, ownName)) ===
      node.id
    );
  },
  symbolFamily(context) {
    return graphRenameFamily(context, {
      matches: (left, right) =>
        !!left.ownerId &&
        !!right.ownerId &&
        simpleQualifiedName(left) === simpleQualifiedName(right) &&
        left.parameterCount === right.parameterCount,
    });
  },
  validateName(name) {
    if (!/^[_\p{L}][_\p{L}\p{Nd}]*$/u.test(name) || name === '_' || keywords.has(name))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved Go identifier.' };
  },
  parseSource: async (input) => withLexicalClaims(await parseSource(input)),
};
