import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { indexTsCallArguments } from '../../../src/core/ingestion/languages/typescript/call-arguments.js';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

it('indexes shared overload names once while keeping each importer’s local alias', async () => {
  const count = 8;
  const globals = Array.from({ length: count }, (_, i) => `shade${i}`);
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'esnext', moduleDetection: 'legacy' },
    }),
    'globals.ts': globals.map((name) => `function ${name}() {}`).join('\n'),
    'provider.ts': [
      'export function pick(x: string): string;',
      'export function pick(x: number): number;',
      'export function pick(x: string | number) { return x; }',
    ].join('\n'),
  };
  globals.forEach((name, i) => {
    files[`use${i}.ts`] =
      `import { pick as ${name} } from './provider'; export function run${i}() { return ${name}(1); }`;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-overload-index-'));
  try {
    writeFixtureRepo(root, files);
    let tableCount = 0;
    let scans = 0;
    const result = await runPipelineFromRepo(root, () => {}, {
      skipDerivedGraphPhases: true,
      workerPoolSize: 1,
      onScopeResolved({ parsedFiles, indexes }) {
        const tables = new Set(indexes.namespaceFqnBindings.values());
        tableCount = tables.size;
        const iterators = [...tables].map((table) => vi.spyOn(table, Symbol.iterator));
        try {
          indexTsCallArguments(parsedFiles, indexes);
          scans = iterators.reduce((sum, it) => sum + it.mock.calls.length, 0);
        } finally {
          for (const iterator of iterators) iterator.mockRestore();
        }
      },
    });
    expect(tableCount).toBeGreaterThanOrEqual(count);
    expect(scans).toBe(1);
    const callers = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'pick');
    expect(callers.map((edge) => edge.source).sort()).toEqual(globals.map((_, i) => `run${i}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
