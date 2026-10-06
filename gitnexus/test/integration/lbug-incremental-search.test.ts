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

describe('native incremental search (#3421, #3423)', () => {
  for (const scenario of ['context', 'property'] as const) {
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
        if (scenario === 'context') {
          for (const lookup of ['primary-key', 'uid', 'name']) {
            expect(check(`${stage}:${lookup}`)?.ids).toEqual([
              'Function:src/owner2.ts:unchangedSwiftTarget64',
            ]);
          }
        } else {
          expect(check(`${stage}:catalog`)?.indexes).toBe(1);
          expect(check(`${stage}:fts-query`)?.ids).toEqual([
            'Property:src/owner2.swift:property64',
          ]);
          for (const column of ['name', 'content', 'description']) {
            expect(check(`${stage}:lower-${column}`)?.rows).toBe(8192);
          }
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
