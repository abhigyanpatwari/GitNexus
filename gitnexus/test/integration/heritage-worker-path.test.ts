/**
 * Worker-path inheritance edges for the registry-primary languages (issue #1951).
 *
 * Diagrams showed classes and interfaces with no EXTENDS / IMPLEMENTS edges
 * between them. Root cause: registry-primary languages have their legacy
 * `@heritage.*` edges dropped by the worker pipeline's `shouldAccumulate` gate
 * (parse-impl.ts) — while the scope-resolution path that DOES run in worker
 * mode emitted nothing for them (unlike C++, they synthesized no
 * `@reference.inherits` captures). Small fixtures stayed under the worker
 * threshold and ran sequentially (legacy heritage intact), so the bug hid.
 *
 * The migration routed every language's inheritance through scope-resolution.
 * These tests force the worker pool on small fixtures (production threshold is
 * 15 files / 512 KB) and assert the edges are present. They FAIL before the
 * fix (0 EXTENDS / 0 IMPLEMENTS in worker mode) and pass once each language
 * emits inheritance through scope-resolution. The `usedWorkerPool === true`
 * guard is mandatory: without the compiled worker (built by
 * `pretest:integration`) the pipeline silently falls back to sequential, which
 * would hide the regression.
 *
 * The C#/Java blocks below are the original (#1951) coverage; the
 * table-driven block at the end extends worker-forced coverage to the other
 * migrated languages (go, python, php, rust, kotlin, ruby, typescript,
 * javascript, swift) so a worker-only capture regression in ANY of them fails
 * here rather than slipping every sequential gate.
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
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'lang-resolution');

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

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

// ---------------------------------------------------------------------------
// Worker-forced coverage for the remaining migrated languages (#1951 review).
// Each language's inheritance now flows ONLY through its scope-resolution synth
// in worker mode (legacy heritage gated off). Edge sets are sorted (edgeSet
// sorts), so the expectations below are in sorted order.
// ---------------------------------------------------------------------------

interface WorkerHeritageCase {
  readonly lang: string;
  readonly fixture: string;
  readonly extends: readonly string[];
  readonly implements: readonly string[];
  /** Optional gate for grammars that may not be installed (Swift). */
  readonly available?: boolean;
}

const WORKER_HERITAGE_CASES: readonly WorkerHeritageCase[] = [
  // Go struct embedding → EXTENDS.
  { lang: 'Go', fixture: 'go-child-extends-parent', extends: ['Child → Parent'], implements: [] },
  // Python single inheritance → EXTENDS.
  {
    lang: 'Python',
    fixture: 'python-child-extends-parent',
    extends: ['Child → Parent'],
    implements: [],
  },
  // PHP class extends + trait use → EXTENDS (Base) + IMPLEMENTS (trait Auditable).
  {
    lang: 'PHP',
    fixture: 'php-parent-vs-trait',
    extends: ['Child → Base'],
    implements: ['Child → Auditable'],
  },
  // Rust `impl T for S` → IMPLEMENTS (resolved scope-aware after #1951 review).
  {
    lang: 'Rust',
    fixture: 'rust-traits',
    extends: [],
    implements: ['Button → Clickable', 'Button → Drawable'],
  },
  // Kotlin class + interfaces → EXTENDS (BaseModel) + IMPLEMENTS (2 interfaces).
  {
    lang: 'Kotlin',
    fixture: 'kotlin-heritage',
    extends: ['User → BaseModel'],
    implements: ['User → Serializable', 'User → Validatable'],
  },
  // Ruby `class Child < Parent` → EXTENDS.
  {
    lang: 'Ruby',
    fixture: 'ruby-child-extends-parent',
    extends: ['Child → Parent'],
    implements: [],
  },
  // TypeScript generic base + generic interface → EXTENDS (Box) + IMPLEMENTS (IFoo).
  {
    lang: 'TypeScript',
    fixture: 'typescript-generic-base',
    extends: ['Service → Box'],
    implements: ['Service → IFoo'],
  },
  // JavaScript `class Child extends Parent` → EXTENDS.
  {
    lang: 'JavaScript',
    fixture: 'javascript-child-extends-parent',
    extends: ['Child → Parent'],
    implements: [],
  },
  // Swift class inheritance → EXTENDS (grammar is an optional dependency).
  {
    lang: 'Swift',
    fixture: 'swift-child-extends-parent',
    extends: ['Child → Parent'],
    implements: [],
    available: swiftAvailable,
  },
];

for (const c of WORKER_HERITAGE_CASES) {
  describe.skipIf(c.available === false)(
    `${c.lang} inheritance edges on the worker path (#1951)`,
    () => {
      let result: PipelineResult;
      beforeAll(async () => {
        result = await runWorker(c.fixture);
      }, 120_000);

      it('genuinely used the worker pool (guards against silent sequential fallback)', () => {
        expect(result.usedWorkerPool).toBe(true);
      });

      it('emits the expected EXTENDS / IMPLEMENTS edge set via scope-resolution', () => {
        expect(edgeSet(getRelationships(result, 'EXTENDS'))).toEqual([...c.extends]);
        expect(edgeSet(getRelationships(result, 'IMPLEMENTS'))).toEqual([...c.implements]);
      });
    },
  );
}
