import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reconcileTestReports } from '../../scripts/test-completeness.js';

const report = (name: string, statuses: string[]) => ({
  success: !statuses.includes('failed'),
  executionErrors: 0,
  executionReason: 'passed',
  testResults: [
    {
      name,
      status: statuses.includes('failed') ? 'failed' : 'passed',
      assertionResults: statuses.map((status, i) => ({
        ancestorTitles: ['contract'],
        title: `case ${i}`,
        fullName: `contract case ${i}`,
        status,
        location: { line: i + 1, column: 1 },
      })),
    },
  ],
});

describe('required test execution across CI jobs', () => {
  it('fails when a collected test never executes, including todo', () => {
    const result = reconcileTestReports([
      report('/home/runner/work/GitNexus/GitNexus/gitnexus/test/unit/a.test.ts', [
        'passed',
        'pending',
        'todo',
      ]),
    ]);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.unverified).toHaveLength(2);
  });

  it('accepts a platform skip only with an actual pass from another job', () => {
    const result = reconcileTestReports([
      report('/home/runner/work/GitNexus/GitNexus/gitnexus/test/unit/a.test.ts', [
        'passed',
        'pending',
      ]),
      report('D:\\a\\GitNexus\\GitNexus\\gitnexus\\test\\unit\\a.test.ts', ['pending', 'passed']),
    ]);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.unverified).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('never lets a passing job erase a failure on another platform', () => {
    const result = reconcileTestReports([
      report('/repo/gitnexus/test/unit/a.test.ts', ['failed']),
      report('/repo/gitnexus/test/unit/a.test.ts', ['passed']),
    ]);
    expect(result.failures.some((message) => message.includes('contract case 0'))).toBe(true);
  });

  it('counts failed tests separately from tests that never executed', () => {
    const result = reconcileTestReports([
      report('/repo/gitnexus/test/unit/a.test.ts', ['passed', 'failed', 'pending']),
    ]);
    expect(result.report.numPassedTests).toBe(1);
    expect(result.report.numFailedTests).toBe(1);
    expect(result.report.numPendingTests).toBe(1);
    expect(result.unverified).toHaveLength(1);
    expect(result.report.success).toBe(false);
  });

  it('does not collapse identical titles from different files or repeated cases', () => {
    const repeated = report('/repo/gitnexus/test/unit/a.test.ts', ['passed', 'pending']);
    repeated.testResults[0].assertionResults[1].title = 'case 0';
    repeated.testResults[0].assertionResults[1].fullName = 'contract case 0';
    const result = reconcileTestReports([
      repeated,
      report('/repo/gitnexus/test/unit/b.test.ts', ['passed']),
    ]);
    expect(result.total).toBe(3);
    expect(result.unverified).toHaveLength(1);
  });

  it('matches source locations when repeated titles are collected in a different order', () => {
    const first = report('/repo/gitnexus/test/unit/a.test.ts', ['pending', 'passed']);
    first.testResults[0].assertionResults[1].title = 'case 0';
    first.testResults[0].assertionResults[1].fullName = 'contract case 0';
    const second = structuredClone(first);
    second.testResults[0].assertionResults.reverse();
    const result = reconcileTestReports([first, second]);
    expect(result.total).toBe(2);
    expect(result.unverified).toHaveLength(1);
  });

  it('rejects ambiguous parameterized cases with the same name and location', () => {
    const input = report('/repo/gitnexus/test/unit/a.test.ts', ['passed']);
    input.testResults[0].assertionResults.push({ ...input.testResults[0].assertionResults[0] });
    expect(() => reconcileTestReports([input])).toThrow(/ambiguous/i);
  });

  it('reconciles source-adjacent web tests on Linux and Windows', () => {
    const result = reconcileTestReports(
      [
        report('/repo/gitnexus-web/src/lib/upload-filter.test.ts', ['passed']),
        report('C:/repo/gitnexus-web/src/lib/upload-filter.test.ts', ['passed']),
      ],
      ['src/lib/upload-filter.test.ts'],
      'gitnexus-web',
    );
    expect(result.report.success).toBe(true);
    expect(result.total).toBe(1);
    expect(() =>
      reconcileTestReports(
        [report('/repo/gitnexus-web/test/unit/a.test.ts', ['passed'])],
        ['test/unit/a.test.ts', 'src/lib/upload-filter.test.ts'],
        'gitnexus-web',
      ),
    ).toThrow(/never collected/);
  });

  it('requires every shard receipt and the full web inventory through the CLI', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-completeness-cli-'));
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const root = path.join(temp, 'gitnexus');
    const webRoot = path.join(temp, 'gitnexus-web');
    const receipts = path.join(temp, 'receipts');
    const output = path.join(temp, 'combined.json');
    for (const directory of [
      path.join(root, 'scripts'),
      path.join(root, 'test/unit'),
      path.join(webRoot, 'src/lib'),
      receipts,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    const script = path.join(root, 'scripts/test-completeness.ts');
    copyFileSync(path.join(packageRoot, 'scripts/test-completeness.ts'), script);
    writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'test/unit/a.test.ts'), '// inventory fixture');
    writeFileSync(path.join(webRoot, 'src/lib/a.test.ts'), '// inventory fixture');
    const core = report(path.join(root, 'test/unit/a.test.ts'), ['passed']);
    const web = report(path.join(webRoot, 'src/lib/a.test.ts'), ['passed']);
    const webReport = path.join(webRoot, 'web-test-results.json');
    for (const name of [
      'coverage',
      'benchmarks',
      'preflight',
      'windows-latest-1',
      'windows-latest-2',
      'macos-latest-1',
      'macos-latest-2',
    ]) {
      writeFileSync(path.join(receipts, `${name}.json`), JSON.stringify(core));
    }
    const run = () => {
      writeFileSync(webReport, JSON.stringify(web));
      return spawnSync(process.execPath, ['--import', 'tsx', script, receipts, output, '2'], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
    };
    try {
      const complete = run();
      expect(complete.error, complete.stderr).toBeUndefined();
      expect(complete.status, complete.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, 'utf8')).numPendingTests).toBe(0);
      writeFileSync(path.join(webRoot, 'src/lib/missing.test.ts'), '// missing receipt');
      const missingSource = run();
      expect(missingSource.status).not.toBe(0);
      expect(missingSource.stderr).toContain(
        'Test file was never collected: src/lib/missing.test.ts',
      );
      rmSync(path.join(webRoot, 'src/lib/missing.test.ts'));
      rmSync(path.join(receipts, 'windows-latest-2.json'));
      const missingShard = run();
      expect(missingShard.status).not.toBe(0);
      expect(missingShard.stderr).toContain('windows-latest-2.json');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects test files missing from the collected inventory', () => {
    expect(() =>
      reconcileTestReports(
        [report('/repo/gitnexus/test/unit/a.test.ts', ['passed'])],
        ['test/unit/a.test.ts', 'test/unit/b.test.ts'],
      ),
    ).toThrow(/b.test.ts/);
  });

  it('rejects missing, empty or malformed reports instead of reporting zero skips', () => {
    expect(() => reconcileTestReports([])).toThrow();
    expect(() => reconcileTestReports([{ testResults: [] }])).toThrow();
    expect(() =>
      reconcileTestReports([{ testResults: [{ name: 'a', assertionResults: [] }] }]),
    ).toThrow();
    expect(() =>
      reconcileTestReports([report('/repo/gitnexus/test/unit/a.test.ts', ['unknown'])]),
    ).toThrow();
  });

  it('keeps failed collection and unhandled runner errors fatal', () => {
    const broken = report('/repo/gitnexus/test/unit/a.test.ts', ['passed']);
    broken.success = false;
    expect(reconcileTestReports([broken]).failures).not.toHaveLength(0);
    broken.success = true;
    broken.executionErrors = 1;
    expect(reconcileTestReports([broken]).failures).not.toHaveLength(0);
    broken.executionErrors = 0;
    broken.testResults[0].status = 'failed';
    expect(reconcileTestReports([broken]).failures).not.toHaveLength(0);
    expect(reconcileTestReports([broken]).report.numFailedTestSuites).toBe(1);
    expect(reconcileTestReports([broken]).report.testResults[0].status).toBe('failed');
  });

  it('captures a real unhandled rejection even when Vitest exits successfully', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-receipt-'));
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const root = path.join(temp, 'gitnexus');
    const output = path.join(temp, 'receipt.json');
    mkdirSync(path.join(root, 'test/unit'), { recursive: true });
    const vitestImport = pathToFileURL(
      path.join(packageRoot, 'node_modules/vitest/dist/index.js'),
    ).href;
    writeFileSync(
      path.join(root, 'test/unit/rejection.test.ts'),
      `
import { it, expect } from ${JSON.stringify(vitestImport)};
it('executes its assertion but leaks a rejection', async () => {
  expect(2 + 2).toBe(4);
  setTimeout(() => { void Promise.reject(new Error('receipt rejection probe')); }, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
});
`,
    );
    const config = path.join(root, 'vitest.config.mjs');
    writeFileSync(
      config,
      'export default { test: { include: ["test/**/*.test.ts"], includeTaskLocation: true, dangerouslyIgnoreUnhandledErrors: true } };',
    );
    try {
      const child = spawnSync(
        process.execPath,
        [
          path.join(packageRoot, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          root,
          '--config',
          config,
          '--reporter',
          path.join(packageRoot, 'scripts/execution-reporter.ts'),
          '--outputFile',
          output,
        ],
        { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      expect(receipt.numPassedTests).toBe(1);
      expect(receipt.executionErrors).toBeGreaterThan(0);
      expect(reconcileTestReports([receipt]).report.success).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
