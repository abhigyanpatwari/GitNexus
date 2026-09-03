import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW_PATH = path.resolve(REPO_ROOT, '.github/workflows/gitnexus-skill-evolution.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const workflowDocument = load(workflow) as {
  jobs?: Record<
    string,
    {
      environment?: unknown;
      env?: Record<string, string>;
      if?: unknown;
      'timeout-minutes'?: unknown;
      steps?: Array<{
        name?: string;
        if?: unknown;
        run?: unknown;
        uses?: string;
        'timeout-minutes'?: unknown;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
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

// The seed step's usability check is the proposer's OWN preflight
// (select_evidence + proposer_evidence_entries), invoked through uv. Stubbing
// uv would make these tests assert nothing about it: a stub accepts whatever
// fixture it is handed, so a fixture with a wrong digest, a wrong byte count,
// or world-readable transcripts would "pass" a check that rejects it in
// production — exactly backwards for a test whose subject is that rejection.
// So run the real thing, and skip rather than pretend when the eval project's
// environment is not provisioned (the node-only CI test jobs do not set up
// uv; `eval-tests` and this workflow's own runner do). UV_OFFLINE keeps the
// probe and the step itself from ever reaching the network mid-test.
const REAL_PREFLIGHT_AVAILABLE =
  process.platform !== 'win32' &&
  (() => {
    try {
      execFileSync(
        'uv',
        [
          'run',
          '--project',
          'eval',
          '--locked',
          '--extra',
          'dev',
          '--offline',
          'python',
          '-c',
          'import workflow_bench.evolve',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  })();

// Provisioning uv is not free, and neither is the first `uv run` in a cold
// project, so give the two tests that shell out to it real headroom.
const PREFLIGHT_TEST_TIMEOUT_MS = 120_000;

// sha256 of the 3-byte transcript body the fixture writes. evolve.py re-hashes
// the file on disk and compares it against the results row, so this pair has
// to be genuinely consistent — and the wrong-but-well-formed digest below has
// to be 64 hex characters, or it would be rejected as malformed metadata
// before anything is ever hashed.
const TRANSCRIPT_DIGEST = 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356';
const WRONG_TRANSCRIPT_DIGEST = '0'.repeat(64);

/** Bash that materializes one downloaded evidence artifact under `destination`. */
function artifactFixture({ generation, digest }: { generation: number; digest: string }): string {
  const bench = `\${destination}/artifact/gen-${generation}/bench`;
  const row = JSON.stringify({
    task: 'demo',
    arm: 'workflow',
    run: 0,
    resolved: false,
    // A measured outcome, not a harness death: select_evidence keeps this and
    // drops session-error/infra-error rows.
    error_kind: 'oracle-failed',
    transcript_artifacts: [
      {
        path: 'transcripts/session.jsonl',
        sha256: digest,
        bytes: 3,
        source: 'parent-captured-stream-json',
      },
    ],
  });
  return `    mkdir -p "${bench}/transcripts"
    printf '%s\\n' '${row}' > "${bench}/results.jsonl"
    printf '{}\\n' > "${bench}/transcripts/session.jsonl"
    # upload-artifact normalizes to 0755/0644 on the way out; the step's
    # chmod -R go-rwx is what has to restore the owner-only modes the real
    # transcript reader requires, so hand it the un-restored modes.
    chmod 0755 "${bench}/transcripts"
    chmod 0644 "${bench}/transcripts/session.jsonl"`;
}

function runSeedStep(ghImplementation: string): {
  output: string;
  trace: string;
  transcriptDirectoryMode?: number;
  transcriptMode?: number;
} {
  // realpath: _real_results_root() in evolve.py rejects a results directory
  // whose path traverses a symlink, and macOS hands out $TMPDIR under one.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gitnexus-evolution-seed-')));
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

    // Only `gh` is stubbed — it is the step's input (which runs exist, what
    // their artifacts contain). `uv` is deliberately NOT on the stub PATH, so
    // the usability check below resolves the real uv and runs the real
    // preflight against these fixtures. cwd is the repo root because that is
    // where the workflow runs the step from, and `--project eval` is relative
    // to it.
    execFileSync(
      '/bin/bash',
      ['-c', stepRun("Seed the proposer with the previous run's evidence")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: githubOutput,
          GITHUB_REPOSITORY: 'abhigyanpatwari/GitNexus',
          GITHUB_RUN_ID: '999',
          RUNNER_TEMP: runnerTemp,
          TRACE: trace,
          UV_OFFLINE: '1',
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
    expect(loop).toContain('./workflow_bench/run-evolution.sh --apply');
    expect(loop).not.toContain('python -m workflow_bench.evolve');
  });

  it('passes the cell concurrency through to the benchmark', () => {
    // The lane is serial unless told otherwise: concurrency only pays off when
    // the runner has the vCPUs for it, and a cell starved of CPU drifts toward
    // its session timeout, which the gate counts as an excluded run.
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
    // The usability check must stay the proposer's own preflight. Narrowing it
    // to "the file has rows" would re-admit artifacts whose transcripts the
    // proposer then refuses to read, costing the generation its evidence.
    expect(seed).toContain('stage_proposer_evidence_bundle');
    expect(seed).toContain('break');
  });

  it('lets a dispatch start from a blank slate while the schedule always seeds', () => {
    // Evidence from a run whose harness leaked the hidden oracles cannot be
    // trusted, and the staged prior proposal is what carries that taint into
    // every later generation. Without an opt-out the only remedy is waiting
    // for the tainted artifact to expire.
    const triggers = (workflowDocument as { on?: Record<string, unknown> }).on;
    const inputs = (triggers?.workflow_dispatch as { inputs?: Record<string, unknown> } | undefined)
      ?.inputs;
    const input = inputs?.seed_from_previous as { type?: string; default?: unknown } | undefined;
    expect(input?.type).toBe('boolean');
    expect(input?.default).toBe(true);

    const condition = findStep("Seed the proposer with the previous run's evidence")?.if;
    expect(condition).toContain("github.event_name != 'workflow_dispatch'");
    expect(condition).toContain('inputs.seed_from_previous');
  });

  it('bounds the best-effort seed walk well inside the job budget', () => {
    // Every iteration blocks on a network download this job does not control,
    // and the job-level timeout CANCELS rather than fails — which skips the
    // `if: always()` upload and loses the sweep's evidence. So the walk needs
    // its own budget: long enough to never trip on a healthy run, short
    // enough that a wedged download is a fast, obvious failure.
    const seedBudget = findStep("Seed the proposer with the previous run's evidence")?.[
      'timeout-minutes'
    ];
    expect(typeof seedBudget).toBe('number');
    expect(seedBudget as number).toBeGreaterThanOrEqual(10);
    expect(seedBudget as number).toBeLessThanOrEqual(30);
    expect(seedBudget as number).toBeLessThan(evolveJob?.['timeout-minutes'] as number);
  });

  it.skipIf(!REAL_PREFLIGHT_AVAILABLE)(
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
${artifactFixture({ generation: 2, digest: TRANSCRIPT_DIGEST })}
  fi
  exit 0
fi
exit 1`);

      // select_evidence drops session-error rows as unattributable, leaving
      // gen-3 with nothing to propose from.
      expect(result.trace).toBe('300\n200\n');
      expect(result.output).toMatch(/seed=.*\/200\/artifact\/gen-2\/bench\n/);
      expect(result.transcriptDirectoryMode).toBe(0o700);
      expect(result.transcriptMode).toBe(0o600);
    },
    PREFLIGHT_TEST_TIMEOUT_MS,
  );

  it.skipIf(!REAL_PREFLIGHT_AVAILABLE)(
    'falls back past a newer artifact whose transcript digest does not match',
    () => {
      // The sharp edge of running the real preflight: this artifact is
      // non-empty and structurally well-formed, so every cheap check passes
      // it. Only hashing the transcript and comparing against the row the
      // proposer would trust rejects it — which is the whole reason the step
      // shells out to the proposer's own code instead of grepping the JSONL.
      const result = runSeedStep(`
if [[ "$1 $2" == 'run list' ]]; then
  printf '400\\n200\\n'
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
  if [[ "\${run_id}" == '400' ]]; then
${artifactFixture({ generation: 4, digest: WRONG_TRANSCRIPT_DIGEST })}
  elif [[ "\${run_id}" == '200' ]]; then
${artifactFixture({ generation: 2, digest: TRANSCRIPT_DIGEST })}
  fi
  exit 0
fi
exit 1`);

      expect(result.trace).toBe('400\n200\n');
      expect(result.output).toMatch(/seed=.*\/200\/artifact\/gen-2\/bench\n/);
    },
    PREFLIGHT_TEST_TIMEOUT_MS,
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

  it('accepts an OpenAI key as an alternative to the Anthropic token', () => {
    const requireAuth = stepRun('Require the benchmark auth secret');
    expect(requireAuth).toContain('HAS_ANTHROPIC');
    expect(requireAuth).toContain('GITNEXUS_BENCH_ANTHROPIC_API_KEY');
    expect(requireAuth).toContain('GITNEXUS_BENCH_OPENAI_API_KEY');
    expect(requireAuth).toContain('provider=openai');
    expect(evolveJob?.env?.PROVIDER).toBe("${{ inputs.provider || 'openai' }}");
    const loop = findStep('Run the propose → benchmark → gate loop');
    expect(loop?.env).toMatchObject({
      GITNEXUS_BENCH_ANTHROPIC_API_KEY:
        '${{ secrets.GITNEXUS_BENCH_ANTHROPIC_API_KEY || secrets.GITNEXUS_BENCH_AUTH_TOKEN }}',
      GITNEXUS_BENCH_OPENAI_API_KEY: '${{ secrets.GITNEXUS_BENCH_OPENAI_API_KEY }}',
    });
  });

  it('runs the proposer on its own model, separate from the benchmark arms', () => {
    expect(evolveJob?.env?.MODEL).toBe("${{ inputs.model || 'gpt-5.6-sol' }}");
    expect(evolveJob?.env?.PROPOSER_MODEL).toBe("${{ inputs.proposer_model || 'gpt-5.6-sol' }}");
    expect(evolveJob?.env?.EFFORT).toBe("${{ inputs.effort || 'xhigh' }}");
  });

  it('provisions the benchmark task repo at ~/GitNexus before the loop', () => {
    const provision = stepRun('Point the benchmark task repo at the checkout');
    expect(provision).toContain('[[ -e "${HOME}/GitNexus" && ! -L "${HOME}/GitNexus" ]]');
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

  it('waits for the runner boot-time package lock before installing containment tools', () => {
    const install = stepRun('Install sandbox runtime and pinned Claude CLI');
    expect(install).toContain('DPkg::Lock::Timeout=600 update');
    expect(install).toContain('DPkg::Lock::Timeout=600 install');
    expect(install).toContain('ripgrep');
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

  it('keeps scheduled runs off until the three-worker proof is explicitly enabled', () => {
    const condition = String(evolveJob?.if);
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("vars.GITNEXUS_EVOLUTION_ENABLED == 'true'");
    expect(condition).toContain("vars.GITNEXUS_EVOLUTION_WORKERS == '3'");
  });

  it('fails before paid work when runner survival protections are ineffective', () => {
    const preflight = stepRun('Verify runner survival policy');
    expect(preflight).toContain('/etc/needrestart/conf.d/90-gitnexus-evolution.conf');
    expect(preflight).toContain("$nrconf{restart} = 'l';");
    expect(preflight).toContain('/proc/self/oom_score_adj');
    expect(preflight).toContain('oom_score_adjustment > -900');
    expect(preflight).toContain('SECONDS + 5');
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
    expect(workflow).toContain('GITNEXUS_EVOLUTION_ENABLED=true for scheduled runs');
    expect(workflow).toContain('GITNEXUS_EVOLUTION_WORKERS');
  });
});
