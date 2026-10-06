import { globSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestRunEndReason } from 'vitest/node';

type Assertion = {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: string;
  location?: { line: number; column: number };
};
type Suite = {
  name: string;
  status: string;
  assertionResults: Assertion[];
  endTime?: number;
  message?: string;
};
type Report = {
  success?: boolean;
  numTotalTests?: number;
  startTime?: number;
  executionErrors: number;
  executionReason: TestRunEndReason;
  testResults: Suite[];
};

/** Stable across GitHub's Linux, macOS and Windows checkout roots. */
function testPath(name: string, packageName: string): string {
  const normalized = name.replaceAll('\\', '/');
  const relative =
    normalized.match(new RegExp(`(?:^|/)${packageName}/((?:test|src)/.+)$`))?.[1] ?? normalized;
  if (!/^(?:test|src)\/.+\.test\.[jt]sx?$/.test(relative)) {
    throw new Error(`Invalid test report path: ${name}`);
  }
  return relative;
}

/** A skip is resolved only by a recorded pass of that same test in another job. */
export function reconcileTestReports(
  inputs: unknown[],
  expectedFiles: string[] = [],
  packageName = 'gitnexus',
) {
  if (inputs.length === 0) throw new Error('No execution reports supplied');
  const tests = new Map<
    string,
    { file: string; assertion: Assertion; passed: boolean; failed: boolean }
  >();
  const failures = new Set<string>();
  const failedSuites = new Set<string>();
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (const [index, input] of inputs.entries()) {
    const report = input as Report;
    if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) {
      throw new Error(`Missing or empty execution report ${index}`);
    }
    if (report.success === false) failures.add(`Report ${index}: unsuccessful runner result`);
    if (
      !Number.isInteger(report.executionErrors) ||
      report.executionErrors < 0 ||
      !['passed', 'failed', 'interrupted'].includes(report.executionReason)
    ) {
      throw new Error(`Report ${index}: missing execution reporter evidence`);
    }
    if (report.executionErrors || report.executionReason !== 'passed') {
      failures.add(
        `Report ${index}: ${report.executionErrors} unhandled errors; ${report.executionReason}`,
      );
    }
    if (typeof report.startTime === 'number') startTimes.push(report.startTime);
    let count = 0;
    const seen = new Set<string>();
    for (const suite of report.testResults) {
      const file = testPath(suite.name, packageName);
      if (!Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0) {
        throw new Error(`No collected tests in ${file}`);
      }
      if (suite.status === 'failed') {
        failures.add(`${file}: failed suite`);
        failedSuites.add(file);
      }
      if (typeof suite.endTime === 'number') endTimes.push(suite.endTime);
      for (const assertion of suite.assertionResults) {
        if (
          !['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(
            assertion.status,
          ) ||
          !Array.isArray(assertion.ancestorTitles) ||
          typeof assertion.title !== 'string' ||
          (assertion.location !== undefined &&
            (!Number.isInteger(assertion.location.line) ||
              !Number.isInteger(assertion.location.column)))
        ) {
          throw new Error(`Malformed assertion in ${file}`);
        }
        // Collection order differs across platforms. Source location, not an
        // ordinal, distinguishes equal titles declared at different locations.
        // Helper-generated tests may have no location; their complete title
        // must then be unique within the file (the duplicate check still applies).
        const title = JSON.stringify([...assertion.ancestorTitles, assertion.title]);
        const key = JSON.stringify([
          file,
          title,
          assertion.location?.line ?? null,
          assertion.location?.column ?? null,
        ]);
        if (seen.has(key))
          throw new Error(
            `Ambiguous test identity in ${file}: ${title}; give parameterized cases unique titles`,
          );
        seen.add(key);
        const result = tests.get(key) ?? { file, assertion, passed: false, failed: false };
        result.passed ||= assertion.status === 'passed';
        result.failed ||= assertion.status === 'failed';
        tests.set(key, result);
        if (result.failed) failures.add(`${file}: ${assertion.fullName ?? title}`);
        count++;
      }
    }
    if (typeof report.numTotalTests === 'number' && report.numTotalTests !== count) {
      throw new Error(`Report ${index}: expected ${report.numTotalTests} tests, found ${count}`);
    }
  }
  const unverified = [...tests.values()]
    .filter((test) => !test.passed && !test.failed)
    .map((test) => `${test.file}: ${test.assertion.fullName}`);
  const suites = new Map<string, Suite>();
  for (const test of tests.values()) {
    const status = test.failed ? 'failed' : test.passed ? 'passed' : 'pending';
    const suite = suites.get(test.file) ?? {
      name: test.file,
      status: 'passed',
      assertionResults: [],
    };
    suite.assertionResults.push({ ...test.assertion, status });
    if (status === 'failed' || failedSuites.has(test.file)) suite.status = 'failed';
    suites.set(test.file, suite);
  }
  for (const file of expectedFiles) {
    if (!suites.has(file.replaceAll('\\', '/')))
      throw new Error(`Test file was never collected: ${file}`);
  }
  const passed = [...tests.values()].filter((test) => test.passed && !test.failed).length;
  const endTime = endTimes.length ? Math.max(...endTimes) : 0;
  return {
    total: tests.size,
    passed,
    unverified,
    failures: [...failures],
    report: {
      success: failures.size === 0 && unverified.length === 0,
      numTotalTests: tests.size,
      numPassedTests: passed,
      numFailedTests: [...tests.values()].filter((test) => test.failed).length,
      numPendingTests: unverified.length,
      numTotalTestSuites: suites.size,
      numFailedTestSuites: failedSuites.size,
      executionFailures: [...failures],
      startTime: startTimes.length ? Math.min(...startTimes) : 0,
      testResults: [...suites.values()].map((suite) => ({ ...suite, endTime })),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, output, shardsText] = process.argv.slice(2);
  const shards = Number(shardsText);
  if (!directory || !output || !Number.isInteger(shards) || shards < 1) {
    throw new Error('Usage: test-completeness.ts <reports-dir> <output.json> <platform-shards>');
  }
  const names = ['coverage.json', 'benchmarks.json', 'preflight.json'];
  for (const os of ['windows-latest', 'macos-latest']) {
    for (let shard = 1; shard <= shards; shard++) names.push(`${os}-${shard}.json`);
  }
  // Exact expected receipts: an absent/cancelled job is never an empty success.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const expected = globSync('test/**/*.test.ts', { cwd: root });
  const result = reconcileTestReports(
    names.map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8'))),
    expected,
  );
  writeFileSync(output, JSON.stringify(result.report));
  console.log(
    `Test execution: ${result.passed}/${result.total} passed; ${result.unverified.length} unverified; ${result.failures.length} failures`,
  );
  for (const message of [...result.unverified, ...result.failures]) console.error(message);
  if (!result.report.success) process.exitCode = 1;
  const webPath = path.join(root, '../gitnexus-web/web-test-results.json');
  const web = reconcileTestReports(
    [JSON.parse(readFileSync(webPath, 'utf8'))],
    globSync('{test,src}/**/*.test.{ts,tsx}', { cwd: path.join(root, '../gitnexus-web') }),
    'gitnexus-web',
  );
  writeFileSync(webPath, JSON.stringify(web.report));
  console.log(
    `Web execution: ${web.passed}/${web.total} passed; ${web.unverified.length} unverified; ${web.failures.length} failures`,
  );
  for (const message of [...web.unverified, ...web.failures]) console.error(message);
  if (!web.report.success) process.exitCode = 1;
}
