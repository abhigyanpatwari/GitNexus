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
    const expectedTargetId = generateId('Method', 'src/service.ts:getUser#1');
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
