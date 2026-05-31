/**
 * Worker-path inheritance edges for registry-primary C# and Java (issue #1951).
 *
 * Diagrams showed classes and interfaces with no EXTENDS / IMPLEMENTS edges
 * between them. Root cause: C# and Java are registry-primary, so their legacy
 * `@heritage.*` edges are dropped by the worker pipeline's `shouldAccumulate`
 * gate (parse-impl.ts) — while the scope-resolution path that DOES run in
 * worker mode emitted nothing for them (unlike C++, they synthesized no
 * `@reference.inherits` captures). Small fixtures stayed under the worker
 * threshold and ran sequentially (legacy heritage intact), so the bug hid.
 *
 * These tests force the worker pool on small fixtures (production threshold is
 * 15 files / 512 KB) and assert the edges are present. They FAIL before the
 * fix (0 EXTENDS / 0 IMPLEMENTS in worker mode) and pass once C#/Java emit
 * inheritance through scope-resolution. The `usedWorkerPool === true` guard is
 * mandatory: without the compiled worker (built by `pretest:integration`) the
 * pipeline silently falls back to sequential, which would hide the regression.
 *
 * Run under the default (registry-primary) flags — the bug only exists on the
 * registry-primary path, so we must NOT force REGISTRY_PRIMARY_*=0 here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
  runPipelineFromRepo,
  getRelationships,
  edgeSet,
  type PipelineResult,
} from './resolvers/helpers.js';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'lang-resolution');

const runWorker = (fixture: string): Promise<PipelineResult> =>
  runPipelineFromRepo(path.join(FIXTURES, fixture), () => {}, {
    skipGraphPhases: true,
    // Force the worker-pool gate low so a 4-5 file fixture engages the pool.
    workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    workerPoolSize: 2,
  });

describe('C# inheritance edges on the worker path (#1951)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runWorker('csharp-proj');
  }, 120_000);

  it('genuinely used the worker pool (guards against silent sequential fallback)', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('emits class-extends-class EXTENDS: User → BaseEntity', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['User → BaseEntity']);
  });

  it('emits class-implements-interface IMPLEMENTS: User → IRepository', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['User → IRepository']);
  });
});

describe('C# interface heritage on the worker path (#1951)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runWorker('csharp-interface-heritage');
  }, 120_000);

  it('genuinely used the worker pool', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('models interface-extends-interface and multi-interface heritage as IMPLEMENTS', () => {
    // C# semantics (matching the legacy DAG): conforming to an interface is
    // IMPLEMENTS regardless of whether the child is a class or interface.
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual([
      'IAuditableService → IBarService',
      'IAuditableService → IFooService',
      'IFooService → IBaseInterface',
      'MyService → IAuditableService',
    ]);
  });

  it('emits no EXTENDS edges for pure interface heritage', () => {
    expect(getRelationships(result, 'EXTENDS').length).toBe(0);
  });
});

describe('Java inheritance edges on the worker path (#1951)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runWorker('java-heritage');
  }, 120_000);

  it('genuinely used the worker pool', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('emits class-extends-class EXTENDS: User → BaseModel (and none to interfaces)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['User → BaseModel']);
  });

  it('emits multi-interface IMPLEMENTS: User → Serializable, User → Validatable', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['User → Serializable', 'User → Validatable']);
  });
});
