import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function createGoRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-multi-name-worker-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/multi\n\ngo 1.22\n');
  fs.writeFileSync(
    path.join(dir, 'main.go'),
    [
      'package main',
      '',
      'const X, Y int = 1, 2',
      'var a, b string',
      '',
      'var (',
      '  c, d bool',
      ')',
      '',
      'type Point struct { Px, py int }',
      '',
      'func main() {}',
      '',
    ].join('\n'),
  );
  return dir;
}

async function runMode(mode: 'worker' | 'sequential'): Promise<PipelineResult> {
  return runPipelineFromRepo(createGoRepo(), () => {}, {
    skipGraphPhases: true,
    workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    ...(mode === 'worker' ? { workerPoolSize: 2 } : { skipWorkers: true }),
  });
}

function collectMetadata(result: PipelineResult): Map<string, Record<string, unknown>> {
  const metadata = new Map<string, Record<string, unknown>>();
  result.graph.forEachNode((node) => {
    if (node.label === 'Const' || node.label === 'Variable' || node.label === 'Property') {
      metadata.set(`${node.label}:${node.properties.name}`, node.properties);
    }
  });
  return metadata;
}

describe('Go multi-name declaration metadata in worker parsing', () => {
  it('emits every const and var name with metadata on the worker path', async () => {
    const worker = await runMode('worker');
    const sequential = await runMode('sequential');

    expect(worker.usedWorkerPool).toBe(true);
    expect(sequential.usedWorkerPool).toBe(false);

    const workerMetadata = collectMetadata(worker);
    const sequentialMetadata = collectMetadata(sequential);

    expect([...workerMetadata.keys()].sort()).toEqual([...sequentialMetadata.keys()].sort());
    expect(workerMetadata.get('Const:X')).toMatchObject({
      declaredType: 'int',
      isConst: true,
      isMutable: false,
      scope: 'module',
    });
    expect(workerMetadata.get('Const:Y')).toMatchObject({
      declaredType: 'int',
      isConst: true,
      isMutable: false,
      scope: 'module',
    });
    expect(workerMetadata.get('Variable:a')).toMatchObject({
      declaredType: 'string',
      isMutable: true,
      scope: 'module',
    });
    expect(workerMetadata.get('Variable:b')).toMatchObject({
      declaredType: 'string',
      isMutable: true,
      scope: 'module',
    });
    expect(workerMetadata.get('Variable:c')).toMatchObject({
      declaredType: 'bool',
      isMutable: true,
      scope: 'module',
    });
    expect(workerMetadata.get('Variable:d')).toMatchObject({
      declaredType: 'bool',
      isMutable: true,
      scope: 'module',
    });
    expect(workerMetadata.get('Property:Px')).toMatchObject({ declaredType: 'int' });
    expect(workerMetadata.get('Property:py')).toMatchObject({ declaredType: 'int' });
  });
});
