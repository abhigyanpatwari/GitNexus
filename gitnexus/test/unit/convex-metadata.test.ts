import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { ParsedImport } from 'gitnexus-shared';
import { extractConvexEndpointProperties } from '../../src/core/ingestion/languages/typescript/convex-endpoint-metadata.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

const parser = new Parser();
parser.setLanguage(TypeScript.typescript as Parameters<Parser['setLanguage']>[0]);

function declaration(source: string): SyntaxNode {
  const root = parser.parse(source).rootNode as unknown as SyntaxNode;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'lexical_declaration') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  throw new Error('fixture has no lexical_declaration');
}

const namedImport = (
  targetRaw: string,
  importedName: string,
  localName = importedName,
): ParsedImport => ({
  kind: localName === importedName ? 'named' : 'alias',
  targetRaw,
  importedName,
  localName,
  ...(localName === importedName ? {} : { alias: localName }),
});

function extract(source: string, imports: readonly ParsedImport[], isExported = true) {
  return extractConvexEndpointProperties({
    nodeLabel: 'Const',
    nodeName: 'updateDraft',
    definitionNode: declaration(source),
    parsedImports: imports,
    isExported,
  });
}

describe('Convex endpoint metadata extraction', () => {
  it('uses AST shape and direct convex/server provenance across line-comment trivia', () => {
    expect(
      extract(
        `export const updateDraft = // legal trivia\n mutation({ handler: async () => null });`,
        [namedImport('convex/server', 'mutation')],
      ),
    ).toEqual({ convexEndpointFactory: 'mutation' });
  });

  it('preserves the canonical factory through a generated-server import alias', () => {
    expect(
      extract(`export const updateDraft = write({ handler: async () => null });`, [
        namedImport('../_generated/server', 'internalMutation', 'write'),
      ]),
    ).toEqual({ convexEndpointFactory: 'internalMutation' });
  });

  it.each([
    ['unrelated import', [namedImport('./database', 'query')], true],
    ['bare generated-server package', [namedImport('_generated/server', 'query')], true],
    ['generated-server lookalike', [namedImport('./rpc/_generated/server', 'query')], true],
    ['unexported declaration', [namedImport('convex/server', 'query')], false],
  ] as const)('rejects %s', (_case, imports, isExported) => {
    expect(
      extract(`export const updateDraft = query({ handler: () => null });`, imports, isExported),
    ).toBeUndefined();
  });

  it.each([
    'export const updateDraft = sdk.query({ handler: () => null });',
    'export const updateDraft = wrap(query({ handler: () => null }));',
    'export const updateDraft = query(buildConfig());',
  ])('rejects unsupported wrapper shape: %s', (source) => {
    expect(extract(source, [namedImport('convex/server', 'query')])).toBeUndefined();
  });
});
