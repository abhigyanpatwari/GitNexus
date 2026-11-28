/**
 * Integration test: TypeScript <-> JavaScript cross-language imports produce
 * IMPORTS and CALLS edges (#4252).
 *
 * Verifies the full pipeline: the scope-resolution phase partitions files by
 * language, so without the JS-family `collectScopeContextPaths` closure a
 * `.ts` file importing a `.js` module (or vice versa) never resolves — the
 * sibling file is not in the pass's file universe. Mixed TS/JS codebases
 * (`allowJs`, gradual JS -> TS migrations) hit this on every cross-language
 * import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

describe('TypeScript <-> JavaScript cross-language imports', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-js-xlang-'));
    writeFixtureRepo(repoDir, {
      'jslib/a.js': `
export function fromJs() { return 1; }
export const jsUtils = { fromJs };
`,
      'tslib/b.ts': `
export function fromTs(): number { return 2; }
`,
      'app/t.ts': `
import { fromJs } from '../jslib/a';
export function tDirect(): number { return fromJs(); }
`,
      'app/j.js': `
import { fromTs } from '../tslib/b';
export function jDirect() { return fromTs(); }
`,
      'app/jj.js': `
import { fromJs } from '../jslib/a';
export function jjDirect() { return fromJs(); }
`,
      'app/tagg.ts': `
import { jsUtils } from '../jslib/a';
export function tAgg(): number { return jsUtils.fromJs(); }
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('emits CALLS edges across the TS/JS boundary in both directions', () => {
    const calls = getRelationships(result, 'CALLS');
    const has = (source: string, target: string) =>
      calls.some((c) => c.source === source && c.target === target);
    expect(has('tDirect', 'fromJs')).toBe(true);
    expect(has('jDirect', 'fromTs')).toBe(true);
    expect(has('jjDirect', 'fromJs')).toBe(true);
  });

  it('emits CALLS edge for the aggregated-object call across the boundary', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.source === 'tAgg' && c.target === 'fromJs')).toBe(true);
  });

  it('emits IMPORTS edges across the TS/JS boundary in both directions', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const has = (sourceFile: string, targetFile: string) =>
      imports.some((e) => e.sourceFilePath === sourceFile && e.targetFilePath === targetFile);
    expect(has('app/t.ts', 'jslib/a.js')).toBe(true);
    expect(has('app/j.js', 'tslib/b.ts')).toBe(true);
    expect(has('app/jj.js', 'jslib/a.js')).toBe(true);
    expect(has('app/tagg.ts', 'jslib/a.js')).toBe(true);
  });
});
