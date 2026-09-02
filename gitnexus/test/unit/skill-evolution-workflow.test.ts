import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
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
      env?: Record<string, string>;
      'timeout-minutes'?: unknown;
      steps?: Array<{
        name?: string;
        if?: unknown;
        run?: unknown;
        uses?: string;
        'timeout-minutes'?: unknown;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

const evolveJob = workflowDocument.jobs?.evolve;

type WorkflowStep = NonNullable<NonNullable<typeof evolveJob>['steps']>[number];

function findStep(stepName: string): WorkflowStep | undefined {
  return evolveJob?.steps?.find(({ name }) => name === stepName);
}

function stepRun(stepName: string): string {
  const step = findStep(stepName);
  return typeof step?.run === 'string' ? step.run : '';
}

function runSeedStep(ghImplementation: string): {
  output: string;
  trace: string;
  transcriptDirectoryMode?: number;
  transcriptMode?: number;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-evolution-seed-'));
  try {
    const bin = path.join(root, 'bin');
    const runnerTemp = path.join(root, 'runner-temp');
    const githubOutput = path.join(root, 'github-output');
    const trace = path.join(root, 'gh-trace');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    writeFileSync(githubOutput, '');
    const gh = path.join(bin, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\nset -euo pipefail\n${ghImplementation}\n`);
    chmodSync(gh, 0o700);
    const uv = path.join(bin, 'uv');
    writeFileSync(
      uv,
      `#!/usr/bin/env bash
set -euo pipefail
results=''
for argument in "$@"; do results="$argument"; done
content="$(cat "$results")"
if [[ -z "$content" || "$content" == *'"error_kind":"session-error"'* ]]; then exit 10; fi
exit 0
`,
    );
    chmodSync(uv, 0o700);

    execFileSync(
      '/bin/bash',
      ['-c', stepRun("Seed the proposer with the previous run's evidence")],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: githubOutput,
          GITHUB_REPOSITORY: 'abhigyanpatwari/GitNexus',
          GITHUB_RUN_ID: '999',
          RUNNER_TEMP: runnerTemp,
          TRACE: trace,
        },
        stdio: 'pipe',
      },
    );
    const output = readFileSync(githubOutput, 'utf8');
    const seed = output.match(/^seed=(.+)$/m)?.[1];
    const transcriptDirectory = seed ? path.join(seed, 'transcripts') : undefined;
    const transcript = transcriptDirectory
      ? path.join(transcriptDirectory, 'session.jsonl')
      : undefined;
    return {
      output,
      trace: readFileSync(trace, 'utf8'),
      transcriptDirectoryMode:
        transcriptDirectory && existsSync(transcriptDirectory)
          ? statSync(transcriptDirectory).mode & 0o777
          : undefined,
      transcriptMode:
        transcript && existsSync(transcript) ? statSync(transcript).mode & 0o777 : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('gitnexus skill-evolution workflow contract', () => {
  it('applies gate-passing overlays so the promotion-PR path is reachable', () => {
    const loop = stepRun('Run the propose → benchmark → gate loop');
    expect(loop).toContain('python -m workflow_bench.evolve');
    // Without --apply the overlay is never written, git status stays clean,
    // promoted=false is emitted, and the App-token/PR steps are dead code.
    expect(loop).toContain('--apply');
  });

  it('passes the cell concurrency through to the benchmark', () => {
    // The lane is serial unless told otherwise: concurrency only pays off when
    // the runner has the vCPUs for it, and a cell starved of CPU drifts toward
    // its session timeout, which the gate counts as an excluded run.
    expect(stepRun('Run the propose → benchmark → gate loop')).toContain('--workers "${WORKERS}"');
    expect(evolveJob?.env?.WORKERS).toBe(
      "${{ inputs.workers || vars.GITNEXUS_EVOLUTION_WORKERS || '1' }}",
    );
  });

  it('seeds from the newest usable completed main run, including failed runs', () => {
    const seed = stepRun("Seed the proposer with the previous run's evidence");

    // Failed sweeps deliberately upload partial evidence. Looking only at
    // successful runs makes that evidence unreachable and leaves the weekly
    // proposer memoryless once the last successful artifact expires.
    expect(seed).toContain('--status completed');
    expect(seed).not.toContain('--status success');
    expect(seed).toContain('--limit 10');
    expect(seed).toContain('for previous in ${previous_runs}');
    expect(seed).toContain('continue');
    expect(seed).toContain('gen-*/bench/results.jsonl');
    expect(seed).toContain('chmod -R go-rwx');
    expect(seed).toContain('select_evidence(load_jsonl');
    expect(seed).toContain('break');
  });

  it.skipIf(process.platform === 'win32')(
    'falls back past an empty newer artifact to an older usable run',
    () => {
      const result = runSeedStep(`
if [[ "$1 $2" == 'run list' ]]; then
  printf '300\\n200\\n'
  exit 0
fi
if [[ "$1 $2" == 'run download' ]]; then
  run_id="$3"
  shift 3
  destination=''
  while (( $# )); do
    if [[ "$1" == '--dir' ]]; then destination="$2"; shift 2; else shift; fi
  done
  printf '%s\\n' "\${run_id}" >> "\${TRACE}"
  if [[ "\${run_id}" == '300' ]]; then
    mkdir -p "\${destination}/artifact/gen-3/bench"
    printf '%s\\n' '{"error_kind":"session-error","resolved":false}' > "\${destination}/artifact/gen-3/bench/results.jsonl"
  elif [[ "\${run_id}" == '200' ]]; then
    mkdir -p "\${destination}/artifact/gen-2/bench"
    mkdir -p "\${destination}/artifact/gen-2/bench/transcripts"
    printf '%s\\n' '{"task":"demo","arm":"workflow","run":0,"resolved":false,"error_kind":"oracle-failed","transcript_artifacts":[{"path":"transcripts/session.jsonl","sha256":"ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356","bytes":3,"source":"parent-captured-stream-json"}]}' > "\${destination}/artifact/gen-2/bench/results.jsonl"
    printf '{}\\n' > "\${destination}/artifact/gen-2/bench/transcripts/session.jsonl"
    chmod 0755 "\${destination}/artifact/gen-2/bench/transcripts"
    chmod 0644 "\${destination}/artifact/gen-2/bench/transcripts/session.jsonl"
  fi
  exit 0
fi
exit 1`);

      expect(result.trace).toBe('300\n200\n');
      expect(result.output).toMatch(/seed=.*\/200\/artifact\/gen-2\/bench\n/);
      expect(result.transcriptDirectoryMode).toBe(0o700);
      expect(result.transcriptMode).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'continues without a seed when every prior artifact is unavailable',
    () => {
      const result = runSeedStep(`
if [[ "$1 $2" == 'run list' ]]; then
  printf '300\\n'
  exit 0
fi
if [[ "$1 $2" == 'run download' ]]; then
  printf '%s\\n' "$3" >> "\${TRACE}"
  exit 1
fi
exit 1`);

      expect(result.trace).toBe('300\n');
      expect(result.output).toBe('');
    },
  );

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

  it('installs node_modules for the monorepo root, gitnexus-shared, and gitnexus', () => {
    // The benchmark sandbox-copies node_modules from all three (tasks.scenarios.yaml).
    // The root tree was absent on the first real run because only the two subpackage
    // steps ran, so capture_task_dependency_binding aborted at task binding.
    const rootStep = findStep('Install monorepo root dependencies');
    expect(rootStep).toBeDefined();
    expect(rootStep).not.toHaveProperty('working-directory'); // installs at the repo root
    expect(String(rootStep?.run)).toContain('npm ci');
    expect(stepRun('Build pinned shared runtime')).toContain('npm ci');
    expect(stepRun('Install and build pinned GitNexus runtime')).toContain('npm ci');
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
    const mint = findStep('Mint GitHub App token');
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

  it('kills the benchmark with job time left to upload its evidence', () => {
    // A job-level timeout cancels the job outright, so the upload step never
    // runs and a multi-hour generation's evidence is lost. The sweep therefore
    // needs its own, strictly shorter budget: a step timeout only fails that
    // step, and the always() upload below still ships what it wrote.
    const jobBudget = evolveJob?.['timeout-minutes'];
    const loopStep = findStep('Run the propose → benchmark → gate loop');
    const stepBudget = loopStep?.['timeout-minutes'];
    expect(typeof jobBudget).toBe('number');
    expect(typeof stepBudget).toBe('number');
    expect(stepBudget as number).toBeLessThan(jobBudget as number);
    // The runner is an EC2 box an EventBridge schedule stops 24h after it
    // starts; when the box goes the runner vanishes mid-step and nothing
    // uploads. The job must finish inside that window even when the schedule
    // fires late (the 2026-08-01 run was queued 65 minutes after the cron).
    expect(jobBudget as number).toBeLessThanOrEqual(21 * 60);
  });

  it('uploads benchmark evidence unconditionally, on a path it addresses itself', () => {
    const upload = findStep('Upload benchmark evidence');
    // The sweep appends results.jsonl and transcripts as it goes, so a killed
    // generation still holds the evidence explaining why — and a path taken
    // from the killed step's outputs is exactly what would not be there.
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path).toBe('${{ runner.temp }}/wfevolve');
  });

  it('documents the App secrets and protected Environment on the activation checklist', () => {
    expect(workflow).toContain('RELEASE_APP_ID');
    expect(workflow).toContain('RELEASE_APP_PRIVATE_KEY');
    expect(workflow).toContain('gitnexus-evolution');
    expect(workflow).toContain('[x] Set the repository variable GITNEXUS_EVOLUTION_ENABLED=true');
    expect(workflow).toContain('GITNEXUS_EVOLUTION_WORKERS');
  });
});
