/**
 * C6 — ECMAScript precedence: an explicit named export shadows a star
 * collision. Only star-vs-star is ambiguous; `export { collide } from './a'`
 * next to `export * from './a'; export * from './b'` binds `a`'s `collide`
 * and must NOT be refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('named export shadows a star collision', () => {
  let result: PipelineResult;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-c6-prec-'));
    writeFixtureRepo(dir, {
      'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      'packages/ui/package.json':
        '{ "name": "@x/ui", "version": "1.0.0", "main": "src/index.ts" }\n',
      'packages/ui/src/index.ts': `export { collide } from './a';\nexport * from './a';\nexport * from './b';\n`,
      'packages/ui/src/a.ts': `export function collide() { return 'a'; }\nexport function onlyA() { return 1; }\n`,
      'packages/ui/src/b.ts': `export function collide() { return 'b'; }\nexport function onlyB() { return 2; }\n`,
      'packages/app/package.json':
        '{ "name": "@x/app", "version": "1.0.0", "main": "src/main.ts", "dependencies": { "@x/ui": "1.0.0" } }\n',
      'packages/app/src/main.ts': `import { collide, onlyA, onlyB } from '@x/ui';\nexport function run() { collide(); onlyA(); onlyB(); }\n`,
    });
    result = await runPipelineFromRepo(dir, () => {});
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('binds the named export (a.ts) and does not refuse it', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.sourceFilePath.includes('main.ts') && e.target === 'collide',
    );
    expect(edges.length).toBe(1);
    expect(edges[0]!.targetFilePath).toContain('packages/ui/src/a.ts');
    expect(getResolutionOutcomes(result).filter((o) => o.kind === 'reexport-ambiguous')).toEqual(
      [],
    );
  });
  it('still resolves the non-colliding star names', () => {
    const targets = getRelationships(result, 'CALLS')
      .filter((e) => e.sourceFilePath.includes('main.ts'))
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(['collide', 'onlyA', 'onlyB']);
  });
});
