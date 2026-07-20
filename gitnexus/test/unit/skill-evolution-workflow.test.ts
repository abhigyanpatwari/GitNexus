import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// Contract guard for the online skill-evolution workflow. Both P1 blockers
// fixed here (a gate-passing run never applied its overlay; the benchmark
// could not resolve its task repo on a hosted runner) reached production
// because nothing exercised this workflow's path. Assert the structural
// contract so a regression fails loudly in CI instead of on the first real run.
const WORKFLOW_PATH = path.resolve(
  __dirname,
  '../../../.github/workflows/gitnexus-skill-evolution.yml',
);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const workflowDocument = load(workflow) as {
  jobs?: Record<
    string,
    {
      environment?: unknown;
      steps?: Array<{
        name?: string;
        run?: unknown;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

const evolveJob = workflowDocument.jobs?.evolve;

function stepRun(stepName: string): string {
  const step = evolveJob?.steps?.find(({ name }) => name === stepName);
  return typeof step?.run === 'string' ? step.run : '';
}

describe('gitnexus skill-evolution workflow contract', () => {
  it('applies gate-passing overlays so the promotion-PR path is reachable', () => {
    const loop = stepRun('Run the propose → benchmark → gate loop');
    expect(loop).toContain('python -m workflow_bench.evolve');
    // Without --apply the overlay is never written, git status stays clean,
    // promoted=false is emitted, and the App-token/PR steps are dead code.
    expect(loop).toContain('--apply');
  });

  it('runs the proposer on its own model, separate from the benchmark arms', () => {
    const loop = stepRun('Run the propose → benchmark → gate loop');
    // The benchmark arms match the production model; the proposer/diagnosis
    // session gets its own (stronger) model — one session per generation.
    expect(loop).toContain('--model "${MODEL}"');
    expect(loop).toContain('--proposer-model "${PROPOSER_MODEL}"');
  });

  it('provisions the benchmark task repo at ~/GitNexus before the loop', () => {
    const provision = stepRun('Point the benchmark task repo at the checkout');
    expect(provision).toContain('ln -sfn');
    expect(provision).toContain('${GITHUB_WORKSPACE}');
    expect(provision).toContain('${HOME}/GitNexus');
  });

  it('names the promotion branch with the run attempt for re-run recovery', () => {
    const openPr = stepRun('Open the promotion PR');
    expect(openPr).toContain('${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}');
  });

  it('emits only the promoted generation with a per-run random output delimiter', () => {
    const detect = stepRun('Detect and bound the applied promotion');
    // Random per-run delimiter, not a fixed heredoc marker that a summary
    // value could close early.
    expect(detect).toContain('openssl rand -hex');
    expect(detect).not.toContain("echo 'summary<<PROMOTION_EOF'");
    // Single promoted generation (highest-numbered gen-N), not a blind
    // concatenation of every generation's promotion.json.
    expect(detect).toContain('sort -V');
    expect(detect).not.toContain('xargs -0 -r cat');
  });

  it('least-privileges the App token and gates the job on a protected Environment', () => {
    expect(evolveJob?.environment).toBe('gitnexus-evolution');
    const mint = evolveJob?.steps?.find(({ name }) => name === 'Mint GitHub App token');
    expect(mint?.with).toMatchObject({
      'client-id': expect.any(String),
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(mint?.with).not.toHaveProperty('app-id');
  });

  it('labels the upload-artifact pin with its real version', () => {
    expect(workflow).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
    );
    expect(workflow).not.toContain('# v6.0.0');
  });

  it('runs every multi-line shell step under strict mode', () => {
    const runSteps = (evolveJob?.steps ?? []).filter(
      (step): step is { name?: string; run: string } =>
        typeof step.run === 'string' && step.run.includes('\n'),
    );
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) {
      expect(step.run, `${step.name} must set -euo pipefail`).toContain('set -euo pipefail');
    }
  });

  it('documents the App secrets and protected Environment on the activation checklist', () => {
    expect(workflow).toContain('RELEASE_APP_ID');
    expect(workflow).toContain('RELEASE_APP_PRIVATE_KEY');
    expect(workflow).toContain('gitnexus-evolution');
  });
});
