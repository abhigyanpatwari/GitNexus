import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identity gate for commit-fork-prebuilds.yml and pr-autofix-publish.yml.
 * The production failure on fork PR #3179 was: workflow_run.pull_requests[]
 * is empty (GitHub design) and GET /repos/{base}/commits/{sha}/pulls is also
 * empty (fork commit is not in the base graph). The verifier must use
 * pulls?head=owner:branch and must not treat a gh failure as "no PR".
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.github/scripts/verify-workflow-run-pr-identity.cjs',
);
const WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows/commit-fork-prebuilds.yml',
);
const AUTOFIX_WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows/pr-autofix-publish.yml',
);
const AUTOFIX_SCHEMA = /^gitnexus\.pr-autofix\/v[0-9]+$/;

const mod = requireCjs(SCRIPT) as {
  allowlistField: (key: string, value: unknown, pattern: RegExp) => string;
  headRepoOwner: (headRepo: string) => string;
  resolveVerifiedPullRequest: (input: {
    meta: unknown;
    authority: {
      head_sha: string;
      head_repo: string;
      head_branch: string;
      base_repo: string;
    };
    pulls: unknown;
    schemaPattern?: RegExp;
  }) => {
    pr_number: string;
    head_ref: string;
    head_sha: string;
    head_repo: string;
    current_head_sha: string;
    branch_moved: boolean;
  };
  listOpenPullsByHead: (input: {
    ghRepo: string;
    headOwner: string;
    headBranch: string;
    runGh: (args: string[]) => { status: number; stdout?: string; stderr?: string };
  }) => unknown[];
  IDENTITY_PATTERNS: { pr_number: RegExp; head_sha: RegExp; head_ref: RegExp; repo: RegExp };
};

const SHA = 'ee08b034ea90943e8b037c6224f1e0de41a65613';
const MOVED = '8a33525d9bb8617dfb08d426d4b2834581e1277a';

const META = {
  schema: 'gitnexus.ts-prebuild/v1',
  pr_number: 3179,
  head_sha: SHA,
  head_ref: 'objective-c_support',
  head_repo: 'mengkaka/GitNexus',
  base_repo: 'abhigyanpatwari/GitNexus',
};

const AUTHORITY = {
  head_sha: SHA,
  head_repo: 'mengkaka/GitNexus',
  head_branch: 'objective-c_support',
  base_repo: 'abhigyanpatwari/GitNexus',
};

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 3179,
    state: 'open',
    head: {
      sha: SHA,
      ref: 'objective-c_support',
      repo: { full_name: 'mengkaka/GitNexus' },
    },
    base: { repo: { full_name: 'abhigyanpatwari/GitNexus' } },
    ...overrides,
  };
}

describe('allowlistField', () => {
  it('rejects a newline that would inject a second GITHUB_OUTPUT line', () => {
    expect(() =>
      mod.allowlistField('head_ref', 'main\npr_number=1', mod.IDENTITY_PATTERNS.head_ref),
    ).toThrow(/failed allowlist/);
  });

  it('accepts a slashy branch name', () => {
    expect(mod.allowlistField('head_ref', 'feat/objc', mod.IDENTITY_PATTERNS.head_ref)).toBe(
      'feat/objc',
    );
  });
});

describe('headRepoOwner', () => {
  it('takes the owner from owner/name', () => {
    expect(mod.headRepoOwner('mengkaka/GitNexus')).toBe('mengkaka');
  });

  it('rejects a bare owner', () => {
    expect(() => mod.headRepoOwner('mengkaka')).toThrow(/owner\/name/);
  });
});

describe('resolveVerifiedPullRequest', () => {
  it('accepts the #3179 production shape even when the PR tip has moved', () => {
    const verified = mod.resolveVerifiedPullRequest({
      meta: META,
      authority: AUTHORITY,
      pulls: [
        pull({
          head: {
            sha: MOVED,
            ref: 'objective-c_support',
            repo: { full_name: 'mengkaka/GitNexus' },
          },
        }),
      ],
    });
    expect(verified).toEqual({
      pr_number: '3179',
      head_ref: 'objective-c_support',
      head_sha: SHA,
      head_repo: 'mengkaka/GitNexus',
      current_head_sha: MOVED,
      branch_moved: true,
    });
  });

  it('refuses an empty pulls list — the commits/{sha}/pulls miss', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({ meta: META, authority: AUTHORITY, pulls: [] }),
    ).toThrow(/No open PR from mengkaka\/GitNexus:objective-c_support/);
  });

  it('refuses a forged pr_number that is not the fork-head PR', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, pr_number: 1 },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/Artifact pr_number \(1\)/);
  });

  it('refuses a head_sha that does not match workflow_run', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, head_sha: MOVED },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/head_sha/);
  });

  it('refuses a head_repo that does not match workflow_run', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, head_repo: 'evil/GitNexus' },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/head_repo/);
  });

  it('refuses a head_ref that does not match workflow_run.head_branch', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, head_ref: 'other-branch' },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/head_ref/);
  });

  it('refuses a base_repo that does not match $GITHUB_REPOSITORY', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, base_repo: 'evil/upstream' },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/base_repo does not match/);
  });

  it('refuses two open PRs that share the same fork head', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: META,
        authority: AUTHORITY,
        pulls: [
          pull(),
          pull({
            number: 4000,
            base: { repo: { full_name: 'abhigyanpatwari/GitNexus' }, ref: 'release' },
          }),
        ],
      }),
    ).toThrow(/Ambiguous open PRs/);
  });

  it('refuses a closed PR for the same fork head', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: META,
        authority: AUTHORITY,
        pulls: [pull({ state: 'closed' })],
      }),
    ).toThrow(/No open PR/);
  });

  it('accepts gitnexus.pr-autofix metadata when SCHEMA_PATTERN is the autofix schema', () => {
    const verified = mod.resolveVerifiedPullRequest({
      meta: { ...META, schema: 'gitnexus.pr-autofix/v1', changed_lines: 12 },
      authority: AUTHORITY,
      pulls: [pull()],
      schemaPattern: AUTOFIX_SCHEMA,
    });
    expect(verified.pr_number).toBe('3179');
  });

  it('rejects an autofix schema against the default prebuild allowlist', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: { ...META, schema: 'gitnexus.pr-autofix/v1' },
        authority: AUTHORITY,
        pulls: [pull()],
      }),
    ).toThrow(/metadata.schema failed allowlist/);
  });

  it('ignores a PR from the same owner that targets a different branch', () => {
    expect(() =>
      mod.resolveVerifiedPullRequest({
        meta: META,
        authority: AUTHORITY,
        pulls: [
          pull({
            number: 9,
            head: { sha: SHA, ref: 'unrelated', repo: { full_name: 'mengkaka/GitNexus' } },
          }),
        ],
      }),
    ).toThrow(/No open PR/);
  });
});

describe('listOpenPullsByHead', () => {
  it('calls gh with state=open and head=owner:branch', () => {
    let seen: string[] = [];
    const pulls = [pull()];
    const listed = mod.listOpenPullsByHead({
      ghRepo: 'abhigyanpatwari/GitNexus',
      headOwner: 'mengkaka',
      headBranch: 'objective-c_support',
      runGh: (args) => {
        seen = args;
        return { status: 0, stdout: JSON.stringify(pulls) };
      },
    });
    expect(seen).toEqual([
      'api',
      '--paginate',
      '--slurp',
      '-X',
      'GET',
      'repos/abhigyanpatwari/GitNexus/pulls',
      '-f',
      'state=open',
      '-f',
      'head=mengkaka:objective-c_support',
    ]);
    expect(listed).toEqual(pulls);
  });

  it('flattens gh --paginate --slurp page arrays', () => {
    const page1 = [pull()];
    const page2 = [
      pull({
        number: 4000,
        head: {
          sha: SHA,
          ref: 'other',
          repo: { full_name: 'mengkaka/GitNexus' },
        },
      }),
    ];
    const listed = mod.listOpenPullsByHead({
      ghRepo: 'abhigyanpatwari/GitNexus',
      headOwner: 'mengkaka',
      headBranch: 'objective-c_support',
      runGh: () => ({ status: 0, stdout: JSON.stringify([page1, page2]) }),
    });
    expect(listed).toEqual([...page1, ...page2]);
  });

  it('throws on an empty body', () => {
    expect(() =>
      mod.listOpenPullsByHead({
        ghRepo: 'abhigyanpatwari/GitNexus',
        headOwner: 'mengkaka',
        headBranch: 'objective-c_support',
        runGh: () => ({ status: 0, stdout: '' }),
      }),
    ).toThrow(/empty body/);
  });

  it('throws on a non-JSON success body', () => {
    expect(() =>
      mod.listOpenPullsByHead({
        ghRepo: 'abhigyanpatwari/GitNexus',
        headOwner: 'mengkaka',
        headBranch: 'objective-c_support',
        runGh: () => ({ status: 0, stdout: 'not-json' }),
      }),
    ).toThrow(/non-JSON/);
  });

  it('throws on a gh failure instead of pretending there is no PR', () => {
    expect(() =>
      mod.listOpenPullsByHead({
        ghRepo: 'abhigyanpatwari/GitNexus',
        headOwner: 'mengkaka',
        headBranch: 'objective-c_support',
        runGh: () => ({ status: 1, stderr: 'HTTP 404' }),
      }),
    ).toThrow(/pulls\?head= lookup failed: HTTP 404/);
  });

  it('throws on a non-array success body', () => {
    expect(() =>
      mod.listOpenPullsByHead({
        ghRepo: 'abhigyanpatwari/GitNexus',
        headOwner: 'mengkaka',
        headBranch: 'objective-c_support',
        runGh: () => ({ status: 0, stdout: '{"message":"Not Found"}' }),
      }),
    ).toThrow(/non-array/);
  });
});

function assertIdentityVerifierContract(workflow: string) {
  expect(workflow).toContain('.github/scripts/verify-workflow-run-pr-identity.cjs');
  expect(workflow).toContain('github.event.workflow_run.head_branch');
  expect(workflow).toContain('WF_HEAD_BRANCH');
  expect(workflow).not.toMatch(/gh api .*commits\/[^/\s]+\/pulls/);
}

describe('commit-fork-prebuilds.yml contract', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('runs the tested verifier and keys the fork lookup on workflow_run.head_branch', () => {
    assertIdentityVerifierContract(workflow);
  });

  it('does not checkout, place, or push unless identity verify succeeded', () => {
    expect(workflow).toContain('steps.verify.outputs.head_repo');
    expect(workflow).toContain('steps.verify.outputs.head_sha');
    expect(workflow).toContain('steps.verify.outputs.pr_number');
    for (const step of [
      'Checkout fork PR head',
      'Place prebuilds into the fork checkout',
      'Commit and push to the fork branch',
    ]) {
      const chunk = workflow.split(`- name: ${step}`)[1]?.split('- name:')[0] ?? '';
      expect(chunk, step).toMatch(/steps\.verify\.outcome == 'success'/);
    }
  });
});

describe('pr-autofix-publish.yml contract', () => {
  const workflow = readFileSync(AUTOFIX_WORKFLOW, 'utf8');

  it('runs the tested verifier and keys the lookup on workflow_run.head_branch', () => {
    assertIdentityVerifierContract(workflow);
    expect(workflow).toContain('gitnexus\\.pr-autofix');
  });

  it('does not post sticky comments or check runs unless identity verify succeeded', () => {
    expect(workflow).toMatch(/steps\.verify\.outcome == 'success'/);
    expect(workflow).toContain('steps.verify.outputs.pr_number');
    expect(workflow).toContain('steps.verify.outputs.head_sha');
  });
});
