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
import { resolveDefGraphId } from '../../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import type { ParseWorkerResult } from '../../../src/core/ingestion/workers/parse-worker.js';

const FILE = 'src/service.ts';

interface Candidate {
  id: string;
  label?: NodeLabel;
  name?: string;
  qualifiedName?: string;
  startLine?: number;
  startColumn?: number;
}

function buildLookup(candidates: readonly Candidate[]) {
  const graph = createKnowledgeGraph();
  const nodes = candidates.map(
    (candidate) =>
      ({
        id: candidate.id,
        label: candidate.label ?? ('Method' as NodeLabel),
        properties: {
          name: candidate.name ?? 'save',
          qualifiedName: candidate.qualifiedName ?? 'Service.save',
          filePath: FILE,
          ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
          ...(candidate.startColumn !== undefined ? { startColumn: candidate.startColumn } : {}),
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

  it('uses exact columns to distinguish same-line owner-qualified callables', () => {
    const first = {
      id: `Function:${FILE}:first.handler`,
      label: 'Function' as const,
      name: 'handler',
      qualifiedName: 'first.handler',
      startLine: 4,
      startColumn: 24,
    };
    const second = {
      id: `Function:${FILE}:second.handler`,
      label: 'Function' as const,
      name: 'handler',
      qualifiedName: 'second.handler',
      startLine: 4,
      startColumn: 73,
    };
    const lookup = buildLookup([second, first]);

    expect(
      resolveDefGraphId(
        FILE,
        {
          nodeId: `def:${FILE}#5:24:Function:handler`,
          type: 'Function',
          qualifiedName: 'handler',
        },
        lookup,
      ),
    ).toBe(first.id);
    expect(
      resolveDefGraphId(
        FILE,
        {
          nodeId: `def:${FILE}#5:73:Function:handler`,
          type: 'Function',
          qualifiedName: 'handler',
        },
        lookup,
      ),
    ).toBe(second.id);
  });

  it('uses exact position before parsing dotted member names as qualifiers', () => {
    const dotted = {
      id: `Function:${FILE}:service.q.r`,
      label: 'Function' as const,
      name: 'q.r',
      qualifiedName: 'service.q.r',
      startLine: 8,
      startColumn: 31,
    };
    const lookup = buildLookup([dotted]);

    expect(
      resolveDefGraphId(
        FILE,
        {
          nodeId: `def:${FILE}#9:31:Function:q.r`,
          type: 'Function',
          qualifiedName: 'q.r',
        },
        lookup,
      ),
    ).toBe(dotted.id);
  });

  it('resolves a Record definition to its Record node instead of a same-named fallback', () => {
    const record = {
      id: `Record:${FILE}:Person`,
      label: 'Record' as const,
      name: 'Person',
      qualifiedName: 'Person',
      startLine: 10,
    };
    const sameNamedMethod = {
      id: `Method:${FILE}:Factory.Person#0`,
      label: 'Method' as const,
      name: 'Person',
      qualifiedName: 'Factory.Person',
      startLine: 20,
    };

    const lookup = buildLookup([sameNamedMethod, record]);

    expect(lookup.get(qualifiedKey(FILE, 'Record', 'Person'))).toBe(record.id);
    expect(
      resolveDefGraphId(
        FILE,
        {
          type: 'Record',
          qualifiedName: 'Person',
        },
        lookup,
      ),
    ).toBe(record.id);
  });
});

describe('resolveDefGraphId memo', () => {
  it('returns the same id on a repeated lookup and does not leak across rebuilt lookups', () => {
    const method = {
      id: `Method:${FILE}:Service.save#1`,
      label: 'Method' as const,
      name: 'save',
      qualifiedName: 'Service.save',
      startLine: 10,
    };
    const lookupA = buildLookup([method]);
    const lookupB = buildLookup([method]);
    const def = {
      type: 'Method' as const,
      qualifiedName: 'Service.save',
      nodeId: 'def:src/service.ts#11:0:Method:Service.save',
    };
    const first = resolveDefGraphId(FILE, def, lookupA);
    const second = resolveDefGraphId(FILE, def, lookupA);
    const otherLookup = resolveDefGraphId(FILE, def, lookupB);
    expect(first).toBe(method.id);
    expect(second).toBe(first);
    expect(otherLookup).toBe(method.id);
    expect(lookupA).not.toBe(lookupB);
  });
});
