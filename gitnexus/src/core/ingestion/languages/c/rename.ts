import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameSemanticContext,
  RenameSource,
} from '../../rename-provider.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
  walkNamedNodes,
} from '../rename-tree-sitter.js';
import { callableDeclarationFamilies } from '../../scope-resolution/passes/callable-value-flow.js';
import { buildGraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { isStaticName } from './static-linkage.js';
import { isFileLocal } from '../cpp/file-local-linkage.js';

export const cKeywords = new Set(
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local alignas alignof bool constexpr false nullptr static_assert thread_local true typeof typeof_unqual _BitInt'.split(
    ' ',
  ),
);
const names = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'statement_identifier',
]);

export function checkCMacroSafety(context: RenameSemanticContext): RenameIssue | void {
  const targetName = simpleQualifiedName(context.target);
  for (const source of context.files.values()) {
    if (!source.tree) continue;
    for (const node of walkNamedNodes(source.tree.rootNode)) {
      if (node.type !== 'preproc_arg') continue;
      // Macro replacement lists are opaque to tree-sitter. Inventory their
      // identifier tokens, but never infer a binding or rewrite an expansion.
      const tokens: readonly string[] =
        node.text.match(
          /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[_\p{ID_Start}][_\p{ID_Continue}]*/gu,
        ) ?? [];
      if (tokens.includes(targetName ?? ''))
        return {
          code: 'unsupported_occurrence',
          status: 'unsupported',
          message: 'A macro replacement list contains this name without a proven source binding.',
        };
    }
  }
}

export function cNameRole(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  if (node.type === 'statement_identifier') return 'unrelated';
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'parameter_declaration') {
      const declarator = parent.childForFieldName('declarator');
      if (
        declarator &&
        node.startIndex >= declarator.startIndex &&
        node.endIndex <= declarator.endIndex
      )
        return 'binding';
      break;
    }
    if (!parent.type.includes('declarator')) break;
  }
  return 'name';
}

export function cNameReference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    node.type === 'field_identifier' ||
    node.type === 'statement_identifier' ||
    parent.type.startsWith('preproc_')
  )
    return undefined;
  if (
    parent.childForFieldName('declarator')?.id === node.id ||
    (parent.childForFieldName('name')?.id === node.id &&
      ['enum_specifier', 'struct_specifier', 'union_specifier'].includes(parent.type) &&
      parent.childForFieldName('body'))
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

/** Parameters shadow outer values even when their primitive type is not indexed. */
export function withParameterClaims(source: RenameSource): RenameSource {
  const claims = new Map<string, RenameSource['parsed']['scopes'][number]['nameClaims']>();
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
        purpose: 'value',
        hoisted: true,
      },
    ]);
  }
  return {
    ...source,
    parsed: {
      ...source.parsed,
      scopes: source.parsed.scopes.map((scope) => ({
        ...scope,
        nameClaims: [...(scope.nameClaims ?? []), ...(claims.get(scope.id) ?? [])],
      })),
    },
  };
}

/** C local values enter scope after their declarator, including inside an initializer. */
function withLocalValueClaims(source: RenameSource): RenameSource {
  const occurrences = new Map(
    source.occurrences
      .filter((occurrence) => occurrence.definitionId)
      .map((occurrence) => [occurrence.definitionId, occurrence]),
  );
  return {
    ...source,
    parsed: {
      ...source.parsed,
      scopes: source.parsed.scopes.map((scope) => {
        const claims = [...(scope.nameClaims ?? [])];
        for (const [name, bindings] of scope.bindings) {
          for (const { origin, def } of bindings) {
            if (origin !== 'local' || !['Variable', 'Const'].includes(def.type)) continue;
            const occurrence = occurrences.get(def.nodeId);
            if (!occurrence?.node) continue;
            let declarator = occurrence.node;
            while (
              declarator.parent?.type.includes('declarator') &&
              declarator.parent.type !== 'init_declarator'
            )
              declarator = declarator.parent;
            const range = nodeRange(declarator);
            claims.push({
              name,
              range: occurrence.range,
              kind: 'binding',
              purpose: 'value',
              inactive: 'outer',
              availableFrom: { startLine: range.endLine, startCol: range.endCol },
            });
          }
        }
        return { ...scope, nameClaims: claims };
      }),
    },
  };
}

const parseSource = createTreeSitterRenameSource({
  isName: (node) => names.has(node.type),
  skip: (node) => node.type === 'comment',
  role: cNameRole,
  reference: cNameReference,
});

export const cRenameProvider: RenameProvider = {
  checkSafety: checkCMacroSafety,
  acceptsSourceProvider: (provider, filePath) =>
    provider.id === SupportedLanguages.C ||
    (provider.id === SupportedLanguages.CPlusPlus && filePath.endsWith('.h')),
  symbolFamily(context) {
    return (
      callableDeclarationFamilies(
        context.indexes,
        context.graph,
        buildGraphNodeLookup(context.graph),
        (def) =>
          isStaticName(def.filePath, simpleQualifiedName(def) ?? '') ||
          isFileLocal(def.filePath, simpleQualifiedName(def) ?? ''),
      ).get(context.target.nodeId) ?? [context.target]
    );
  },
  validateName(name) {
    if (!/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name) || cKeywords.has(name))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved C identifier.' };
  },
  parseSource: async (input) => withLocalValueClaims(withParameterClaims(await parseSource(input))),
};
