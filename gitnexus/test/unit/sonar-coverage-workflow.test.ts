import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

type Step = {
  name?: string;
  run?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};
type Job = { if?: string; steps?: Step[]; needs?: string[]; permissions?: Record<string, string> };

function readWorkflow(name: string) {
  const file = path.resolve(__dirname, '../../../.github/workflows', name + '.yml');
  return load(readFileSync(file, 'utf8')) as {
    on: { pull_request?: { branches?: string[] } };
    jobs: Record<string, Job>;
  };
}

function namedStep(steps: Step[], name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

const producer = readWorkflow('ci-tests').jobs['coverage-merge'].steps ?? [];
const scanner = readWorkflow('sonarqube').jobs.build.steps ?? [];
const packages = ['gitnexus', 'gitnexus-web'];
let temp: string;

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('SonarQube gate', () => {
  const scan = namedStep(scanner, 'SonarQube Scan');

  it.each([
    ['pull_request', '09:14:27.012 WARN  Advisory with ERROR in the message', 0, 0],
    ['pull_request', '09:14:27.012 ERROR Failed to deserialize Protobuf message', 0, 1],
    ['pull_request', '09:14:27.012 INFO  Quality gate failed', 2, 2],
    ['workflow_run', '09:14:27.012 INFO  Complete', 0, 0],
  ] as const)('checks scanner output and exit status for %s (%s)', (event, log, exit, expected) => {
    // Run the workflow shell with a stand-in CLI and capture its actual arguments.
    const cli = 'sonar-scanner() { printf "%s\\n" "$@" "$LOG"; return "$SCAN_EXIT"; }';
    expect(scan.shell).toBe('bash'); // Actions enables pipefail for an explicit bash shell.
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', cli + '\n' + scan.run], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        MAIN_REVISION: 'abc123',
        RUNNER_TEMP: '/runner temp',
        LOG: log,
        SCAN_EXIT: String(exit),
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(expected);
    expect(result.stdout).toContain(log);
    expect(result.stdout).toContain('-Dsonar.qualitygate.wait=true');
    expect(result.stdout.split('\n')).toContain(
      '-Dsonar.java.binaries=/runner temp/sonar-java-classes',
    );
    if (event === 'workflow_run') {
      expect(result.stdout).toContain('-Dsonar.branch.name=main');
      expect(result.stdout).toContain('-Dsonar.scm.revision=abc123');
    } else {
      expect(result.stdout).not.toContain('-Dsonar.branch.name=');
    }
  });

  it.each([
    [true, 'success', 0],
    [true, 'failure', 1],
    [true, 'cancelled', 1],
    [true, 'skipped', 1],
    [false, 'skipped', 0],
  ] as const)(
    'requires Sonar success on eligible PRs (required %s, result %s)',
    (required, sonar, expected) => {
      const ci = readWorkflow('ci');
      const gate = ci.jobs['ci-status'];
      expect(gate.needs).toContain('sonar');
      const check = namedStep(gate.steps ?? [], 'Check all jobs passed');
      expect(check.env?.SONAR).toBe('${{ needs.sonar.result }}');
      const eligible = ci.jobs.sonar.if?.replace('!cancelled() && ', '').trim();
      expect(check.env?.SONAR_REQUIRED).toBe('${{ ' + eligible + ' }}');
      if (!check.run) throw new Error('Missing CI gate script');
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', check.run], {
        env: {
          ...process.env,
          QUALITY: 'success',
          PLAN_RESULT: 'success',
          TESTS: 'success',
          E2E: 'skipped',
          SONAR: sonar,
          SONAR_REQUIRED: String(required),
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(expected);
    },
  );
});

describe.skipIf(process.platform === 'win32')('selected CI checks', () => {
  const ci = readWorkflow('ci');
  const gate = namedStep(ci.jobs['ci-status'].steps ?? [], 'Check all jobs passed');

  it('takes the required checks from the plan and the actual results from the jobs', () => {
    expect(gate.env?.PLAN_RESULT).toBe('${{ needs.plan.result }}');
    expect(gate.env?.E2E).toBe('${{ needs.e2e.result }}');
    expect(gate.env?.E2E_REQUIRED).toContain('.run.browser');
    expect(gate.env?.QUALITY).toBe('${{ needs.quality.result }}');
    for (const lane of ['quality', 'cli', 'web', 'workflows']) {
      expect(gate.env?.QUALITY_REQUIRED).toContain('.run.' + lane);
    }
  });

  it.each([
    ['required E2E skipped', { E2E: 'skipped', E2E_REQUIRED: 'true' }, 1],
    ['optional E2E skipped', { E2E: 'skipped', E2E_REQUIRED: 'false' }, 0],
    ['required quality skipped', { QUALITY: 'skipped', QUALITY_REQUIRED: 'true' }, 1],
    ['optional quality skipped', { QUALITY: 'skipped', QUALITY_REQUIRED: 'false' }, 0],
    ['plan failed', { PLAN_RESULT: 'failure' }, 1],
  ] as const)('%s', (_description, env, expected) => {
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', gate.run!], {
      env: {
        PLAN_RESULT: 'success',
        E2E: 'success',
        QUALITY: 'success',
        TESTS: 'success',
        SONAR: 'success',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(expected);
  });

  it.each([
    [{}, 0],
    [{ RUN_CLI: 'true', TESTS: 'skipped' }, 1],
    [{ RUN_JAVA: 'true', JAVA: 'failure' }, 1],
  ] as const)('checks results before merging coverage (%j)', (env, expected) => {
    const step = namedStep(producer, 'Require selected CLI suites');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run!], {
      env: { RUN_CLI: 'true', RUN_JAVA: 'true', TESTS: 'success', JAVA: 'success', ...env },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(expected);
  });

  it.each([
    [{}, 0],
    [{ RUN_COVERAGE: 'true', COVERAGE: 'skipped' }, 1],
    [{ RUN_EVAL: 'true', EVAL: 'failure' }, 1],
    [{ RUN_ABI: 'true', ABI: 'cancelled' }, 1],
    [{ RUN_ABI: 'false', ABI: 'success' }, 1],
  ] as const)('checks results of each selected PR suite (%j)', (env, expected) => {
    const audit = readWorkflow('ci-tests').jobs['test-completeness'];
    const step = namedStep(audit.steps ?? [], 'Require every selected PR suite to pass');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run!], {
      env: {
        RUN_COVERAGE: 'false',
        COVERAGE: 'skipped',
        RUN_EVAL: 'false',
        EVAL: 'skipped',
        RUN_ABI: 'false',
        ABI: 'skipped',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(expected);
  });

  it('grants release planning access to PR and Actions evidence through both workflow calls', () => {
    for (const job of [ci.jobs.plan, readWorkflow('publish').jobs.ci]) {
      expect(job.permissions).toMatchObject({ 'pull-requests': 'read', actions: 'read' });
    }
  });
});

describe('SonarQube coverage handoff', () => {
  it('keeps threshold failures blocking while allowing both reports to reach the scanner', () => {
    const step = (name: string) => namedStep(producer, name);
    const merge = step('Merge coverage + enforce thresholds');
    const java = step('Add Java conformance to the CLI SonarQube report');
    const web = step('Run gitnexus-web unit tests');
    const upload = step('Upload SonarQube coverage');
    expect(merge['continue-on-error']).toBeUndefined();
    expect(web['continue-on-error']).toBeUndefined();
    for (const name of [
      'Download Java conformance LCOV',
      'Add Java conformance to the CLI SonarQube report',
      'Install gitnexus-web dependencies',
      'Run gitnexus-web unit tests',
    ]) {
      expect(step(name).if).toContain('!cancelled()');
    }
    expect(producer.indexOf(java)).toBeGreaterThan(producer.indexOf(merge));
    expect(upload.if).toContain(
      "(!fromJSON(inputs.plan).run.java || steps.java-lcov.outcome == 'success')",
    );
    expect(upload.if).toContain('!cancelled()');
    expect(upload['continue-on-error']).toBe(true);
    expect(upload.with?.path).toBe('${{ runner.temp }}/sonar-coverage/');
    const stage = step('Stage LCOV for the scanner');
    const evidence = step('Stage selected package evidence');
    expect(stage.run).toMatch(/copy-ci-reports\.sh .* lcov$/);
    expect(evidence.run).toMatch(/copy-ci-reports\.sh .* evidence$/);
    for (const source of [stage, evidence]) {
      expect(source.env).toMatchObject({
        CLI: "${{ contains(fromJSON(inputs.plan).packages, 'cli') }}",
        WEB: "${{ contains(fromJSON(inputs.plan).packages, 'web') }}",
      });
    }
    expect(namedStep(scanner, 'Prepare repository-relative LCOV').env).toMatchObject({
      CLI: "${{ contains(fromJSON(inputs.packages), 'cli') }}",
      WEB: "${{ contains(fromJSON(inputs.packages), 'web') }}",
    });
    expect(producer.indexOf(upload)).toBeGreaterThan(
      producer.indexOf(step('Run docker-server integration tests')),
    );
    expect(readWorkflow('ci').jobs.sonar.if).toContain('!cancelled()');
    expect(readWorkflow('ci').jobs.sonar.if).not.toMatch(/success\(|needs\.tests/);
  });

  it.skipIf(process.platform === 'win32')('appends Java hits and requires the CLI report', () => {
    temp = mkdtempSync(path.join(tmpdir(), 'sonar-java-coverage-'));
    const coverage = path.join(temp, 'coverage');
    const java = path.join(temp, 'java-conformance-coverage');
    mkdirSync(coverage);
    mkdirSync(java);
    const source = 'SF:src/index.ts\nDA:1,0\nend_of_record\n';
    const javaSource = 'SF:src/ingestion.ts\nDA:2,1\nend_of_record\n';
    writeFileSync(path.join(java, 'lcov.info'), javaSource);
    const script = namedStep(producer, 'Add Java conformance to the CLI SonarQube report').run;
    if (!script) throw new Error('Missing Java LCOV merge step');
    const combine = () =>
      spawnSync('bash', ['-e', '-c', script], {
        cwd: temp,
        env: { ...process.env, RUNNER_TEMP: temp },
      });
    expect(combine().status).toBe(1);
    writeFileSync(path.join(coverage, 'lcov.info'), source);
    expect(combine().status).toBe(0);
    expect(readFileSync(path.join(coverage, 'lcov.info'), 'utf8')).toBe(source + javaSource);
  });

  it('scans stacked PRs and pins main coverage to the trusted Publish run', () => {
    const ci = readWorkflow('ci');
    expect(ci.on.pull_request).toBeDefined();
    expect(ci.on.pull_request?.branches).toBeUndefined();
    expect(ci.jobs.sonar.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(readWorkflow('publish').jobs.sonar).toBeUndefined();
    const source = readWorkflow('sonarqube-main').jobs.source;
    for (const condition of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      expect(source.if).toContain(condition);
    }
    const download = namedStep(scanner, 'Download CLI and web LCOV');
    expect(download.with?.['run-id']).toContain('github.event.workflow_run.id || github.run_id');
    expect(scanner[0].with?.ref).toContain('github.event.workflow_run.head_sha || github.sha');
  });

  type Report = { pkg: string; source: string; data: string };
  const cliReport = { pkg: 'gitnexus', source: 'src/index.ts', data: 'DA:1,0\n' };
  const webReport = { ...cliReport, pkg: 'gitnexus-web' };
  function prepareReports(reports: Report[], selected: readonly string[]) {
    temp = mkdtempSync(path.join(tmpdir(), 'sonar-coverage-'));
    for (const pkg of packages) {
      const source = path.join(temp, pkg, 'src');
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, 'index.ts'), 'export const n = 1;');
    }
    for (const { pkg, source, data } of reports) {
      const dest = path.join(temp, 'sonar-coverage', pkg, 'coverage');
      mkdirSync(dest, { recursive: true });
      writeFileSync(path.join(dest, 'lcov.info'), `SF:${source}\n${data}end_of_record\n`);
    }
    const prepare = namedStep(scanner, 'Prepare repository-relative LCOV').run;
    if (!prepare) throw new Error('The LCOV preparation step must run a shell script');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', prepare], {
      cwd: temp,
      env: {
        ...process.env,
        RUNNER_TEMP: temp,
        CLI: String(selected.includes('gitnexus')),
        WEB: String(selected.includes('gitnexus-web')),
      },
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    return result;
  }

  it.skipIf(process.platform === 'win32').each([
    { selected: packages, reports: [cliReport, webReport] },
    { selected: ['gitnexus'], reports: [cliReport] },
    { selected: ['gitnexus-web'], reports: [webReport] },
  ])('normalizes reports for $selected', ({ selected, reports }) => {
    const result = prepareReports(reports, selected);
    expect(result.status, result.stderr).toBe(0);
    const lcov = readFileSync(path.join(temp, 'coverage', 'lcov.info'), 'utf8');
    expect(lcov.match(/^SF:.*$/gm)).toEqual(selected.map((pkg) => `SF:${pkg}/src/index.ts`));
    expect(lcov.match(/^DA:1,0$/gm)).toHaveLength(selected.length);
  });

  it.skipIf(process.platform === 'win32').each([
    ['missing web', [cliReport]],
    ['empty web', [cliReport, { ...webReport, data: '' }]],
    ['unknown source', [cliReport, { ...webReport, source: 'src/absent.ts' }]],
    ['outside package', [cliReport, { ...webReport, source: 'src/../../gitnexus/src/index.ts' }]],
  ] as const)('rejects invalid reports (%s)', (_reason, reports) => {
    const result = prepareReports([...reports], packages);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::');
  });
});
