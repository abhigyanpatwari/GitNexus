import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

const source = readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/publish.yml'),
  'utf8',
);
const jobs = (load(source) as { jobs: Record<string, Job> }).jobs;
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

  it('grants the RC Docker gate read access to workflow evidence', () => {
    expect(jobs.docker.needs).toEqual(['route', 'publish']);
    expect(jobs.docker.permissions?.actions).toBe('read');
  });
});
