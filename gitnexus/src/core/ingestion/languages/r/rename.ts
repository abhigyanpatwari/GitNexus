import type { NameClaim } from 'gitnexus-shared';
import type { RenameIssue, RenameProvider } from '../../rename-provider.js';
import {
  createTreeSitterRenameSource,
  innermostRenameScope,
  walkNamedNodes,
} from '../rename-tree-sitter.js';

/**
 * Conservative semantic rename for R. Plain functions are renamed through the
 * scope-resolution graph. R binds names dynamically (S3/S4/R6 dispatch, strings,
 * NAMESPACE), so every declaration or name that the graph cannot prove is refused.
 */
const RESERVED = new Set(
  'if else repeat while function for next break TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_character_ NA_complex_ in'.split(
    ' ',
  ),
);

const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_occurrence',
  status: 'unsupported',
  message,
});

const parseNames = createTreeSitterRenameSource({
  isName: (node) => node.type === 'identifier',
  skip: (node) => node.type === 'comment',
  role: (node) =>
    node.parent?.type === 'parameter' && node.parent.childForFieldName('name')?.id === node.id
      ? 'binding'
      : 'name',
});

export const rRenameProvider: RenameProvider = {
  validateName(name) {
    if (!/^(?:[A-Za-z]|\.(?![0-9]))[A-Za-z0-9._]*$/.test(name) || RESERVED.has(name))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved R identifier.' };
  },
  async parseSource(input) {
    const source = await parseNames(input);
    // Parameters shadow same-named functions: claim them per scope so the engine
    // leaves an unrelated parameter alone.
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
      parsed: {
        ...source.parsed,
        scopes: source.parsed.scopes.map((scope) => ({
          ...scope,
          nameClaims: [...(scope.nameClaims ?? []), ...(claims.get(scope.id) ?? [])],
        })),
      },
    };
  },
  checkSafety({ target, newName, files, graph }) {
    const name = target.qualifiedName ?? '';
    if (target.type !== 'Function')
      return unsupported('Only plain R functions can be renamed; classes and members are refused.');
    const defined = new Set(
      [...files.values()].flatMap((source) => source.parsed.localDefs.map((d) => d.qualifiedName)),
    );
    if (newName.includes('.') && defined.has(newName.slice(0, newName.indexOf('.'))))
      return unsupported('The new name would register an S3 method of an existing function.');
    for (const source of files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        if (node.type === 'string_content' && (node.text === name || node.text === newName))
          return unsupported(
            'A string literal spells this name; S3, S4, R6 and dynamic lookup resolve it by string.',
          );
      }
    }
    // NAMESPACE is not an indexed source. A package function that the NAMESPACE
    // exports (the graph keeps isExported unless it is proven private) is refused.
    const file = target.filePath;
    let exported = false;
    graph.forEachNode((node) => {
      if (
        node.properties.filePath === file &&
        node.properties.name === name &&
        node.properties.isExported !== false
      )
        exported = true;
    });
    if (exported && /(^|\/)R\//.test(file))
      return unsupported(
        'A package function may have a NAMESPACE export entry that is not renamed.',
      );
  },
};
