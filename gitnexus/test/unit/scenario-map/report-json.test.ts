/** Full-suite reports exceed V8's string limit; each record must survive streamed I/O. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareWithBaseline } from '../../../tools/scenario-map/report/baseline.js';
import { readReportFields, writeReportJson } from '../../../tools/scenario-map/report/json.js';
import { buildReport } from '../../../tools/scenario-map/report/report.js';
import { reportInput } from './report-fixtures.js';

const directories: string[] = [];
function output(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scenario-report-json-'));
  directories.push(directory);
  return path.join(directory, 'report.json');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('report JSON', () => {
  it('preserves every field and record without serializing a whole collection', async () => {
    const report = buildReport(reportInput());
    const pair = report.fingerprint.pairs[0];
    report.fingerprint.pairs = Array.from({ length: 100 }, (_, i) => ({
      ...pair,
      a: `test-${i}`,
      details: ['escaped \"quote\", \\slash, \nnewline and unicode 🧪'],
    }));
    report.fingerprint.kept = report.fingerprint.pairs.map((entry) => ({
      ...entry,
      keep: [{ test: entry.a, reason: 'intentional control' }],
    }));
    report.fingerprint.pairs[0].details = Array(1_000).fill('nested record detail');
    const file = output();
    const stringify = JSON.stringify;
    // Model the V8 cap at a small scale, including a collection nested inside one record.
    const limit = 16_384;
    expect(stringify(report.fingerprint.pairs).length).toBeGreaterThan(limit);
    expect(stringify(report.fingerprint.kept).length).toBeGreaterThan(limit);
    expect(stringify(report.fingerprint.pairs[0]).length).toBeGreaterThan(limit);
    const capped = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const text = stringify(value, replacer, space);
      if (text !== undefined && text.length > limit) throw new RangeError('Invalid string length');
      return text;
    });
    await writeReportJson(file, report);
    capped.mockRestore();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(report);
    expect(readdirSync(path.dirname(file))).toEqual(['report.json']);
  });

  it('leaves the prior report intact and removes the temporary file on serialization failure', async () => {
    const report = buildReport(reportInput());
    const file = output();
    writeFileSync(file, '{"previous":true}');
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('cannot serialize');
    });
    await expect(writeReportJson(file, report)).rejects.toThrow('cannot serialize');
    expect(readFileSync(file, 'utf8')).toBe('{"previous":true}');
    expect(readdirSync(path.dirname(file))).toEqual(['report.json']);
  });

  it('propagates filesystem errors', async () => {
    const file = output();
    await expect(writeReportJson(path.dirname(file), buildReport(reportInput()))).rejects.toThrow();
    expect(readdirSync(path.dirname(file))).toEqual([]);
  });

  it.each(['streamed', 'legacy'] as const)(
    'reads a %s baseline without retaining findings',
    async (format) => {
      const report = buildReport(reportInput());
      const file = output();
      if (format === 'streamed') await writeReportJson(file, report);
      else writeFileSync(file, JSON.stringify(report, null, 2));
      const baseline = await readReportFields(file, ['schemaVersion', 'run', 'continuity']);
      expect(baseline).toEqual({
        schemaVersion: report.schemaVersion,
        run: report.run,
        continuity: report.continuity,
      });
      expect(compareWithBaseline(report.continuity, baseline)).toEqual(
        compareWithBaseline(report.continuity, report),
      );
      expect(await readReportFields(file, ['run', 'completeness'])).toEqual({
        run: report.run,
        completeness: report.completeness,
      });
    },
  );

  it('preserves UTF-8 and escapes across input chunks while skipping large unselected fields', async () => {
    const file = output();
    const run = { id: '🧪\n"\\é'.repeat(30_000) };
    writeFileSync(file, JSON.stringify({ ignored: Array(100).fill(run), run, completeness: null }));
    expect(await readReportFields(file, ['run', 'completeness'])).toEqual({
      run,
      completeness: null,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \n\t'],
    ['truncated selected field', '{"run":{"id":"1"}'],
    ['truncated ignored field', '{"run":{"id":"1"},"ignored":[1,'],
    ['invalid ignored field', '{"run":{"id":"1"},"ignored":!}'],
    ['trailing garbage', '{"run":{"id":"1"}} invalid'],
    ['second document', '{"run":{"id":"1"}} {}'],
  ])('rejects %s instead of trusting metadata parsed before the error', async (_name, source) => {
    const file = output();
    writeFileSync(file, source);
    await expect(readReportFields(file, ['run'])).rejects.toThrow();
  });

  it('propagates a missing file so merge can mark the baseline unreadable', async () => {
    await expect(readReportFields(output(), ['run'])).rejects.toThrow(/ENOENT/);
  });
});
