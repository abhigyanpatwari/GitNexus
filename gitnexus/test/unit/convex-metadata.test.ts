import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { ParsedImport } from 'gitnexus-shared';
import { extractConvexEndpointProperties } from '../../src/core/ingestion/languages/typescript/convex-endpoint-metadata.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

const parser = new Parser();
parser.setLanguage(TypeScript.typescript as Parameters<Parser['setLanguage']>[0]);

function nodeOfType(source: string, type: string): SyntaxNode {
  const root = parser.parse(source).rootNode as unknown as SyntaxNode;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  throw new Error(`fixture has no ${type}`);
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

function extract(
  source: string,
  imports: readonly ParsedImport[],
  isExported = true,
  nodeLabel = 'Const',
  definitionType = 'export_statement',
) {
  return extractConvexEndpointProperties({
    nodeLabel,
    nodeName: 'updateDraft',
    definitionNode: nodeOfType(source, definitionType),
    parsedImports: imports,
    isExported,
    filePath: 'src/convex.ts',
  });
}

describe('Convex endpoint metadata extraction', () => {
  it('canonicalizes a generic convex/server factory across line-comment trivia', () => {
    expect(
      extract(
        `export const updateDraft = // legal trivia\n mutation({ handler: async () => null });`,
        [namedImport('convex/server', 'mutationGeneric', 'mutation')],
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

  it('accepts generated-server package paths and httpAction', () => {
    expect(
      extract(`export const updateDraft = route(async () => null);`, [
        namedImport('convex/_generated/server', 'httpAction', 'route'),
      ]),
    ).toEqual({ convexEndpointFactory: 'httpAction' });
  });

  it.each(['arrow_function', 'function_expression'])('stamps a bare %s handler capture', (type) => {
    const expression =
      type === 'arrow_function' ? 'async () => null' : 'async function () { return null; }';
    expect(
      extract(
        `export const updateDraft = query(${expression});`,
        [namedImport('./_generated/server', 'query')],
        true,
        'Function',
        'export_statement',
      ),
    ).toEqual({ convexEndpointFactory: 'query' });
  });

  it.each([
    ['unrelated import', [namedImport('./database', 'query')], true],
    ['non-generic convex/server API', [namedImport('convex/server', 'query')], true],
    ['unexported declaration', [namedImport('./_generated/server', 'query')], false],
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
    expect(extract(source, [namedImport('./_generated/server', 'query')])).toBeUndefined();
  });

  it('does not search into a nested same-name declarator', () => {
    expect(
      extract(
        `export function updateDraft() {
          const updateDraft = query({ handler: () => null });
          return updateDraft;
        }`,
        [namedImport('./_generated/server', 'query')],
        true,
        'Function',
        'function_declaration',
      ),
    ).toBeUndefined();
  });
});
