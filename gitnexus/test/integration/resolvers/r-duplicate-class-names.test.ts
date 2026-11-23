/**
 * R: a class name that is not unique in the repository (the same helper class in `R/` and
 * `tests/`, a class defined twice in one file) used to leave every member of the class without
 * an owner, because the deferred owner attach treated any second registration as ambiguity.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R classes whose name is not unique', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-duplicate-class-names'), () => {});
  }, 60000);

  /** `owner node id -> member node id` for every edge of this type, arity suffix removed, sorted. */
  const owned = (type: 'HAS_METHOD' | 'HAS_PROPERTY'): string[] =>
    getRelationships(result, type)
      .map((e) => `${e.rel.sourceId}->${e.rel.targetId.replace(/#\d+$/, '')}`)
      .sort();

  it('gives each of two same-named classes in different files its own members', () => {
    expect(owned('HAS_METHOD')).toContain('Class:R/stack.R:Stack->Method:R/stack.R:Stack.push');
    expect(owned('HAS_METHOD')).toContain(
      'Class:tests/helper.R:Stack->Method:tests/helper.R:Stack.pop',
    );
    expect(owned('HAS_PROPERTY')).toContain(
      'Class:R/stack.R:Stack->Property:R/stack.R:Stack.items',
    );
    expect(owned('HAS_PROPERTY')).toContain(
      'Class:tests/helper.R:Stack->Property:tests/helper.R:Stack.count',
    );
  });

  it('owns the members of a class defined twice in one file', () => {
    expect(owned('HAS_METHOD')).toContain('Class:R/stack.R:Config->Method:R/stack.R:Config.get');
    expect(owned('HAS_PROPERTY')).toContain(
      'Class:R/stack.R:Config->Property:R/stack.R:Config.verbose',
    );
  });

  it('attaches a setMethod() to the S4 class of its own file', () => {
    expect(owned('HAS_METHOD')).toContain('Class:R/stack.R:Circle->Method:R/stack.R:Circle.area');
    expect(owned('HAS_METHOD')).toContain(
      'Class:tests/helper.R:Circle->Method:tests/helper.R:Circle.perimeter',
    );
    expect(owned('HAS_PROPERTY')).toContain('Class:R/stack.R:Circle->Property:R/stack.R:Circle.r');
    expect(owned('HAS_PROPERTY')).toContain(
      'Class:tests/helper.R:Circle->Property:tests/helper.R:Circle.radius',
    );
  });

  it('leaves a setMethod() unowned when its file defines neither same-named class', () => {
    const scale = [
      ...(function* () {
        for (const n of result.graph.iterNodes()) {
          if (n.label === 'Method' && n.properties.filePath === 'R/orphan.R') yield n;
        }
      })(),
    ];
    expect(scale).toHaveLength(1);
    expect(scale[0].properties.ownerId).toBeUndefined();
    expect(scale[0].properties.ownerNameHint).toBe('Circle');
    expect(owned('HAS_METHOD').filter((e) => e.includes('R/orphan.R'))).toEqual([]);
  });
});
