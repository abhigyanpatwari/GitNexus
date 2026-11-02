import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../../integration/resolvers/helpers.js';

it('distinguishes runtime class extension from type inheritance', () => {
  const captures = emitTsScopeCaptures(
    `
    class Child extends Value implements Shape {}
    interface More extends Shape {}
  `,
    'app.ts',
  ).filter((match) => match['@reference.inherits']);
  expect(
    captures
      .map((match) => [match['@reference.name']?.text, match['@reference.lookup-purpose']?.text])
      .sort(),
  ).toEqual([
    ['Shape', 'type'],
    ['Shape', 'type'],
    ['Value', 'value'],
  ]);
});

describe('TypeScript value and type names', () => {
  let repo: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-type-value-'));
    writeFixtureRepo(repo, {
      'target.ts':
        'export function run() { return 1; }\nexport class Base {}\nexport interface Shape {}',
      'app.ts': `
        import { run, Base, Shape } from './target';
        interface run {}
        export function kept() { return run(); }
        export function erasedAlias() { type run = string; return run(); }
        export class Child extends Base implements Shape {}
        export interface More extends Shape {}
      `,
      'erased.ts': `
        import type { run, Base, Shape } from './target';
        export function forbidden() { return run(); }
        export class Forbidden extends Base {}
        export interface Allowed extends Shape {}
      `,
      'class-scope.ts': `
        import { run } from './target';
        export class Receiver {
          static own() { return 1; }
          run() { return 2; }
          use() { run(); this.run(); Receiver.own(); }
        }
      `,
    });
    result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
  }, 120_000);
  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('preserves imported runtime values beside erased types and blocks type-only runtime use', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'run' && edge.sourceFilePath !== 'class-scope.ts')
        .map(
          (edge) =>
            `${edge.sourceFilePath}:${edge.source} -> ${edge.targetFilePath}:${edge.target}`,
        )
        .sort(),
    ).toEqual(['app.ts:erasedAlias -> target.ts:run', 'app.ts:kept -> target.ts:run']);
  });

  it('keeps imported bare names lexical while preserving explicit this and class self receivers', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.sourceFilePath === 'class-scope.ts' && edge.source === 'use')
        .map((edge) => `${edge.targetLabel}:${edge.targetFilePath}:${edge.target}`)
        .sort(),
    ).toEqual(['Function:target.ts:run', 'Method:class-scope.ts:own', 'Method:class-scope.ts:run']);
  });

  it('retains legitimate heritage without using a type-only import as a runtime base', () => {
    expect(
      getRelationships(result, 'EXTENDS')
        .filter((edge) => edge.target === 'Base')
        .map((edge) => `${edge.source} -> ${edge.targetFilePath}:${edge.target}`)
        .sort(),
    ).toEqual(['Child -> target.ts:Base']);
    expect(
      getRelationships(result, 'IMPLEMENTS')
        .filter((edge) => edge.target === 'Shape')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['Allowed', 'Child', 'More']);
  });
});
