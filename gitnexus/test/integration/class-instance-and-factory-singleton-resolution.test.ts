/**
 * Regression coverage for issue #1358's class-instance and factory-pattern
 * singleton sub-cases. PR #1718 closed the object-literal-shorthand case
 * (`export const fooService = { getUser() {} }`). This file covers the
 * other two singleton shapes:
 *
 *   // Pattern 1 — class-instance singleton
 *   export class FooService { getUser(id) {...} }
 *   export const fooService = new FooService();
 *
 *   // Pattern 2 — factory-pattern singleton
 *   export class FooService { getUser(id) {...} }
 *   export function makeFooService() { return new FooService(); }
 *   export const fooService = makeFooService();
 *
 * Both already resolve end-to-end via scope-resolution's
 * `@type-binding.constructor` capture (TS query) +
 * `propagateImportedReturnTypes` chain-follow (cross-file mirror) +
 * receiver-bound Case 4 (simple typeBinding lookup). This test pins that
 * behavior so a future refactor of any of those three mechanisms cannot
 * silently regress either pattern.
 *
 * Origin: PR #1718 review Finding 4 (NOTED, deferred). T1 pre-plan
 * investigation per docs/plans/2026-05-21-002-feat-pr1718-followups-class-
 * instance-and-label-normalization-plan.md confirmed Outcome A — both
 * patterns already work; this is the regression-net.
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

function writeFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-singleton-'));
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

const CONSUMER_TS = `import { fooService } from './service';

export function caller(id: string) {
  return fooService.getUser(id);
}
`;

// Class methods carry a class-qualified node id (e.g. `FooService.getUser`)
// to distinguish them from same-name methods on other classes. Object-literal
// methods (per PR #1718) use the bare name because they have no class owner.
const EXPECTED_METHOD_NODE_ID = generateId('Method', 'src/service.ts:FooService.getUser#1');

// ── Pattern 1: class-instance singleton ─────────────────────────────────────

describe('class-instance singleton resolution (issue #1358 sub-case 2)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/service.ts': `export class FooService {
  getUser(id: string) {
    return id;
  }
}

export const fooService = new FooService();
`,
      'src/consumer.ts': CONSUMER_TS,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
      skipWorkers: true,
    });
  }, 60000);

  afterAll(() => removeFixture(repoRoot));

  it('emits Class:FooService, Method:getUser, Function:caller, Const:fooService exactly once', () => {
    expect(getNodesByLabel(result, 'Class').filter((n) => n === 'FooService').length).toBe(1);
    expect(getNodesByLabel(result, 'Method').filter((n) => n === 'getUser').length).toBe(1);
    expect(getNodesByLabel(result, 'Function').filter((n) => n === 'caller').length).toBe(1);
    expect(getNodesByLabel(result, 'Const').filter((n) => n === 'fooService').length).toBe(1);
  });

  it('emits HAS_METHOD edge from FooService class to getUser', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const fromClass = hasMethod.filter((e) => e.source === 'FooService').map((e) => e.target);
    expect(fromClass).toEqual(['getUser']);
  });

  it('emits CALLS edge caller → FooService.getUser with confidence 0.85 and reason import-resolved', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetId: e.rel.targetId,
        confidence: e.rel.confidence,
        reason: e.rel.reason,
      }));

    expect(projected).toEqual([
      {
        targetId: EXPECTED_METHOD_NODE_ID,
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ]);
  });
});

// ── Pattern 2: factory-pattern singleton ────────────────────────────────────

describe('factory-pattern singleton resolution (issue #1358 sub-case 3)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = writeFixture({
      'src/service.ts': `export class FooService {
  getUser(id: string) {
    return id;
  }
}

export function makeFooService(): FooService {
  return new FooService();
}

export const fooService = makeFooService();
`,
      'src/consumer.ts': CONSUMER_TS,
    });
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      skipGraphPhases: true,
      skipWorkers: true,
    });
  }, 60000);

  afterAll(() => removeFixture(repoRoot));

  it('emits Function:makeFooService alongside the class and consumer nodes', () => {
    expect(getNodesByLabel(result, 'Function').filter((n) => n === 'makeFooService').length).toBe(
      1,
    );
    expect(getNodesByLabel(result, 'Function').filter((n) => n === 'caller').length).toBe(1);
    expect(getNodesByLabel(result, 'Const').filter((n) => n === 'fooService').length).toBe(1);
  });

  it('resolves caller.fooService.getUser to FooService.getUser via factory chain-follow', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetId: e.rel.targetId,
        confidence: e.rel.confidence,
        reason: e.rel.reason,
      }));

    expect(projected).toEqual([
      {
        targetId: EXPECTED_METHOD_NODE_ID,
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ]);
  });
});
