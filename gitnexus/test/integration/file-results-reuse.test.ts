import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { emptyParseCache, loadParseCache, saveParseCache } from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';
import * as fileResultCodec from '../../src/storage/file-result-codec.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const worker = pathToFileURL(path.resolve('dist/core/ingestion/workers/parse-worker.js'));
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
const rows = (run: Awaited<ReturnType<typeof runPipelineFromRepo>>) =>
  [...run.graph.nodes]
    .map((node) => 'N ' + JSON.stringify(canonical(node)))
    .concat([...run.graph.relationships].map((edge) => 'R ' + JSON.stringify(canonical(edge))))
    .sort();
async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-reuse-'));
  roots.push(root);
  const repo = path.join(root, 'repo'),
    live = path.join(root, 'live');
  await fs.mkdir(repo);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), content);
  }
  let sequence = 0;
  return {
    repo,
    live,
    run: async (cacheKind: 'cold' | 'reuse' | 'none', pdg = false, repack = false) => {
      const stage = path.join(root, `stage-${sequence++}`);
      const cache =
        cacheKind === 'none'
          ? undefined
          : cacheKind === 'cold'
            ? emptyParseCache(TEST_PARSE_IDENTITY, { storagePath: live, writeStoragePath: stage })
            : await loadParseCache(live, TEST_PARSE_IDENTITY, stage);
      const progress: number[] = [];
      const run = await runPipelineFromRepo(
        repo,
        (p) => {
          if (p.phase === 'parsing' && p.percent >= 20 && p.percent <= 70) progress.push(p.percent);
        },
        {
          parseWorkerUrl: worker,
          workerPoolSize: 2,
          parseCache: cache,
          parsedFileStorePath: stage,
          pdg,
          ...(repack ? { chunkByteBudget: 1 } : {}),
        },
      );
      if (cache) {
        const keys = await saveParseCache(live, cache);
        if (!('fileResults' in cache))
          await mergeStagedDurableParsedFileStore(
            live,
            stage,
            TEST_PARSE_IDENTITY.base,
            new Set(keys),
          );
      }
      await fs.rm(stage, { recursive: true, force: true });
      return { ...run, progress };
    },
  };
}
describe('per-file parse-result reuse', () => {
  it('preserves fresh facts and cache hits when optional string interning fails', async () => {
    const f = await fixture({
      'a.ts': 'export function value() { return 1; }',
      'b.ts': "import { value } from './a'; export function run() { return value(); }",
    });
    const control = await f.run('none');
    const decode = fileResultCodec.decodeFileResultSection;
    const spy = vi
      .spyOn(fileResultCodec, 'decodeFileResultSection')
      .mockImplementation((...args) =>
        args[3] === 'facts' && args[4] ? undefined : decode(...args),
      );
    try {
      const cold = await f.run('cold');
      expect(cold.reparsedFileCount).toBe(2);
      expect(rows(cold)).toEqual(rows(control));
      const warm = await f.run('reuse');
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(2);
      expect(warm.usedWorkerPool).toBe(false);
      expect(rows(warm)).toEqual(rows(control));
    } finally {
      spy.mockRestore();
    }
  }, 120000);
  it('keeps zero-output files correct when they require another worker dispatch', async () => {
    const f = await fixture({
      'normal.ts': 'export function normal() { return 1; }',
      'template.vue': '<template><div>Hello</div></template>',
    });
    const cold = await f.run('cold');
    const warm = await f.run('reuse');
    expect(rows(warm)).toEqual(rows(cold));
    expect(warm.reparsedFileCount).toBe(1);
    expect(warm.parseCacheHitFileCount).toBe(1);
    expect(warm.usedWorkerPool).toBe(true);
  }, 120000);
  it.skipIf(process.platform === 'win32')(
    'keeps CR/LF filenames usable through the real worker raw fallback',
    async () => {
      const f = await fixture({
        'normal.ts': 'export function normal() { return 1; }',
        'we\nird.ts': 'export function newline() { return 2; }',
        'we\rird.ts': 'export function carriageReturn() { return 3; }',
      });
      const control = await f.run('none');
      const cold = await f.run('cold');
      expect(rows(cold)).toEqual(rows(control));
      const warm = await f.run('reuse');
      expect(rows(warm)).toEqual(rows(control));
      expect(warm.reparsedFileCount).toBe(2);
      expect(warm.parseCacheHitFileCount).toBe(1);
    },
    120000,
  );
  it('reparses only the edited file in a shared chunk, across additions, renames and packing changes', async () => {
    const names = ['file0.ts', 'file13.ts', 'file35.ts', 'file135.ts'];
    const f = await fixture(
      Object.fromEntries(
        names.map((name, i) => [name, `export function value${i}() { return ${i}; }`]),
      ),
    );
    const cold = await f.run('cold');
    expect(cold.reparsedFileCount).toBe(4);
    const warm = await f.run('reuse');
    expect(warm.reparsedFileCount).toBe(0);
    expect(warm.usedWorkerPool).toBe(false);
    expect(rows(warm)).toEqual(rows(cold));
    await fs.appendFile(
      path.join(f.repo, names[0]),
      '\nexport function newlyAdded() { return value0(); }',
    );
    const edit = await f.run('reuse');
    expect(edit.reparsedFileCount).toBe(1);
    expect(edit.parseCacheHitFileCount).toBe(3);
    expect([...edit.graph.nodes].some((node) => node.properties.name === 'newlyAdded')).toBe(true);
    expect(rows(edit)).toEqual(rows(await f.run('none')));
    await fs.writeFile(path.join(f.repo, 'added.ts'), 'export const added = 1;');
    expect((await f.run('reuse')).reparsedFileCount).toBe(1);
    await fs.rm(path.join(f.repo, 'added.ts'));
    expect((await f.run('reuse')).reparsedFileCount).toBe(0);
    await fs.rename(path.join(f.repo, names[1]), path.join(f.repo, 'renamed.ts'));
    const renamed = await f.run('reuse');
    expect(renamed.reparsedFileCount).toBe(1);
    const repacked = await f.run('reuse', false, true);
    expect(repacked.reparsedFileCount).toBe(0);
    expect(repacked.usedWorkerPool).toBe(false);
    expect(rows(repacked)).toEqual(rows(renamed));
  }, 120000);
  it.each([false, true])(
    'preserves every graph row on cold, warm and mixed polyglot runs with PDG=%s',
    async (pdg) => {
      const f = await fixture({
        'a.ts': 'export class Base { value() { return 1; } }',
        'b.ts':
          "import { Base } from './a'; export class Child extends Base { run() { return this.value(); } }",
        'view.tsx': 'export function View() { return <div>Hello</div>; }',
        'empty.ts': '',
        'service.py': 'def value():\n    return 1\n',
        'api.py':
          'from fastapi import APIRouter\nfrom service import value\nrouter = APIRouter()\n@router.get("/items")\ndef items():\n    return value()\n',
        'Main.java': 'class Main { int run() { return new Base().value(); } }',
        'Base.java': 'class Base { int value() { return 1; } }',
        'main.go': 'package main\nfunc run() int { return value() }\n',
        'value.go': 'package main\nfunc value() int { return 1 }\n',
      });
      const full = await f.run('none', pdg);
      expect(rows(await f.run('cold', pdg))).toEqual(rows(full));
      const warm = await f.run('reuse', pdg);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.usedWorkerPool).toBe(false);
      expect(rows(warm)).toEqual(rows(full));
      await fs.writeFile(
        path.join(f.repo, 'a.ts'),
        'export class Base { renamed() { return 2; } }',
      );
      await fs.writeFile(path.join(f.repo, 'service.py'), 'def replacement():\n    return 2\n');
      const mixed = await f.run('reuse', pdg);
      expect(mixed.reparsedFileCount).toBe(2);
      expect(mixed.parseCacheHitFileCount).toBe(8);
      expect(rows(mixed)).toEqual(rows(await f.run('none', pdg)));
      expect(rows(mixed)).not.toEqual(rows(full));
      expect(mixed.progress).toEqual([...mixed.progress].sort((a, b) => a - b));
    },
    120000,
  );
  it.each(['facts', 'scopes'])(
    'reparses only a file whose %s section is corrupt',
    async (section) => {
      const f = await fixture({ 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' });
      const cold = await f.run('cold');
      const directory = path.join(f.live, 'parse-cache', 'files');
      const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'));
      const ref = index.records.find((r: { path: string }) => r.path === 'a.ts');
      const pack = path.join(directory, ref.pack),
        bytes = await fs.readFile(pack);
      bytes[ref.offset + (section === 'scopes' ? ref.factsLength : 0) + 8] ^= 255;
      await fs.writeFile(pack, bytes);
      const repaired = await f.run('reuse');
      expect(repaired.reparsedFileCount).toBe(1);
      expect(repaired.parseCacheHitFileCount).toBe(1);
      expect(rows(repaired)).toEqual(rows(cold));
      expect((await f.run('reuse')).reparsedFileCount).toBe(0);
    },
    120000,
  );
});
