/**
 * R: a member names its class by string (`setMethod("area", "Circle", ...)`) or by the
 * call that defines it, and the owner is found through the class registry, which every
 * language shares. A Python `class Circle` must neither hide the R `Circle` (making the
 * name ambiguous) nor adopt an R member when no R class of that name exists.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R owner attachment next to same-named classes of another language', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-mixed-language-owners'), () => {});
  }, 60000);

  const edges = (type: 'HAS_METHOD' | 'HAS_PROPERTY'): string[] =>
    getRelationships(result, type)
      .map((e) => `${e.sourceFilePath}:${e.source}->${e.targetFilePath}:${e.target}`)
      .sort();

  it('indexes both Circle classes (positive control)', () => {
    const circles: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Class' && n.properties.name === 'Circle') {
        circles.push(n.properties.filePath as string);
      }
    });
    expect(circles.sort()).toEqual(['R/shapes.R', 'py/shapes.py']);
  });

  it('attaches the R method and slot to the R Circle despite the Python Circle', () => {
    expect(edges('HAS_METHOD')).toEqual(['R/shapes.R:Circle->R/shapes.R:area']);
    expect(edges('HAS_PROPERTY')).toEqual(['R/shapes.R:Circle->R/shapes.R:radius']);
  });

  it('does not attach an R method to a Python class when no R class has the name', () => {
    expect(edges('HAS_METHOD').filter((e) => e.includes('perimeter'))).toEqual([]);
    const perimeter = result.graph.getNode('Method:R/shapes.R:Square.perimeter');
    expect(perimeter).toBeDefined();
    expect(perimeter?.properties.ownerId).toBeUndefined();
  });
});
