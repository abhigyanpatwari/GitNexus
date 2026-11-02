import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const reproducer = fileURLToPath(
  new URL('../../bench/incremental-write-integrity/reproduce-search.cjs', import.meta.url),
);
interface Check {
  name: string;
  ok: boolean;
  error?: string;
  rows?: number;
  wrong?: number;
  missing?: number;
  ids?: string[];
  indexes?: number;
}

const scenarios = ['context', 'property', 'method', 'embedding'] as const;
const lookups = (id: string) =>
  Object.fromEntries(['primary-key', 'uid', 'name'].map((name) => [name, { ids: [id] }]));
// Per-stage expectations for the row retained through every DELETE/write.
const retainedChecks: Record<(typeof scenarios)[number], Record<string, Partial<Check>>> = {
  context: lookups('Function:src/owner2.ts:unchangedSwiftTarget64'),
  method: lookups('Method:checks/test_owner2.py:Checks.test_retained_method_64#0'),
  property: {
    catalog: { indexes: 1 },
    'fts-query': { ids: ['Property:src/owner2.swift:property64'] },
    ...Object.fromEntries(
      ['name', 'content', 'description'].map((column) => [`lower-${column}`, { rows: 8192 }]),
    ),
  },
  // Stale-row DELETE and cached-hash lookups address embeddings by owner node id.
  embedding: { 'node-id': { ids: ['Method:src/main/java/acme/Owner2.java:Owner2.method64#0:0'] } },
};

describe('native incremental search (#3421, #3423, #3564, #3569, #3474)', () => {
  for (const scenario of scenarios) {
    it(`preserves retained ${scenario} strings and search through COPY, checkpoint and reopen`, () => {
      // Own process: isolate native lifetimes and allow old-engine diagnostic runs.
      const result = spawnSync(process.execPath, [reproducer, scenario], {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim()) as { checks: Check[] };
      expect(report.checks.filter((check) => !check.ok)).toEqual([]);
      const check = (name: string) => report.checks.find((entry) => entry.name === name);
      expect(check('after-delete:scan')).toMatchObject({ rows: 8128, wrong: 0, missing: 0 });
      const stages = ['baseline', 'after-copy', 'after-checkpoint', 'reopened'];
      if (scenario === 'property') stages.push('repair');
      for (const stage of stages) {
        expect(check(`${stage}:scan`)).toMatchObject({ rows: 8192, wrong: 0, missing: 0 });
        for (const [name, expected] of Object.entries(retainedChecks[scenario])) {
          expect(check(`${stage}:${name}`), name).toMatchObject(expected);
        }
      }
      if (scenario === 'property') {
        for (const name of ['baseline:build', 'after-copy:build', 'repair:drop', 'repair:build']) {
          expect(check(name)?.ok).toBe(true);
        }
      }
    }, 150_000);
  }
});
