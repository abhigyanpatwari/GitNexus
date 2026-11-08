import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { checkSamples } = await import(
  new URL('../../bench/import-emission/measure.mjs', import.meta.url).href
);
const baseline = JSON.parse(
  readFileSync(new URL('../../bench/import-emission/baseline.json', import.meta.url), 'utf8'),
);
const samples = () =>
  Array.from({ length: baseline.samples }, () => ({
    ...baseline.workload,
    ...baseline.correctness,
    inputHeap: 54_000_000,
    firstEmitHeap: 53_000_000,
    firstEmitHeapDeltaBytes: -1_000_000,
    lastEmitHeap: 271_000_000,
    afterHeap: 271_000_000,
  }));

describe('import-emission benchmark gate', () => {
  it('accepts complete identical output with bounded allocation', () => {
    expect(() => checkSamples(samples(), baseline)).not.toThrow();
  });

  it('rejects the measured global-collector regression even with identical output', () => {
    const rows = samples();
    rows[1].firstEmitHeap = 145_000_000;
    rows[1].firstEmitHeapDeltaBytes = 91_000_000;
    expect(() => checkSamples(rows, baseline)).toThrow('heap growth');
  });

  it.each(['count', 'edgeDigest', 'csvDigest', 'fileCount', 'importsPerFile', 'pathLength'])(
    'rejects changed %s',
    (key) => {
      const rows = samples();
      rows[0][key] = key.endsWith('Digest') ? 'changed' : -1;
      expect(() => checkSamples(rows, baseline)).toThrow();
    },
  );

  it('rejects missing samples and inconsistent heap evidence', () => {
    expect(() => checkSamples(samples().slice(1), baseline)).toThrow('Incomplete');
    const rows = samples();
    rows[0].firstEmitHeapDeltaBytes = 0;
    expect(() => checkSamples(rows, baseline)).toThrow('inconsistent');
  });

  it.each([NaN, Infinity, 0, -1, undefined])('rejects invalid heap readings (%s)', (value) => {
    const rows = samples();
    rows[0].firstEmitHeap = value;
    expect(() => checkSamples(rows, baseline)).toThrow('invalid');
  });
});

describe('import-emission probe cleanup', () => {
  it('removes its temporary directory when sink construction fails', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-probe-cleanup-'));
    try {
      const preload = path.join(tempDir, 'fail-csv-directory.cjs');
      writeFileSync(
        preload,
        `const fs = require('node:fs');
const path = require('node:path');
const mkdirSync = fs.mkdirSync;
fs.mkdirSync = function (dir, ...args) {
  if (path.basename(dir) === 'csv' &&
      path.basename(path.dirname(dir)).startsWith('gitnexus-import-emission-')) {
    throw new Error('injected CSV directory creation failure');
  }
  return mkdirSync.call(this, dir, ...args);
};
require('node:module').syncBuiltinESMExports();
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--require',
          preload,
          '--import',
          'tsx',
          'bench/import-emission/probe.mts',
          '--files',
          '2',
          '--imports',
          '1',
        ],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('injected CSV directory creation failure');
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith('gitnexus-import-emission-')),
      ).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
