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
type Job = { if?: string; steps?: Step[]; needs?: string[] };

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

describe('SonarQube coverage handoff', () => {
  it('keeps threshold failures blocking while allowing both reports to reach the scanner', () => {
    const step = (name: string) => namedStep(producer, name);
    const merge = step('Merge coverage + enforce thresholds');
    const java = step('Add compiler conformance to the CLI SonarQube report');
    const web = step('Run gitnexus-web unit tests');
    const upload = step('Upload SonarQube coverage');
    expect(merge['continue-on-error']).toBeUndefined();
    expect(web['continue-on-error']).toBeUndefined();
    for (const name of [
      'Download Java conformance LCOV',
      'Download TypeScript conformance LCOV',
      'Add compiler conformance to the CLI SonarQube report',
      'Install gitnexus-web dependencies',
      'Run gitnexus-web unit tests',
    ]) {
      expect(step(name).if).toContain('!cancelled()');
    }
    expect(producer.indexOf(java)).toBeGreaterThan(producer.indexOf(merge));
    expect(upload.if).toContain("steps.conformance-lcov.outcome == 'success'");
    expect(upload.if).toContain('!cancelled()');
    expect(upload['continue-on-error']).toBe(true);
    expect(upload.with?.path.trim().split('\n')).toEqual(
      packages.map((pkg) => `${pkg}/coverage/lcov.info`),
    );
    expect(producer.indexOf(upload)).toBeGreaterThan(
      producer.indexOf(step('Run docker-server integration tests')),
    );
    expect(readWorkflow('ci').jobs.sonar.if).toContain('!cancelled()');
    expect(readWorkflow('ci').jobs.sonar.if).not.toMatch(/success\(|needs\.tests/);
  });

  it.skipIf(process.platform === 'win32')(
    'appends Java and TypeScript hits and requires the CLI report',
    () => {
      temp = mkdtempSync(path.join(tmpdir(), 'sonar-java-coverage-'));
      const coverage = path.join(temp, 'coverage');
      const java = path.join(temp, 'java-conformance-coverage');
      mkdirSync(coverage);
      mkdirSync(java);
      const typescript = path.join(temp, 'typescript-conformance-coverage');
      mkdirSync(typescript);
      const source = 'SF:src/index.ts\nDA:1,0\nend_of_record\n';
      const javaSource = 'SF:src/ingestion.ts\nDA:2,1\nend_of_record\n';
      writeFileSync(path.join(java, 'lcov.info'), javaSource);
      const tsSource = 'SF:src/typescript.ts\nDA:3,1\nend_of_record\n';
      writeFileSync(path.join(typescript, 'lcov.info'), tsSource);
      const script = namedStep(
        producer,
        'Add compiler conformance to the CLI SonarQube report',
      ).run!;
      const combine = () =>
        spawnSync('bash', ['-e', '-c', script], {
          cwd: temp,
          env: { ...process.env, RUNNER_TEMP: temp },
        });
      expect(combine().status).toBe(1);
      writeFileSync(path.join(coverage, 'lcov.info'), source);
      expect(combine().status).toBe(0);
      expect(readFileSync(path.join(coverage, 'lcov.info'), 'utf8')).toBe(
        source + javaSource + tsSource,
      );
    },
  );

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

  it
    .skipIf(process.platform === 'win32')
    .each(['complete', 'missing web', 'empty web', 'unknown source', 'outside package'])(
    'prepares both package reports only for a complete checkout (%s)',
    (scenario) => {
      temp = mkdtempSync(path.join(tmpdir(), 'sonar-coverage-'));
      for (const pkg of packages) {
        const source = path.join(temp, pkg, 'src');
        mkdirSync(source, { recursive: true });
        writeFileSync(path.join(source, 'index.ts'), 'export const n = 1;');
        if (pkg === 'gitnexus-web' && scenario === 'missing web') continue;
        const reports = path.join(temp, 'sonar-coverage', pkg, 'coverage');
        mkdirSync(reports, { recursive: true });
        let sf = pkg === 'gitnexus-web' && scenario === 'unknown source' ? 'absent.ts' : 'index.ts';
        if (pkg === 'gitnexus-web' && scenario === 'outside package')
          sf = '../../gitnexus/src/index.ts';
        const data = pkg === 'gitnexus-web' && scenario === 'empty web' ? '' : 'DA:1,0\n';
        writeFileSync(path.join(reports, 'lcov.info'), `SF:src/${sf}\n${data}end_of_record\n`);
      }
      const prepare = namedStep(scanner, 'Prepare repository-relative LCOV').run;
      if (!prepare) throw new Error('The LCOV preparation step must run a shell script');
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', prepare], {
        cwd: temp,
        env: { ...process.env, RUNNER_TEMP: temp },
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (scenario === 'complete') {
        expect(result.status, result.stderr).toBe(0);
        const lcov = readFileSync(path.join(temp, 'coverage', 'lcov.info'), 'utf8');
        expect(lcov.match(/^SF:.*$/gm)).toEqual(packages.map((pkg) => `SF:${pkg}/src/index.ts`));
        expect(lcov.match(/^DA:1,0$/gm)).toHaveLength(2);
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('::error::');
      }
    },
  );
});
