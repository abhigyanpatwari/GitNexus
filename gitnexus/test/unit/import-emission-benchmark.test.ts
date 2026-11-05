import { readFileSync } from 'node:fs';
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
