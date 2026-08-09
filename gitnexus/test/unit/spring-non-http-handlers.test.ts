import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { createSpringNonHttpHandlerMetadataAttacher } from '../../src/core/ingestion/frameworks/spring/non-http-handlers.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';

const FILE_PATH = 'src/Test.kt';
const OWNER_SCOPE_ID = 'scope:test' as ScopeId;
const PARSED_FILE = {
  filePath: FILE_PATH,
  parsedImports: [],
} as unknown as ParsedFile;

function minimalIndexes(): ScopeResolutionIndexes {
  return {
    defs: { byId: new Map() },
    scopeTree: { getScope: () => undefined },
    methodDispatch: { mroFor: () => [] },
  } as unknown as ScopeResolutionIndexes;
}

describe('Spring non-HTTP handler metadata attachment', () => {
  it.each([
    ['no facts', []],
    [
      'only irrelevant annotations',
      [
        {
          ownerScopeId: OWNER_SCOPE_ID,
          ownerFilePath: FILE_PATH,
          ownerRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 24 },
          annotations: [{ name: 'Override' }],
        },
      ],
    ],
  ])('does not scan the graph when a repository has %s', (_case, facts) => {
    const iterNodes = vi.fn(() => {
      throw new Error('iterNodes should remain lazy');
    });
    const iterRelationshipsByType = vi.fn(() => {
      throw new Error('HAS_METHOD should remain lazy');
    });
    const getNode = vi.fn(() => {
      throw new Error('getNode should remain lazy');
    });
    const graph = {
      iterNodes,
      iterRelationshipsByType,
      getNode,
    } as unknown as KnowledgeGraph;
    const attach = createSpringNonHttpHandlerMetadataAttacher({
      getFacts: () => facts,
      isPackageVisibilityIncomplete: () => false,
    });

    expect(() =>
      attach(graph, [PARSED_FILE], {} as GraphNodeLookup, minimalIndexes()),
    ).not.toThrow();
    expect(iterNodes).not.toHaveBeenCalled();
    expect(iterRelationshipsByType).not.toHaveBeenCalled();
    expect(getNode).not.toHaveBeenCalled();
  });
});
