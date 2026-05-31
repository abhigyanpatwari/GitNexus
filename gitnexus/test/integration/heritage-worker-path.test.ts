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

// Sequential counterpart (no worker pool): the legacy heritage path runs and
// scope-resolution dedups against it. Used to pin worker/sequential parity.
const runSequential = (fixture: string): Promise<PipelineResult> =>
  runPipelineFromRepo(path.join(FIXTURES, fixture), () => {}, {
    skipGraphPhases: true,
    skipWorkers: true,
  });

describe('C# inheritance edges on the worker path (#1951)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runWorker('csharp-proj');
  }, 120_000);

  it('genuinely used the worker pool (guards against silent sequential fallback)', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('emits class-extends-class EXTENDS: User → BaseEntity (class-owned, via scope-resolution)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['User → BaseEntity']);
    // The edge must originate from scope-resolution (the worker-safe channel),
    // and be owned by the Class node — not a method/constructor.
    expect(extends_[0]?.sourceLabel).toBe('Class');
    expect(extends_[0]?.rel.reason).toBe('scope-resolution: inherits');
  });

  it('emits class-implements-interface IMPLEMENTS: User → IRepository (class-owned, via scope-resolution)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['User → IRepository']);
    expect(implements_[0]?.sourceLabel).toBe('Class');
    expect(implements_[0]?.rel.reason).toBe('scope-resolution: inherits');
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

describe('C# primary-constructor + qualified-generic base on the worker path (#1951 regression)', () => {
  // A C# 12 primary constructor is synthesized into the class scope, so the
  // shared `resolveCallerGraphId` would degrade the inheritance edge source to
  // the constructor (breaking MRO). The edge must stay owned by the Class.
  // Also covers fully-qualified generic base-name normalization (App.Repo<int>).
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runWorker('csharp-primary-ctor-heritage');
  }, 120_000);

  it('genuinely used the worker pool', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('emits EXTENDS owned by the Class, not the primary constructor', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    // User(int id) : BaseEntity  and  Service : App.Repo<int>
    expect(edgeSet(extends_)).toEqual(['Service → Repo', 'User → BaseEntity']);
    // The regression: every inheritance edge source is the Class node. Before
    // the fix, User's source degraded to Constructor:User.
    expect(extends_.every((e) => e.sourceLabel === 'Class')).toBe(true);
  });

  it('emits IMPLEMENTS owned by the Class for a primary-constructor class', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['User → IFoo']);
    expect(implements_.every((e) => e.sourceLabel === 'Class')).toBe(true);
  });
});

describe('Worker/sequential inheritance-edge parity (#1951)', () => {
  // The dedup-key change (type-prefixed, graph-seeded) must keep the worker
  // path (scope-resolution emits) and the sequential path (legacy heritage
  // emits, scope-resolution dedups) producing the SAME single edges — no
  // double-emission, no dropped IMPLEMENTS.
  let worker: PipelineResult;
  let sequential: PipelineResult;
  beforeAll(async () => {
    worker = await runWorker('csharp-proj');
    sequential = await runSequential('csharp-proj');
  }, 120_000);

  it('worker mode used the pool; sequential did not', () => {
    expect(worker.usedWorkerPool).toBe(true);
    expect(sequential.usedWorkerPool).toBe(false);
  });

  it('produces identical EXTENDS and IMPLEMENTS edge sets in both modes', () => {
    expect(edgeSet(getRelationships(worker, 'EXTENDS'))).toEqual(
      edgeSet(getRelationships(sequential, 'EXTENDS')),
    );
    expect(edgeSet(getRelationships(worker, 'IMPLEMENTS'))).toEqual(
      edgeSet(getRelationships(sequential, 'IMPLEMENTS')),
    );
  });

  it('emits exactly one EXTENDS and one IMPLEMENTS in each mode (no double-emission)', () => {
    expect(getRelationships(worker, 'EXTENDS').length).toBe(1);
    expect(getRelationships(worker, 'IMPLEMENTS').length).toBe(1);
    expect(getRelationships(sequential, 'EXTENDS').length).toBe(1);
    expect(getRelationships(sequential, 'IMPLEMENTS').length).toBe(1);
  });
});
