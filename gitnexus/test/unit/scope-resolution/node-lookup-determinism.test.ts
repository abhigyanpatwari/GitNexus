import type { NodeLabel } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { mergeChunkResults } from '../../../src/core/ingestion/parsing-processor.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
  simpleKey,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import type { ParseWorkerResult } from '../../../src/core/ingestion/workers/parse-worker.js';

const FILE = 'src/service.ts';

interface Candidate {
  id: string;
  startLine?: number;
}

function buildLookup(candidates: readonly Candidate[]) {
  const graph = createKnowledgeGraph();
  const nodes = candidates.map(
    (candidate) =>
      ({
        id: candidate.id,
        label: 'Method' as NodeLabel,
        properties: {
          name: 'save',
          qualifiedName: 'Service.save',
          filePath: FILE,
          ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
        },
      }) satisfies ParseWorkerResult['nodes'][number],
  );
  const result: ParseWorkerResult = {
    nodes,
    relationships: [],
    symbols: [],
    calls: [],
    assignments: [],
    routes: [],
    fetchCalls: [],
    fetchWrapperDefs: [],
    decoratorRoutes: [],
    routerIncludes: [],
    routerImports: [],
    toolDefs: [],
    ormQueries: [],
    constructorBindings: [],
    fileScopeBindings: [],
    parsedFiles: [],
    skippedLanguages: {},
    fileCount: 1,
  };

  mergeChunkResults(graph, createSemanticModel().symbols, [result]);
  return buildGraphNodeLookup(graph);
}

describe('parse-result graph insertion determinism', () => {
  it('selects the earliest source definition regardless of worker result order', () => {
    const early = { id: `Method:${FILE}:Service.save#1`, startLine: 10 };
    const late = { id: `Method:${FILE}:Service.save#2`, startLine: 20 };

    const lateFirst = buildLookup([late, early]);
    const earlyFirst = buildLookup([early, late]);

    for (const key of [simpleKey(FILE, 'save'), qualifiedKey(FILE, 'Method', 'Service.save')]) {
      expect(lateFirst.get(key)).toBe(early.id);
      expect(earlyFirst.get(key)).toBe(early.id);
    }
  });

  it('uses the stable node id when source positions are identical', () => {
    const first = { id: `Method:${FILE}:Service.save#1`, startLine: 10 };
    const second = { id: `Method:${FILE}:Service.save#2`, startLine: 10 };

    const firstLookup = buildLookup([second, first]);
    const secondLookup = buildLookup([first, second]);

    expect(firstLookup.get(simpleKey(FILE, 'save'))).toBe(first.id);
    expect(secondLookup.get(simpleKey(FILE, 'save'))).toBe(first.id);
  });

  it('uses the stable node id when source positions are unavailable', () => {
    const first = { id: `Method:${FILE}:Service.save#1` };
    const second = { id: `Method:${FILE}:Service.save#2` };

    const lookup = buildLookup([second, first]);

    expect(lookup.get(simpleKey(FILE, 'save'))).toBe(first.id);
  });
});
