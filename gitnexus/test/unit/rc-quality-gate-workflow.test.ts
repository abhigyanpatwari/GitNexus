import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string[];
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  with?: Record<string, string>;
  secrets?: unknown;
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  steps?: Step[];
}

const source = readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/publish.yml'),
  'utf8',
);
const jobs = (load(source) as { jobs: Record<string, Job> }).jobs;
const preparation = jobs['prepare-rc'];
const evaluation = jobs['rc-evaluation'];
const publish = jobs.publish;
const steps = publish.steps ?? [];
const step = (name: string) => {
  const found = steps.find((item) => item.name === name);
  if (!found) throw new Error(`Missing publish step: ${name}`);
  return found;
};

function checkReceipt({
  overrides = {},
  stableTag = 'v1.0.0',
  stableSha = 'c'.repeat(40),
  failure = '',
}: {
  overrides?: Record<string, unknown>;
  stableTag?: string;
  stableSha?: string;
  failure?: string;
} = {}) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'rc-quality-receipt-'));
  try {
    mkdirSync(path.join(fixture, 'release-evidence'));
    writeFileSync(
      path.join(fixture, 'release-evidence/release-quality-gate.json'),
      JSON.stringify({
        schema: 'gitnexus.release-quality-gate/v1',
        candidate_sha: 'a'.repeat(40),
        stable_sha: 'c'.repeat(40),
        passed: true,
        ...overrides,
      }),
    );
    const fakeGh = path.join(fixture, 'fake-gh.cjs');
    const callsPath = path.join(fixture, 'calls.json');
    writeFileSync(callsPath, '[]');
    // Run the actual receipt code, replacing just gh's external API responses.
    // syncBuiltinESMExports exposes the fake to its named ESM import on all OSes.
    writeFileSync(
      fakeGh,
      `const fs = require('node:fs');
       require('node:child_process').execFileSync = (command, args) => {
         const calls = JSON.parse(fs.readFileSync(${JSON.stringify(callsPath)}, 'utf8'));
         calls.push([command, ...args]);
         fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
         if (command !== 'gh' || args[0] !== 'api') throw new Error('Unexpected external command');
         const endpoint = args[1];
         if (${JSON.stringify(failure)} && endpoint.includes(${JSON.stringify(failure)})) throw new Error('API unavailable');
         if (endpoint.endsWith('/releases/latest')) return ${JSON.stringify(stableTag)};
         if (endpoint.includes('/commits/')) return ${JSON.stringify(stableSha)};
         throw new Error('Unexpected API endpoint');
       };
       require('node:module').syncBuiltinESMExports();`,
    );
    const script = step('Verify the RC quality gate receipt')
      .run?.split("<<'NODE'\n")[1]
      .split('\nNODE')[0];
    if (!script) throw new Error('Missing RC quality receipt validation script');
    const result = spawnSync(
      process.execPath,
      ['--require', fakeGh, '--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: fixture,
          HEAD_SHA: 'a'.repeat(40),
          GITHUB_REPOSITORY: 'abhigyanpatwari/GitNexus',
        },
        encoding: 'utf8',
      },
    );
    return { accepted: result.status === 0, calls: JSON.parse(readFileSync(callsPath, 'utf8')) };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

// Exercise the actual Actions expression for every terminal dependency result.
// Bracket conversion handles Actions' hyphenated job identifiers in JavaScript.
function permitsPublication({
  mode = 'rc',
  result = 'success',
  prepare = 'success',
  ci = 'success',
  guarded = 'true',
  cancelled = false,
}: {
  mode?: string;
  result?: string;
  prepare?: string;
  ci?: string;
  guarded?: string;
  cancelled?: boolean;
} = {}) {
  const expression = String(publish.if)
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  const evaluate = new Function('needs', 'always', 'cancelled', `return (${expression});`);
  return evaluate(
    {
      route: { result: 'success', outputs: { mode } },
      'rc-guard': { outputs: { should_run: guarded } },
      ci: { result: ci },
      'prepare-rc': { result: prepare },
      'rc-evaluation': { result },
    },
    () => true,
    () => cancelled,
  );
}

describe('RC publication quality gate', () => {
  it('evaluates every prepared RC before the only publishing job starts', () => {
    expect(preparation.needs).toEqual(['route', 'rc-guard', 'ci']);
    expect(evaluation.needs).toEqual(['route', 'rc-guard', 'ci', 'prepare-rc']);
    expect(evaluation.uses).toBe('./.github/workflows/release-evaluation.yml');
    expect(evaluation.with).toEqual({
      candidate_sha: '${{ needs.prepare-rc.outputs.candidate_sha }}',
      candidate_artifact: '${{ needs.prepare-rc.outputs.artifact_name }}',
    });
    expect(publish.needs).toContain('rc-evaluation');
    expect(permitsPublication()).toBe(true);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'blocks RC publication for gate result %j',
    (result) => {
      expect(permitsPublication({ result })).toBe(false);
      expect(permitsPublication({ prepare: result })).toBe(false);
    },
  );

  it('keeps stable publishing available when RC-only jobs are skipped', () => {
    expect(permitsPublication({ mode: 'stable', prepare: 'skipped', result: 'skipped' })).toBe(
      true,
    );
    expect(step('Require paired agent evidence for this stable commit').if).toBe(
      "needs.route.outputs.mode == 'stable'",
    );
  });

  it('preserves CI, marker dedup and cancellation as independent blockers', () => {
    expect(permitsPublication({ ci: 'failure' })).toBe(false);
    expect(permitsPublication({ mode: 'stable', ci: 'failure' })).toBe(false);
    expect(permitsPublication({ guarded: 'false' })).toBe(false);
    expect(permitsPublication({ cancelled: true })).toBe(false);
  });

  it('prepares a detached bundle without pushing a tag or marker', () => {
    const commands = (preparation.steps ?? []).map((item) => item.run ?? '').join('\n');
    expect(commands).toContain('git checkout --detach "$HEAD_SHA"');
    expect(commands).toContain('git commit -m "release: ${VTAG}"');
    expect(commands).toContain('release_candidate.py create');
    expect(commands).not.toMatch(/git\s+(?:push|tag)\b/);
    expect(commands).not.toMatch(/npm publish/);
    const checkout = preparation.steps?.find((item) => item.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ needs.rc-guard.outputs.head_sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('restores and checks the evaluated commit before building and tagging it', () => {
    const restore = step('Restore the evaluated RC commit');
    expect(restore.env?.HEAD_SHA).toBe('${{ needs.prepare-rc.outputs.candidate_sha }}');
    expect(restore.run).toContain('--source-sha "$BEFORE_SHA" --candidate-sha "$HEAD_SHA"');
    expect(steps.indexOf(restore)).toBeLessThan(
      steps.indexOf(step('Install gitnexus dependencies')),
    );
    const push = step('Create and push rc tags');
    expect(push.run).toContain('[ "$RELEASE_SHA" != "$BEFORE_SHA" ]');
    expect(push.run).toContain('git diff --exit-code');
    expect(push.run).toContain('git tag -a "$VTAG" "$RELEASE_SHA"');
    expect(push.run).toContain('push --atomic origin');
    expect(push.run).not.toContain('git commit');
    expect(steps.some((item) => item.run?.includes('npm version'))).toBe(false);
  });

  it('consumes only current-run candidate and quality evidence before remote writes', () => {
    const candidate = step('Download the evaluated RC candidate');
    const evidence = step("Download this RC's paired non-regression evidence");
    expect(candidate.with?.name).toBe('${{ needs.prepare-rc.outputs.artifact_name }}');
    expect(evidence.with?.name).toBe(
      'release-agent-evaluation-${{ needs.prepare-rc.outputs.candidate_sha }}',
    );
    for (const download of [candidate, evidence]) {
      expect(download.with?.['run-id']).toBeUndefined();
      expect(download.with?.repository).toBeUndefined();
    }
    expect(steps.indexOf(evidence)).toBeLessThan(steps.indexOf(step('Create and push rc tags')));
    expect(steps.indexOf(step('Verify the RC quality gate receipt'))).toBeLessThan(
      steps.indexOf(step('Create and push rc tags')),
    );
    expect(step('Append measured release evidence').run).toContain('release-quality-gate.md');
  });

  it.each([
    [{}, true],
    [{ passed: false }, false],
    [{ passed: 'true' }, false],
    [{ schema: 'unknown' }, false],
    [{ candidate_sha: 'b'.repeat(40) }, false],
  ])('validates the current-run receipt before publication: %j', (overrides, accepted) => {
    expect(checkReceipt({ overrides }).accepted).toBe(accepted);
  });

  it('serializes only publication across stable and RC, through GitHub Release creation', () => {
    expect(publish.concurrency).toEqual({
      group: 'gitnexus-release-publication',
      'cancel-in-progress': false,
    });
    expect(preparation.concurrency).toBeUndefined();
    expect(evaluation.concurrency).toBeUndefined();
    expect(step('Create GitHub Release')).toBeDefined();
  });

  it('accepts an unchanged stable and dereferences its tag with the commits API', () => {
    expect(checkReceipt()).toEqual({
      accepted: true,
      calls: [
        ['gh', 'api', 'repos/abhigyanpatwari/GitNexus/releases/latest', '--jq', '.tag_name'],
        ['gh', 'api', 'repos/abhigyanpatwari/GitNexus/commits/v1.0.0', '--jq', '.sha'],
      ],
    });
    expect(step('Verify the RC quality gate receipt').env?.GH_TOKEN).toBe('${{ github.token }}');
  });

  it('rejects a stable release that advanced after candidate evaluation', () => {
    expect(checkReceipt({ stableTag: 'v1.0.1', stableSha: 'd'.repeat(40) }).accepted).toBe(false);
  });

  it.each(['main', 'v1.0.0-rc.2', '', 'null'])(
    'rejects an invalid current stable tag %j',
    (stableTag) => {
      const result = checkReceipt({ stableTag });
      expect(result.accepted).toBe(false);
      expect(result.calls).toHaveLength(1);
    },
  );

  it.each(['releases/latest', 'commits/'])('fails closed on API error at %j', (failure) => {
    expect(checkReceipt({ failure }).accepted).toBe(false);
  });

  it('rejects malformed resolved commits even when the receipt matches', () => {
    expect(
      checkReceipt({ stableSha: 'invalid', overrides: { stable_sha: 'invalid' } }).accepted,
    ).toBe(false);
  });

  it('keeps write credentials out of evaluation and mints a fresh publisher token', () => {
    expect(preparation.permissions).toEqual({ contents: 'read' });
    const identity = preparation.steps?.find((item) => item.id === 'app-token');
    expect(identity?.with?.['permission-contents']).toBe('read');
    expect(evaluation.secrets).toBeUndefined();
    expect(evaluation.permissions).toEqual({
      contents: 'read',
      actions: 'write',
      'id-token': 'write',
    });
    expect(step('Mint GitHub App token (RC)').uses).toMatch(/^actions\/create-github-app-token@/);
    expect(publish['timeout-minutes']).toBeLessThan(50);
    expect(step('Cleanup pushed tags on partial failure').if).toContain('failure()');
    expect(jobs.docker.needs).toEqual(['route', 'publish']);
  });
});
