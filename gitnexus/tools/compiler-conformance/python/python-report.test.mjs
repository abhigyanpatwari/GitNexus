import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareReports } from '../compare.mjs';

const pythonReportScript = fileURLToPath(new URL('./python-report.py', import.meta.url));
const pythonBin = process.env.PYTHON_BIN ?? 'python3';

function runReport(dir, entry, names) {
  const stdout = execFileSync(pythonBin, ['-B', pythonReportScript, dir, entry, ...names], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

test('python-report handles stdout prints, decorators, and UTF-16 column offsets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitnexus-py-conformance-'));
  try {
    writeFileSync(
      path.join(dir, 'sample.py'),
      [
        'class Greeter:',
        '    @staticmethod',
        '    def greet(msg):',
        '        print("noisy stdout", msg)',
        '        return msg',
        '',
        '    def entry(self):',
        '        _ = "🚀"; return self.greet("ok")',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = runReport(dir, 'from sample import Greeter; Greeter().entry()', ['greet']);
    assert.equal(report.producer, 'CPython');
    assert.equal(report.edges.length, 1);
    assert.deepEqual(report.edges[0], {
      from: 'sample.py#7:4',
      to: 'sample.py#3:4',
    });
    assert.equal(report.sites.length, 1);
    // "🚀" is 4 UTF-8 bytes but 2 UTF-16 code units, so `self.greet("ok")` starts at col 25.
    assert.deepEqual(report.sites[0], {
      file: 'sample.py',
      start: '8:25',
      end: '8:41',
      status: 'resolved',
      target: 'sample.py#3:4',
    });

    // Negative check: mismatching target must be rejected by compareReports.
    assert.throws(() =>
      compareReports(report, {
        ...report,
        sites: [{ ...report.sites[0], target: 'sample.py#99:0' }],
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
