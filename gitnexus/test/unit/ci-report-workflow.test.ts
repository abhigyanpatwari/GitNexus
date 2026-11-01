import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workflow = load(
  readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci-report.yml'), 'utf8'),
) as {
  jobs: Record<string, { steps: Array<{ name: string; run?: string; with?: { script: string } }> }>;
};
const steps = workflow.jobs['pr-report'].steps;
const requireCjs = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...arguments_: string[]
) => (...arguments_: unknown[]) => Promise<void>;

type Artifact = { id: number; name: string };
let temp: string;

beforeEach(() => {
  temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-ci-report-'));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

function fixture(artifacts: Artifact[]) {
  const listWorkflowRunArtifacts = vi.fn(async ({ per_page = 30 }: { per_page?: number }) => ({
    data: { total_count: artifacts.length, artifacts: artifacts.slice(0, per_page) },
  }));
  const downloadArtifact = vi.fn(async ({ artifact_id }: { artifact_id: number }) => ({
    data: Buffer.from(`archive-${artifact_id}`),
  }));
  const github = {
    rest: {
      actions: {
        listWorkflowRunArtifacts,
        downloadArtifact,
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [{ id: 123 }] } })),
      },
    },
    // Octokit's paginate returns the flattened artifact array, unlike the REST response.
    paginate: vi.fn(async () => artifacts),
  };
  const core = { warning: vi.fn(), info: vi.fn(), setOutput: vi.fn() };
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { workflow_run: { id: 456 } },
  };
  return {
    github,
    core,
    downloadArtifact,
    async run(name: string) {
      const script = steps.find((step) => step.name === name)?.with?.script;
      if (!script) throw new Error(`Missing script: ${name}`);
      const execute = new AsyncFunction('github', 'context', 'core', 'require', 'process', script);
      await execute(github, context, core, requireCjs, { env: { RUNNER_TEMP: temp } });
    },
  };
}

function precedingArtifacts(count: number): Artifact[] {
  return Array.from({ length: count }, (_, id) => ({ id, name: `shard-${id}` }));
}

describe('CI report artifact discovery', () => {
  it.each([0, 130])('downloads report artifacts after %i unrelated artifacts', async (count) => {
    const names = ['pr-meta', 'test-reports', 'test-dupes'];
    const api = fixture([
      ...precedingArtifacts(count),
      ...names.map((name, index) => ({ id: 1000 + index, name })),
    ]);

    await api.run('Download artifacts');

    expect(readdirSync(path.join(temp, 'dl')).sort()).toEqual(
      names.map((name) => `${name}.zip`).sort(),
    );
    for (const [index, name] of names.entries()) {
      expect(readFileSync(path.join(temp, 'dl', `${name}.zip`), 'utf8')).toBe(
        `archive-${1000 + index}`,
      );
    }
    expect(api.core.warning).not.toHaveBeenCalled();
  });

  it.each([0, 130])('finds base coverage after %i unrelated artifacts', async (count) => {
    const api = fixture([...precedingArtifacts(count), { id: 1000, name: 'test-reports' }]);

    await api.run('Fetch base branch coverage');

    expect(readFileSync(path.join(temp, 'base-coverage', 'base.zip'), 'utf8')).toBe('archive-1000');
    expect(api.core.setOutput).toHaveBeenCalledWith('found', 'true');
  });

  it.skipIf(process.platform === 'win32')(
    'skips reporting cleanly when no artifacts exist',
    async () => {
      const api = fixture([]);
      await api.run('Download artifacts');

      const output = path.join(temp, 'outputs');
      for (const name of ['Extract artifacts', 'Read PR metadata']) {
        const script = steps.find((step) => step.name === name)?.run;
        if (!script) throw new Error(`Missing script: ${name}`);
        execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
          env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
        });
      }

      expect(readFileSync(output, 'utf8').trim()).toBe('skip=true');
      expect(api.downloadArtifact).not.toHaveBeenCalled();
    },
  );

  it('still fails when downloading an existing report artifact fails', async () => {
    const api = fixture([{ id: 1000, name: 'pr-meta' }]);
    api.downloadArtifact.mockRejectedValueOnce(new Error('download failed'));

    await expect(api.run('Download artifacts')).rejects.toThrow('download failed');
  });
});
