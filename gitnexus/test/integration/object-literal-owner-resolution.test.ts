/**
 * Integration tests for PR #1718 production-readiness review (U4).
 *
 * Proves the bug fix for issue #1358 end-to-end:
 *
 *   export const fooService = { getUser(id: string) { return id; } };
 *   // consumer.ts
 *   import { fooService } from './service';
 *   export function caller(id: string) { return fooService.getUser(id); }
 *
 * After this PR, the full ingestion pipeline must emit:
 *   - `Const:fooService` ── HAS_METHOD ─► `Method:getUser`
 *   - `Function:caller`   ── CALLS      ─► `Method:getUser`
 *
 * The CALLS edge is the canonical proof: `gitnexus_impact` upstream traversal
 * is a graph walk over CALLS, so if the edge exists, impact returns the
 * caller. Asserting the edge directly avoids wiring an entire `withTestLbugDB`
 * fixture for what is effectively a graph-shape assertion.
 *
 * Test set (all through the worker pool — the sole parse path; skipped locally
 * when `dist/parse-worker.js` is missing, with a CI tripwire so CI never skips):
 *   - Test A: pipeline produces both edges with the right `ownerId`
 *   - Test C: local-scoped object literal inside a function emits no false-
 *     positive HAS_METHOD (proves the boundary guard is load-bearing)
 *   - Test D: nested object literal binds neither method to outer (safe
 *     under-approximation proof)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './resolvers/helpers.js';
import { generateId } from '../../src/lib/utils.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';

const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);

// CI tripwire: these suites silently skip when `dist/parse-worker.js` is
// missing. That's fine locally — devs may not have run `npm run build` — but on
// CI a missing dist would leave worker-path ownerId emission unverified. Fail
// hard so a missing dist surfaces as a red build, not a silent skip.
// Locally, run `npm run build` before this suite.
if (!hasDistWorker && process.env.CI) {
  throw new Error(
    'dist/parse-worker.js missing on CI — worker-parity test would silently skip. ' +
      'Ensure the build runs before this suite.',
  );
}

/** Materialise a tiny fixture repo on disk. Returns the absolute repo root. */
function writeFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-objlit-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

const SERVICE_TS = `export const fooService = {
  getUser(id: string) { return id; },
  saveUser(id: string) { return id; },
};
`;

const CONSUMER_TS = `import { fooService } from './service';

export function caller(id: string) {
  return fooService.getUser(id);
}
`;

// ── Test A: worker pipeline ──────────────────────────────────────────────────

describe.skipIf(!hasDistWorker)('object-literal owner resolution — worker pipeline', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/service.ts': SERVICE_TS,
      'src/consumer.ts': CONSUMER_TS,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
    });
  }, 60000);

  afterAll(() => removeFixture(repoRoot));

  it('emits Const:fooService, Method:getUser, Function:caller exactly once', () => {
    expect(getNodesByLabel(result, 'Const').filter((n) => n === 'fooService').length).toBe(1);
    expect(getNodesByLabel(result, 'Method').filter((n) => n === 'getUser').length).toBe(1);
    expect(getNodesByLabel(result, 'Function').filter((n) => n === 'caller').length).toBe(1);
  });

  it('emits exactly the expected HAS_METHOD edges from fooService', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const fromFoo = hasMethod
      .filter((e) => e.source === 'fooService')
      .map((e) => e.target)
      .sort();
    expect(fromFoo).toEqual(['getUser', 'saveUser']);
  });

  it('the fooService Const node uses the expected graph node ID', () => {
    const expectedNodeId = generateId('Const', 'src/service.ts:fooService');
    let fooServiceNode: { id: string; label: string } | undefined;
    result.graph.forEachNode((n) => {
      if (n.label === 'Const' && n.properties.name === 'fooService') {
        fooServiceNode = { id: n.id, label: n.label };
      }
    });
    expect(fooServiceNode).toBeDefined();
    expect(fooServiceNode!.id).toBe(expectedNodeId);
  });

  it('emits a CALLS edge from caller to getUser with the expected target/confidence/reason (issue #1358 fix)', () => {
    const calls = getRelationships(result, 'CALLS');
    const callerToGetUser = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetId: e.rel.targetId,
        confidence: e.rel.confidence,
        reason: e.rel.reason,
      }));

    // The Method node id encodes arity disambiguation (#1 = one-arity overload).
    // Pin the canonical id so a regression that targets a phantom node fails.
    const expectedTargetId = generateId('Method', 'src/service.ts:fooService.getUser#1');
    expect(callerToGetUser).toEqual([
      {
        targetId: expectedTargetId,
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ]);
  });
});

// (Former Test B — worker-vs-sequential parity — removed: the sequential parser
// was deleted, so there is no second mode to diff. Test A above already proves
// the worker path emits the HAS_METHOD / CALLS edges with the right ownerId.)

// ── Test C: negative — local object literal inside a function body ──────────

describe.skipIf(!hasDistWorker)(
  'object-literal owner resolution — negative (local literal)',
  () => {
    let repoRoot: string;
    let result: PipelineResult;

    beforeAll(async () => {
      repoRoot = writeFixture({
        'src/p.ts': `export function processAll() {
  const handler = { run(id: string) { return id; } };
  return handler;
}
`,
      });
      result = await runPipelineFromRepo(repoRoot, () => undefined, {
        skipGraphPhases: true,
      });
    }, 60000);

    afterAll(() => removeFixture(repoRoot));

    it('emits no HAS_METHOD edge targeting `run` (no false-positive owner attribution)', () => {
      const hasMethod = getRelationships(result, 'HAS_METHOD');
      const targetingRun = hasMethod.filter((e) => e.target === 'run');
      expect(targetingRun.length).toBe(0);
    });

    it('the run method node carries no ownerId property', () => {
      let runNode: { properties: { name: string; ownerId?: string }; label: string } | undefined;
      result.graph.forEachNode((n) => {
        if (n.label === 'Method' && n.properties.name === 'run') {
          runNode = n as typeof runNode;
        }
      });
      expect(runNode).toBeDefined();
      expect(runNode!.properties.ownerId).toBe(undefined);
    });
  },
);

// ── Test D: negative — nested object literal ─────────────────────────────────

describe.skipIf(!hasDistWorker)(
  'object-literal owner resolution — negative (nested literal)',
  () => {
    let repoRoot: string;
    let result: PipelineResult;

    beforeAll(async () => {
      repoRoot = writeFixture({
        'src/n.ts': `export const s = {
  nested: { method(id: string) { return id; } },
  outer(id: string) { return id; },
};
`,
      });
      result = await runPipelineFromRepo(repoRoot, () => undefined, {
        skipGraphPhases: true,
      });
    }, 60000);

    afterAll(() => removeFixture(repoRoot));

    it('binds the top-level outer method to s but does NOT bind the nested method', () => {
      const hasMethod = getRelationships(result, 'HAS_METHOD');
      const fromS = hasMethod
        .filter((e) => e.source === 's')
        .map((e) => e.target)
        .sort();
      expect(fromS).toEqual(['outer']);
    });
  },
);

// ── #3041: same-named function-valued properties ───────────────────────────

describe.skipIf(!hasDistWorker)(
  'object-literal owner resolution — same-named property callables (#3041)',
  () => {
    let repoRoot: string;
    let result: PipelineResult;

    beforeAll(async () => {
      repoRoot = writeFixture({
        'src/convex.ts': `function query<T>(config: T): T { return config; }
function helperA(ctx: unknown) { return ctx; }
function helperB(ctx: unknown) { return ctx; }
function helperC(ctx: unknown) { return ctx; }

export const first = query({ handler: async (ctx: unknown) => helperA(ctx) }); export const second = query({ handler: async (ctx: unknown) => helperB(ctx) });
export let third = query({ handler: async (ctx: unknown) => helperC(ctx) });
`,
      });
      result = await runPipelineFromRepo(repoRoot, () => undefined, {
        skipGraphPhases: true,
      });
    }, 60000);

    afterAll(() => removeFixture(repoRoot));

    it('creates one owner-qualified handler node per exported const', () => {
      const handlerIds: string[] = [];
      result.graph.forEachNode((node) => {
        if (node.label === 'Function' && node.properties.name === 'handler') {
          handlerIds.push(node.id);
        }
      });

      expect(handlerIds.sort()).toEqual(
        [
          generateId('Function', 'src/convex.ts:first.handler'),
          generateId('Function', 'src/convex.ts:second.handler'),
          generateId('Function', 'src/convex.ts:third.handler'),
        ].sort(),
      );
    });

    it('links each exported const to only its own handler', () => {
      const ownership = getRelationships(result, 'HAS_METHOD')
        .filter((edge) => edge.target === 'handler')
        .map((edge) => `${edge.source}:${edge.rel.targetId}`)
        .sort();

      expect(ownership).toEqual(
        [
          `first:${generateId('Function', 'src/convex.ts:first.handler')}`,
          `second:${generateId('Function', 'src/convex.ts:second.handler')}`,
          `third:${generateId('Function', 'src/convex.ts:third.handler')}`,
        ].sort(),
      );
    });

    it('keeps each handler call on its real owner with no cross-attribution', () => {
      const calls = getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.target === 'helperA' || edge.target === 'helperB' || edge.target === 'helperC',
        )
        .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
        .sort();

      expect(calls).toEqual(
        [
          `${generateId('Function', 'src/convex.ts:first.handler')}->helperA`,
          `${generateId('Function', 'src/convex.ts:second.handler')}->helperB`,
          `${generateId('Function', 'src/convex.ts:third.handler')}->helperC`,
        ].sort(),
      );
    });

    it('keeps owner-qualified handlers reachable from their file definition', () => {
      const defined = getRelationships(result, 'DEFINES')
        .filter((edge) => edge.target === 'handler')
        .map((edge) => edge.rel.targetId)
        .sort();

      expect(defined).toEqual(
        [
          generateId('Function', 'src/convex.ts:first.handler'),
          generateId('Function', 'src/convex.ts:second.handler'),
          generateId('Function', 'src/convex.ts:third.handler'),
        ].sort(),
      );
    });
  },
);

describe.skipIf(!hasDistWorker)('object-literal shorthand method identity (#3041)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/shorthand.ts': `function helperA(value: string) { return value; }
function helperB(value: string) { return value; }
export const alpha = { run(value: string) { return helperA(value); } };
export const beta = { run(value: string) { return helperB(value); } };
`,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
    });
  }, 60_000);

  afterAll(() => removeFixture(repoRoot));

  it('gives sibling shorthand methods distinct owner-qualified identities and calls', () => {
    const nodeIds = new Set<string>();
    result.graph.forEachNode((node) => nodeIds.add(node.id));
    const alphaRun = generateId('Method', 'src/shorthand.ts:alpha.run#1');
    const betaRun = generateId('Method', 'src/shorthand.ts:beta.run#1');
    const calls = getRelationships(result, 'CALLS')
      .filter((edge) => edge.target === 'helperA' || edge.target === 'helperB')
      .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
      .sort();

    expect(nodeIds.has(alphaRun)).toBe(true);
    expect(nodeIds.has(betaRun)).toBe(true);
    expect(calls).toEqual([`${alphaRun}->helperA`, `${betaRun}->helperB`]);
  });

  it('keeps shorthand methods on both File DEFINES and binding HAS_METHOD edges', () => {
    const methodIds = [
      generateId('Method', 'src/shorthand.ts:alpha.run#1'),
      generateId('Method', 'src/shorthand.ts:beta.run#1'),
    ].sort();
    const defined = getRelationships(result, 'DEFINES')
      .filter((edge) => edge.target === 'run')
      .map((edge) => edge.rel.targetId)
      .sort();
    const owned = getRelationships(result, 'HAS_METHOD')
      .filter((edge) => edge.target === 'run')
      .map((edge) => edge.rel.targetId)
      .sort();

    expect(defined).toEqual(methodIds);
    expect(owned).toEqual(methodIds);
  });
});

describe.skipIf(!hasDistWorker)('object-literal dotted property identity (#3041)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/dotted.ts': `function helperC(value: number) { return value; }
function helperD(value: number) { return value; }
export const p = { 'q.r': (value: number) => helperC(value) };
export const z = { r: (value: number) => helperD(value) };
`,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
    });
  }, 60_000);

  afterAll(() => removeFixture(repoRoot));

  it('attributes dotted and plain member calls to their own owner-qualified nodes', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter((edge) => edge.target === 'helperC' || edge.target === 'helperD')
      .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
      .sort();

    expect(calls).toEqual(
      [
        `${generateId('Function', 'src/dotted.ts:p.q.r')}->helperC`,
        `${generateId('Function', 'src/dotted.ts:z.r')}->helperD`,
      ].sort(),
    );
  });
});

describe.skipIf(!hasDistWorker)('object-literal array ownership barrier (#3041)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/array.ts': `function helperA(value: number) { return value; }
function helperB(value: number) { return value; }
export const handlers = [
  { handle: (value: number) => helperA(value) },
  { handle: (value: number) => helperB(value) },
];
`,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
    });
  }, 60_000);

  afterAll(() => removeFixture(repoRoot));

  it('keeps array-contained callables distinct without inventing ownership', () => {
    const falseId = generateId('Function', 'src/array.ts:handlers.handle');
    const bareId = generateId('Function', 'src/array.ts:handle');
    const handlerIds = [
      generateId('Function', 'src/array.ts:handle@3:12'),
      generateId('Function', 'src/array.ts:handle@4:12'),
    ].sort();
    const nodeIds = new Set<string>();
    result.graph.forEachNode((node) => nodeIds.add(node.id));
    const calls = getRelationships(result, 'CALLS')
      .filter((edge) => edge.target === 'helperA' || edge.target === 'helperB')
      .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
      .sort();
    const falseOwnership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.source === 'handlers' && edge.target === 'handle',
    );

    expect(nodeIds.has(falseId)).toBe(false);
    expect(nodeIds.has(bareId)).toBe(false);
    expect(handlerIds.every((id) => nodeIds.has(id))).toBe(true);
    expect(calls).toEqual([`${handlerIds[0]}->helperA`, `${handlerIds[1]}->helperB`].sort());
    expect(falseOwnership).toEqual([]);
  });
});

describe.skipIf(!hasDistWorker)('nested array object Method identity (#3041)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/nested-array.ts': `function helperA(value: number) { return value; }
function helperB(value: number) { return value; }
export const registry = {
  groups: [[
    { handle(value: number) { return helperA(value); } },
    { handle(value: number) { return helperB(value); } },
  ]],
};
`,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
    });
  }, 60_000);

  afterAll(() => removeFixture(repoRoot));

  it('position-qualifies shorthand methods through nested arrays and objects', () => {
    const expectedIds = [
      generateId('Method', 'src/nested-array.ts:handle@4:6#1'),
      generateId('Method', 'src/nested-array.ts:handle@5:6#1'),
    ].sort();
    const nodeIds = new Set<string>();
    result.graph.forEachNode((node) => nodeIds.add(node.id));
    const calls = getRelationships(result, 'CALLS')
      .filter((edge) => edge.target === 'helperA' || edge.target === 'helperB')
      .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
      .sort();
    const ownership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.target === 'handle',
    );

    expect(expectedIds.every((id) => nodeIds.has(id))).toBe(true);
    expect(calls).toEqual([`${expectedIds[0]}->helperA`, `${expectedIds[1]}->helperB`].sort());
    expect(ownership).toEqual([]);
  });
});

describe.skipIf(!hasDistWorker)('object-literal callable durable cache (#3041)', () => {
  it('replays owner-qualified handler identities and calls without workers', async () => {
    const repoRoot = writeFixture({
      'src/convex.ts': `function query<T>(config: T): T { return config; }
function helperA(ctx: unknown) { return ctx; }
function helperB(ctx: unknown) { return ctx; }
export const first = query({ handler: (ctx: unknown) => helperA(ctx) });
export const second = query({ handler: (ctx: unknown) => helperB(ctx) });
`,
    });
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-objlit-cache-'));
    try {
      const coldCache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(repoRoot, () => undefined, {
        skipGraphPhases: true,
        parseCache: coldCache,
        workerPoolSize: 1,
      });
      pruneCache(coldCache, coldCache.usedKeys);
      const savedKeys = await saveParseCache(storage, coldCache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warmCache = await loadParseCache(storage);
      const warm = await runPipelineFromRepo(repoRoot, () => undefined, {
        skipGraphPhases: true,
        parseCache: warmCache ?? undefined,
        workerPoolSize: 1,
      });

      const project = (pipeline: PipelineResult) =>
        getRelationships(pipeline, 'CALLS')
          .filter((edge) => edge.target === 'helperA' || edge.target === 'helperB')
          .map((edge) => `${edge.rel.sourceId}->${edge.target}`)
          .sort();
      expect(warm.usedWorkerPool).toBe(false);
      expect(project(warm)).toEqual(project(cold));
      expect(project(warm)).toEqual(
        [
          `${generateId('Function', 'src/convex.ts:first.handler')}->helperA`,
          `${generateId('Function', 'src/convex.ts:second.handler')}->helperB`,
        ].sort(),
      );
    } finally {
      removeFixture(repoRoot);
      fs.rmSync(storage, { recursive: true, force: true });
    }
  }, 120_000);
});
