/**
 * R: `setMethod("show", signature("A"), ...)` and `c("A", "B")` signatures named no owner, so
 * every method of one generic collapsed into a single node. The first class of the signature is
 * the owner, which keeps the ids of methods on different first classes apart.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const FILE = 'R/shapes.R';

describe('R setMethod() with a signature() or c() signature', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-signature-owners'), () => {});
  }, 60000);

  const methodIds = (name: string): string[] => {
    const ids: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Method' && n.properties.name === name) ids.push(n.id);
    });
    return ids.sort();
  };

  it('mints one node per first class of the signature', () => {
    expect(methodIds('show')).toEqual([
      `Method:${FILE}:A.show`,
      `Method:${FILE}:B.show`,
      `Method:${FILE}:P.show`,
    ]);
    expect(methodIds('combine')).toEqual([`Method:${FILE}:A.combine`, `Method:${FILE}:B.combine`]);
  });

  it('attaches each method to its first class', () => {
    const owned = getRelationships(result, 'HAS_METHOD')
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(owned).toEqual(['A->combine', 'A->show', 'B->combine', 'B->show', 'P->show']);
  });
});
