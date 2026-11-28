/**
 * Mixed TypeScript ↔ JavaScript imports must emit IMPORTS + CALLS (#4252).
 *
 * Same-language JS → JS already worked; the gap was each language pass only
 * seeing its own file bucket, so sibling-language relative imports never
 * resolved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('TypeScript ↔ JavaScript cross-language imports (#4252)', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-js-cross-lang-'));
    writeFixtureRepo(repoDir, {
      'jslib/a.js': `
export function fromJs() { return 1; }
export const jsUtils = { fromJs };
`,
      'tslib/b.ts': `
export function fromTs() { return 2; }
`,
      'app/t.ts': `
import { fromJs } from '../jslib/a';
export function tDirect() { return fromJs(); }
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
export function tAgg() { return jsUtils.fromJs(); }
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('emits IMPORTS + CALLS for TypeScript → JavaScript', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(
      imports.find(
        (e) => e.sourceFilePath === 'app/t.ts' && e.targetFilePath === 'jslib/a.js',
      ),
    ).toBeDefined();

    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'tDirect' && c.target === 'fromJs')).toBeDefined();
  });

  it('emits IMPORTS + CALLS for JavaScript → TypeScript', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(
      imports.find(
        (e) => e.sourceFilePath === 'app/j.js' && e.targetFilePath === 'tslib/b.ts',
      ),
    ).toBeDefined();

    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'jDirect' && c.target === 'fromTs')).toBeDefined();
  });

  it('keeps same-language JavaScript → JavaScript working', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(
      imports.find(
        (e) => e.sourceFilePath === 'app/jj.js' && e.targetFilePath === 'jslib/a.js',
      ),
    ).toBeDefined();

    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'jjDirect' && c.target === 'fromJs')).toBeDefined();
  });

  it('emits IMPORTS + CALLS for aggregated-object access across the boundary', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(
      imports.find(
        (e) => e.sourceFilePath === 'app/tagg.ts' && e.targetFilePath === 'jslib/a.js',
      ),
    ).toBeDefined();

    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'tAgg' && c.target === 'fromJs')).toBeDefined();
  });
});
