import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

const ROOT = path.resolve(__dirname, '../../..');
const readYaml = (file: string) => load(readFileSync(path.join(ROOT, file), 'utf8'));
const docker = readYaml('.github/workflows/docker.yml') as { jobs: Record<string, Job> };
const publish = readYaml('.github/workflows/publish.yml') as { jobs: Record<string, Job> };
const gate = docker.jobs['release-gate'];
const image = docker.jobs['build-push'];
const modeScript = (() => {
  const script = gate.steps.find((step) => step.id === 'version')?.run;
  if (!script) throw new Error('Docker release mode guard is missing');
  return script;
})();

const fixture = mkdtempSync(path.join(os.tmpdir(), 'docker-release-gate-'));
mkdirSync(path.join(fixture, 'gitnexus'));
writeFileSync(path.join(fixture, 'gitnexus/package.json'), '{"version":"2.0.0"}');
for (const args of [
  ['init', '-q'],
  ['add', 'gitnexus/package.json'],
  ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
  ['tag', 'v2.0.0'],
  ['tag', 'v2.0.0-rc.1'],
]) {
  const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: fixture,
  encoding: 'utf8',
}).stdout.trim();

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function classify({
  event = 'push',
  ref = 'refs/tags/v2.0.0',
  tag = '',
  dryRun = false,
  packageVersion = '2.0.0',
}: {
  event?: string;
  ref?: string;
  tag?: string;
  dryRun?: boolean;
  packageVersion?: string;
} = {}) {
  const output = path.join(fixture, 'output');
  writeFileSync(output, '');
  writeFileSync(
    path.join(fixture, 'gitnexus/package.json'),
    JSON.stringify({ version: packageVersion }),
  );
  const result = spawnSync('bash', ['-c', modeScript], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: event,
      GITHUB_REF: ref,
      INPUT_TAG: tag,
      INPUT_DRY_RUN: String(dryRun),
      GITHUB_OUTPUT: output,
    },
  });
  return {
    status: result.status,
    output: Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    ),
  };
}

describe('Docker release mode guard', () => {
  it('publishes a matching stable tag and pins its checkout SHA', () => {
    expect(classify()).toEqual({
      status: 0,
      output: { sha, version: '2.0.0', publish: 'true' },
    });
  });

  it('publishes a matching RC tag', () => {
    expect(classify({ ref: 'refs/tags/v2.0.0-rc.1', packageVersion: '2.0.0-rc.1' })).toEqual({
      status: 0,
      output: { sha, version: '2.0.0-rc.1', publish: 'true' },
    });
  });

  it('accepts an explicit RC tag when a reusable caller inherits manual dispatch', () => {
    expect(
      classify({
        event: 'workflow_dispatch',
        ref: 'refs/heads/main',
        tag: 'v2.0.0-rc.1',
        packageVersion: '2.0.0-rc.1',
      }),
    ).toEqual({ status: 0, output: { sha, version: '2.0.0-rc.1', publish: 'true' } });
  });

  it.each([
    { event: 'pull_request', ref: 'refs/pull/1/merge' },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', dryRun: true },
  ])('builds without publication for $event', (context) => {
    expect(classify(context)).toEqual({ status: 0, output: { sha, publish: 'false' } });
  });

  it.each([
    { event: 'workflow_dispatch', ref: 'refs/heads/main' },
    { event: 'workflow_dispatch', ref: 'refs/tags/v2.0.0' },
    { event: 'push', ref: 'refs/heads/main' },
    { tag: '2.0.0' },
    { ref: 'refs/tags/v2.0' },
    { packageVersion: '2.0.1' },
    { tag: 'v2.0.2', packageVersion: '2.0.2' }, // A branch name is insufficient; the tag must exist.
  ])('rejects publication without a matching version tag: %j', (context) => {
    const result = classify(context);
    expect(result.status).toBe(1);
    expect(result.output.publish).toBeUndefined();
  });
});

describe('Docker publication prerequisites', () => {
  it('blocks both image builds on successful cheap and stable paid gates', () => {
    expect(image.needs).toBe('release-gate');
    expect(image.if).toBeUndefined(); // Preserve GitHub's default success() dependency guard.
    const accuracy = gate.steps.find((step) => step.run?.includes('bench/tool-accuracy/run.ts'));
    expect(accuracy?.run).toContain('--check');
    expect(accuracy?.if).toBe("steps.version.outputs.publish == 'true'");
    const paid = gate.steps.find(
      (step) => step.uses === './.github/actions/require-agent-release-evidence',
    );
    expect(paid?.if).toBe(
      "steps.version.outputs.publish == 'true' && !contains(steps.version.outputs.version, '-')",
    );
  });

  it('uses the checked revision and verified publishing output for all registry writes', () => {
    const checkout = image.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ needs.release-gate.outputs.sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const writes = image.steps.filter(
      (step) =>
        step.uses?.startsWith('docker/login-action@') ||
        step.uses?.startsWith('actions/attest-build-provenance@') ||
        step.run?.includes('cosign sign'),
    );
    expect(writes).toHaveLength(5);
    for (const step of writes) expect(step.if).toBe("needs.release-gate.outputs.publish == 'true'");
    const build = image.steps.find((step) => step.id === 'build');
    expect(build?.with?.push).toBe("${{ needs.release-gate.outputs.publish == 'true' }}");
  });

  it('shares the exact-SHA validator with npm and permits artifact reads through its caller', () => {
    const stable = publish.jobs.publish.steps.find(
      (step) => step.uses === './.github/actions/require-agent-release-evidence',
    );
    expect(stable?.if).toBe("needs.route.outputs.mode == 'stable'");
    expect(publish.jobs.docker.permissions?.actions).toBe('read');
    expect(gate.permissions).toEqual({ contents: 'read', actions: 'read' });
    const validator = readYaml('.github/actions/require-agent-release-evidence/action.yml') as {
      runs: { steps: Step[] };
    };
    expect(validator.runs.steps[0].with?.['enable-cache']).toBe(false);
    expect(validator.runs.steps[1].run).toContain('workflow_bench.release_evidence');
    expect(validator.runs.steps[1].run).toContain('--runtime-sha "$(git rev-parse HEAD)"');
  });
});
