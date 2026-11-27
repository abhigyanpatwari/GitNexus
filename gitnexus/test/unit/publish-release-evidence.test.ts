import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, onTestFinished } from 'vitest';

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: Step[];
}

const source = readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/publish.yml'),
  'utf8',
);
const { jobs, on } = load(source) as { jobs: Record<string, Job>; on: Record<string, unknown> };
const publish = jobs.publish;
const steps = publish.steps ?? [];
const step = (name: string) => {
  const found = steps.find((item) => item.name === name);
  if (!found) throw new Error(`Missing publish step: ${name}`);
  return found;
};
const before = (first: string, second: string) =>
  steps.indexOf(step(first)) < steps.indexOf(step(second));

// Exercise the actual Actions expression. Bracket conversion handles
// hyphenated job identifiers in JavaScript.
function permitsPublication({
  mode = 'rc',
  ci = 'success',
  guarded = 'true',
}: { mode?: string; ci?: string; guarded?: string } = {}) {
  const expression = String(publish.if)
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  const evaluate = new Function('needs', 'always', `return (${expression});`);
  return evaluate(
    {
      route: { result: 'success', outputs: { mode } },
      'rc-guard': { outputs: { should_run: guarded } },
      ci: { result: ci },
    },
    () => true,
  );
}

// Discussion #3493: fixed-answer accuracy on every RC; paid paired agent runs
// before stable releases and on a schedule against the latest RC.
describe('publish.yml release evidence', () => {
  it('offers manual RC dispatch and subscribes only to release tags on push', () => {
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(on.push).toEqual({ tags: ['v*', '!v*-rc.*'] });
  });

  it.skipIf(process.platform === 'win32').each([
    ['workflow_dispatch', 'refs/heads/main', 0, ['mode=rc']],
    ['workflow_dispatch', 'refs/heads/topic', 1, []],
    ['workflow_dispatch', 'refs/tags/v2.3.4', 1, []],
    ['push', 'refs/heads/main', 1, []],
    ['push', 'refs/tags/v2.3.4', 0, ['mode=stable']],
    ['push', 'refs/tags/v2.3.4-rc.1', 1, []],
    ['push', 'refs/tags/v2.3.4-beta.1', 1, []],
  ] as const)('classifies %s on %s', (event, ref, status, mode) => {
    const script = jobs.route.steps?.find((item) => item.name === 'Classify')?.run ?? '';
    const dir = mkdtempSync(path.join(tmpdir(), 'publish-classify-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, 'output');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: event,
        GH_REF: ref,
        GH_REF_NAME: ref.split('/').at(-1),
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, result.stderr).toBe(status);
    expect(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('mode=')),
    ).toEqual(mode);
  });

  it('publishes RCs after CI without waiting for a paid agent evaluation', () => {
    expect(publish.needs).toEqual(['route', 'rc-guard', 'ci']);
    expect(Object.keys(jobs)).not.toContain('rc-evaluation');
    expect(source).not.toContain('release-evaluation.yml');
    expect(permitsPublication()).toBe(true);
    expect(permitsPublication({ ci: 'failure' })).toBe(false);
    expect(permitsPublication({ guarded: 'false' })).toBe(false);
  });

  it('attaches this run’s fixed-answer accuracy to every release', () => {
    const accuracy = step("Download this release's tool accuracy");
    expect(accuracy.if).toBeUndefined();
    expect(accuracy.with?.name).toBe('release-tool-accuracy');
    expect(accuracy.with?.['run-id']).toBeUndefined();
    expect(before("Download this release's tool accuracy", 'Create and push rc tags')).toBe(true);
    const release = step('Create GitHub Release');
    expect(release.with?.files).toBe('${{ runner.temp }}/release-evidence/*');
    expect(release.with?.fail_on_unmatched_files).toBe(true);
  });

  it('requires exact-commit paired agent evidence before a stable npm publish', () => {
    const evidence = step('Require paired agent evidence for this stable commit');
    expect(evidence.if).toBe("needs.route.outputs.mode == 'stable'");
    expect(evidence.uses).toBe('./.github/actions/require-agent-release-evidence');
    expect(before('Require paired agent evidence for this stable commit', 'Publish to npm')).toBe(
      true,
    );
    expect(publish.permissions?.actions).toBe('read');
    expect(step('Create GitHub Release').with?.body_path).toBe(
      "${{ needs.route.outputs.mode == 'stable' && '/tmp/release-notes.md' || '' }}",
    );
  });

  it('builds images after successful npm publication for the same version and commit', () => {
    expect(jobs.docker.needs).toBe('publish');
    expect(jobs.docker.if).toBe(
      "${{ !cancelled() && needs.publish.result == 'success' && needs.publish.outputs.vtag != '' }}",
    );
    expect(jobs.docker.with).toEqual({
      tag: '${{ needs.publish.outputs.vtag }}',
      'release-sha': '${{ needs.publish.outputs.release_sha }}',
    });
    expect(jobs.docker.permissions?.actions).toBe('read');
  });
});
