import assert from 'node:assert/strict';
import { it } from 'node:test';
import { expect } from 'expect';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reconcileTestReports } from '../../../../scripts/test-completeness.js';

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

it('requires every shard receipt and the full web inventory through the CLI', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-completeness-cli-'));
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
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
    assert.equal(complete.error, undefined, complete.stderr);
    assert.equal(complete.status, 0, complete.stderr);
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

it('captures a real unhandled rejection even when Vitest exits successfully', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-receipt-'));
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
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
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    expect(receipt.numPassedTests).toBe(1);
    expect(receipt.executionErrors).toBeGreaterThan(0);
    expect(reconcileTestReports([receipt]).report.success).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
