import { describe, expect, it } from 'vitest';
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

  it('requires an unambiguous title and a real pass for helper-generated tests without locations', () => {
    const input = report('/repo/gitnexus/test/unit/a.test.ts', ['pending']);
    Reflect.deleteProperty(input.testResults[0].assertionResults[0], 'location');
    expect(reconcileTestReports([input]).unverified).toHaveLength(1);
    const passing = structuredClone(input);
    passing.testResults[0].assertionResults[0].status = 'passed';
    expect(reconcileTestReports([input, passing]).report.success).toBe(true);
    passing.testResults[0].assertionResults.push({ ...passing.testResults[0].assertionResults[0] });
    expect(() => reconcileTestReports([passing])).toThrow(/ambiguous/i);
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
});
