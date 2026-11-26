import { after, before, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerCases } from '../support/cases.mjs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDir, type TestDBHandle } from '../../../../test/helpers/test-db.js';

import { createTestEnvironment } from '../support/environment.js';
const environment = createTestEnvironment();
const spawnSync = childProcess.spawnSync;
let script = '';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../../../src/core/analyzer-identity.js';

type Request = { absolutePath: string; mode: 'link' | 'readable-file' | 'directory-inventory' };
type Result = {
  type: string;
  state: unknown;
  entriesDigest?: string;
  symlinkTarget?: string;
} | null;

// Exercise the actual subprocess script captured through the public resolver.
// A deterministic clock chooses the I/O route without timing-sensitive tests.
async function runProbe(requests: Request[], slow: boolean, mutateDirectory?: string) {
  const instrumentation = `
    const probeFs = require('node:fs');
    let ticks = 0;
    Object.defineProperty(require('node:perf_hooks').performance, 'now', {
      value: () => ticks++ * ${slow ? 100 : 0},
    });
    const counts = { sync: 0, async: 0 };
    const mutationDirectory = ${JSON.stringify(mutateDirectory ?? null)};
    let mutated = false;
    const afterRead = (file) => {
      if (!mutated && file === mutationDirectory) {
        mutated = true;
        probeFs.writeFileSync(require('node:path').join(file, 'added'), 'changed');
      }
    };
    for (const name of ['lstat', 'stat', 'readlink', 'readdir']) {
      const originalSync = probeFs[name + 'Sync'];
      probeFs[name + 'Sync'] = (...args) => {
        counts.sync++;
        const result = originalSync(...args);
        if (name === 'readdir') afterRead(args[0]);
        return result;
      };
      const originalAsync = probeFs.promises[name];
      probeFs.promises[name] = async (...args) => {
        counts.async++;
        const result = await originalAsync(...args);
        if (name === 'readdir') afterRead(args[0]);
        return result;
      };
    }
    process.on('exit', () => process.stderr.write(JSON.stringify(counts)));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '-e', instrumentation + script],
    {
      input: JSON.stringify(requests),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(child.error).toBeUndefined();
  assert.equal(child.status, 0, child.stderr);
  return {
    results: JSON.parse(child.stdout) as Result[],
    counts: JSON.parse(child.stderr) as { sync: number; async: number },
  };
}

describe('identity guard subprocess I/O', () => {
  let fixture: TestDBHandle;
  let file: string;
  let directory: string;

  before(async () => {
    const intercepted = mock.method(
      childProcess,
      'spawnSync',
      (...args: Parameters<typeof spawnSync>) => {
        const argv = args[1];
        if (Array.isArray(argv) && argv.includes('--input-type=commonjs')) {
          script = argv[argv.indexOf('-e') + 1];
          return { status: 1, stdout: '', stderr: '' };
        }
        return spawnSync(...args);
      },
    );
    syncBuiltinESMExports();
    after(() => {
      intercepted.mock.restore();
      syncBuiltinESMExports();
    });
    fixture = await createTempDir();
    directory = path.join(fixture.dbPath, 'src');
    await mkdir(directory);
    await writeFile(
      path.join(fixture.dbPath, 'package.json'),
      '{"name":"guard-io","version":"1.0.0"}',
    );
    for (let index = 0; index < 140; index++) {
      await writeFile(path.join(directory, `file-${index}.ts`), `export const value = ${index};`);
    }
    file = path.join(directory, 'file-0.ts');
    environment.set('GITNEXUS_ANALYZER_IDENTITY_IN_PROCESS_GUARDS', '0');
    _clearAnalyzerIdentityProcessCacheForTests();
    resolveAnalyzerRunnerIdentity(pathToFileURL(file).href, {
      cacheDirectory: path.join(fixture.dbPath, 'cache'),
    });
    expect(script).not.toBe('');
  });

  after(async () => {
    environment.restore();
    _clearAnalyzerIdentityProcessCacheForTests();
    await fixture?.cleanup();
  });

  it('returns identical ordered snapshots and failures across batch boundaries on both routes', async () => {
    const cases: Request[] = [
      { absolutePath: file, mode: 'link' },
      { absolutePath: directory, mode: 'directory-inventory' },
      { absolutePath: file, mode: 'readable-file' },
      { absolutePath: path.join(fixture.dbPath, 'missing'), mode: 'link' },
      { absolutePath: directory, mode: 'readable-file' },
      { absolutePath: file, mode: 'directory-inventory' },
    ];
    const requests = Array.from({ length: 529 }, (_, index) => cases[index % cases.length]);
    const fast = await runProbe(requests, false);
    const slow = await runProbe(requests, true);
    expect(fast.counts.async).toBe(0);
    expect(fast.counts.sync).toBeGreaterThan(requests.length);
    // A slow first probe exhausts the sample budget; the rest stay concurrent.
    expect(slow.counts.sync).toBe(1);
    expect(slow.counts.async).toBeGreaterThan(512);
    expect(slow.results).toEqual(fast.results);
    expect(fast.results).toHaveLength(requests.length);
    for (let index = 0; index < requests.length; index++) {
      const result = fast.results[index];
      if (index % cases.length >= 3) expect(result).toBeNull();
      else
        expect(result?.type).toBe(
          ['file', 'directory-inventory', 'readable-file'][index % cases.length],
        );
    }
    expect(fast.results[1]?.entriesDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  registerCases(
    it,
    [false, true],
    'rejects an inventory changed during a probe (slow=%s)',
    async (slow) => {
      const changing = path.join(fixture.dbPath, `changing-${slow}`);
      await mkdir(changing);
      const requests: Request[] = Array.from({ length: 529 }, () => ({
        absolutePath: file,
        mode: 'link',
      }));
      // Index 1 is outside the distributed sample, exercising the selected route.
      requests[1] = { absolutePath: changing, mode: 'directory-inventory' };
      const result = await runProbe(requests, slow, changing);
      expect(result.results[1]).toBeNull();
      expect(result.results[0]?.type).toBe('file');
      expect(result.results[528]?.type).toBe('file');
    },
  );

  it(
    'preserves symlink targets and dangling-link failures on both routes',
    { skip: process.platform === 'win32' },
    async () => {
      const link = path.join(fixture.dbPath, 'linked.ts');
      const dangling = path.join(fixture.dbPath, 'dangling.ts');
      await symlink(file, link);
      await symlink(path.join(fixture.dbPath, 'absent.ts'), dangling);
      const cases: Request[] = [
        { absolutePath: link, mode: 'link' },
        { absolutePath: link, mode: 'readable-file' },
        { absolutePath: dangling, mode: 'readable-file' },
      ];
      const requests = Array.from({ length: 140 }, (_, index) => cases[index % cases.length]);
      const fast = await runProbe(requests, false);
      const slow = await runProbe(requests, true);
      expect(slow.results).toEqual(fast.results);
      expect(fast.results[0]?.symlinkTarget).toBe(file);
      expect(fast.results[1]?.state).toMatchObject({ symlinkTarget: file });
      expect(fast.results[2]).toBeNull();
    },
  );
});
