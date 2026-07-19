import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLAN_HELPER = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'gitnexus-plan',
  'scripts',
  'evidence-provenance.mjs',
);
const WORK_HELPER = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'gitnexus-work',
  'scripts',
  'evidence-provenance.mjs',
);
const FIXED_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-07-18T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-07-18T00:00:00Z',
};
const GENERATED_PLAN_PATH = 'docs/plans/2026-07-18-gitnexus-plan-evidence-fixture-contract.md';
const NO_EXCLUSION_PLAN_PATH = 'docs/plans/2026-07-18-gitnexus-plan-not-created-plan.md';
const SAFE_PLAN_PATH = 'docs/plans/2026-07-18-gitnexus-plan-safe-writer-contract.md';
const ALTERNATE_SAFE_PLAN_PATH = 'docs/plans/2026-07-18-gitnexus-plan-safe-writer-alternate.md';
const DOCUMENTED_TWO_WORD_PLAN_PATH = 'docs/plans/2026-07-11-gitnexus-plan-ingestion-retry.md';
const LEGACY_PLAN_PATH = 'docs/plans/2026-07-11-001-gitnexus-plan-legacy.md';

type EvidenceHelper = {
  DIRECTORY_LIMITS: { maxEntries: number; maxDepth: number; maxBytes: number };
  serializeDirtyRecords(entries: unknown[]): Buffer;
  snapshotEvidence(input: {
    repo: string;
    generatedPlanPath: string;
    citedPaths: string[];
    testHooks?: {
      afterMaterialize?(): void;
      afterFirstGuardPass?(): void;
      afterAnchorCapture?(anchor: { headCommit: string }): void;
      afterGitLayerLoad?(anchor: { headCommit: string }): void;
      onDirectoryEntry?(entry: { absolute: string; count: number; depth: number }): void;
    };
  }): {
    schema_version: number;
    global_dirty_digest: { canonicalization: string; value: string };
    cited_path_manifest: Array<{
      path: string;
      state: string;
      rename_from: string | null;
      rename_to: string | null;
      object_kind: Record<string, string>;
      head_digest: string;
      index_digest: string;
      worktree_digest: string;
      untracked_digest: string;
    }>;
  };
  readPlanSafely(input: {
    repo: string;
    generatedPlanPath: string;
    testHooks?: {
      afterPlanOpen?(plan: { fd: number; finalPath: string }): void;
    };
  }): {
    generated_plan_path: string;
    bytes_read: number;
    plan_digest: string;
    plan_bytes_base64: string;
  };
  writePlanSafely(input: {
    repo: string;
    generatedPlanPath: string;
    contents: string | Buffer;
    replace?: boolean;
    expectedPlanPath?: string;
    expectedPlanDigest?: string;
    testHooks?: {
      afterParentOpen?(parent: { fd: number; path: string }): void;
      beforeRename?(temp: { fd: number; path: string; tempPath: string }): void;
      beforeBackupMove?(destination: { fd: number; finalPath: string }): void;
      beforePublication?(publication: {
        fd: number;
        finalPath: string;
        tempPath: string;
        replace: boolean;
      }): void;
      afterPublication?(committed: { fd: number; finalPath: string }): void;
      afterRename?(committed: { fd: number; finalPath: string }): void;
      afterFinalOpen?(committed: { fd: number; finalPath: string }): void;
    };
  }): {
    generated_plan_path: string;
    bytes_written: number;
    prior_plan_backup_git_path?: string;
  };
};

function loadedPlanDigest(
  helper: EvidenceHelper,
  repo: string,
  generatedPlanPath = SAFE_PLAN_PATH,
): string {
  return helper.readPlanSafely({ repo, generatedPlanPath }).plan_digest;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: FIXED_GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function artifactPath(repo: string, message: string, role: string): string {
  const match = new RegExp(`(?:^|[ ,])${role}=git-path:(gitnexus-plan-backups/[^,;\\s]+)`).exec(
    message,
  );
  expect(match, `missing ${role} artifact in ${message}`).not.toBeNull();
  const gitPath = match?.[1] as string;
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', gitPath]));
}

function artifactContents(repo: string, message: string, role: string): string {
  return fs.readFileSync(artifactPath(repo, message, role), 'utf8');
}

function createBaseRepo(prefix = 'gitnexus-evidence-v2-'): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.name', 'GitNexus Test']);
  git(repo, ['config', 'user.email', 'gitnexus@example.invalid']);
  write(repo, 'base.txt', 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  return repo;
}

function createFixture(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-evidence-v2-'));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.name', 'GitNexus Test']);
  git(repo, ['config', 'user.email', 'gitnexus@example.invalid']);

  for (const file of ['staged.txt', 'unstaged.txt', 'deleted.txt', 'rename-old.txt', 'mixed.txt']) {
    write(repo, file, `${file}:base\n`);
  }
  fs.symlinkSync('target-a', path.join(repo, 'link'));

  const gitlink = path.join(repo, 'gitlink');
  fs.mkdirSync(gitlink);
  git(gitlink, ['init', '--quiet']);
  git(gitlink, ['config', 'user.name', 'GitNexus Test']);
  git(gitlink, ['config', 'user.email', 'gitnexus@example.invalid']);
  write(gitlink, 'nested.txt', 'nested:base\n');
  git(gitlink, ['add', 'nested.txt']);
  git(gitlink, ['commit', '--quiet', '-m', 'nested base']);

  git(repo, [
    'add',
    'staged.txt',
    'unstaged.txt',
    'deleted.txt',
    'rename-old.txt',
    'mixed.txt',
    'link',
    'gitlink',
  ]);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  write(repo, 'staged.txt', 'staged:index\n');
  git(repo, ['add', 'staged.txt']);
  write(repo, 'unstaged.txt', 'unstaged:worktree\n');
  fs.unlinkSync(path.join(repo, 'deleted.txt'));
  git(repo, ['mv', 'rename-old.txt', 'rename-new.txt']);
  write(repo, 'mixed.txt', 'mixed:index\n');
  git(repo, ['add', 'mixed.txt']);
  write(repo, 'mixed.txt', 'mixed:worktree\n');
  fs.unlinkSync(path.join(repo, 'link'));
  fs.symlinkSync('target-b', path.join(repo, 'link'));
  write(gitlink, 'nested.txt', 'nested:next\n');
  git(gitlink, ['add', 'nested.txt']);
  git(gitlink, ['commit', '--quiet', '-m', 'nested next']);
  git(repo, ['add', 'gitlink']);
  write(repo, 'untracked.txt', 'untracked\n');
  write(repo, GENERATED_PLAN_PATH, 'generated\n');
  write(repo, 'docs/plans/other.md', 'other\n');
  return repo;
}

async function importHelper(file: string): Promise<EvidenceHelper> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as EvidenceHelper;
}

const REAL_GIT_FIXTURES = process.platform === 'win32' ? describe.skip : describe;

REAL_GIT_FIXTURES('evidence provenance v2 helper', () => {
  it('has one golden digest for every dirty state and identical planner/executor bytes', async () => {
    const repo = createFixture();
    try {
      const [planner, executor] = await Promise.all([
        importHelper(PLAN_HELPER),
        importHelper(WORK_HELPER),
      ]);
      const citedPaths = [
        'staged.txt',
        'unstaged.txt',
        'untracked.txt',
        'deleted.txt',
        'rename-new.txt',
        'mixed.txt',
        'link',
        'gitlink',
        'missing.txt',
      ];
      const input = {
        repo,
        generatedPlanPath: GENERATED_PLAN_PATH,
        citedPaths,
      };
      const plannerSnapshot = planner.snapshotEvidence(input);
      const executorSnapshot = executor.snapshotEvidence(input);

      expect(fs.readFileSync(PLAN_HELPER)).toEqual(fs.readFileSync(WORK_HELPER));
      expect(executorSnapshot).toEqual(plannerSnapshot);
      expect(planner.serializeDirtyRecords(plannerSnapshot.cited_path_manifest)).toEqual(
        executor.serializeDirtyRecords(executorSnapshot.cited_path_manifest),
      );
      expect(plannerSnapshot.schema_version).toBe(2);
      expect(plannerSnapshot.global_dirty_digest.canonicalization).toBe(
        'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records',
      );
      expect(plannerSnapshot.global_dirty_digest.value).toBe(
        '2775ad955f97aa1f454b0ff7591890d589ad7a898ec3ba52c63c243a6b111dad',
      );

      const byPath = new Map(
        plannerSnapshot.cited_path_manifest.map((entry) => [entry.path, entry]),
      );
      expect(byPath.get('staged.txt')?.state).toBe('staged');
      expect(byPath.get('unstaged.txt')?.state).toBe('unstaged');
      expect(byPath.get('untracked.txt')?.state).toBe('untracked');
      expect(byPath.get('deleted.txt')?.state).toBe('deleted');
      expect(byPath.get('mixed.txt')?.state).toBe('mixed');
      expect(byPath.get('missing.txt')?.state).toBe('absent');
      expect(byPath.get('link')?.object_kind.worktree).toBe('symlink');
      expect(byPath.get('gitlink')?.object_kind.index).toBe('gitlink');
      expect(byPath.get('rename-old.txt')).toMatchObject({
        state: 'renamed',
        rename_from: null,
        rename_to: 'rename-new.txt',
      });
      expect(byPath.get('rename-new.txt')).toMatchObject({
        state: 'renamed',
        rename_from: 'rename-old.txt',
        rename_to: null,
      });

      const noExclusion = planner.snapshotEvidence({
        ...input,
        generatedPlanPath: NO_EXCLUSION_PLAN_PATH,
      });
      expect(noExclusion.global_dirty_digest.value).not.toBe(
        plannerSnapshot.global_dirty_digest.value,
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects non-generated-plan paths in both the API and snapshot CLI', async () => {
    const repo = createBaseRepo();
    try {
      const planner = await importHelper(PLAN_HELPER);
      const invalidPaths = [
        'src/plan.md',
        '.git/config',
        'docs/plans/2026-02-30-gitnexus-plan-bad-date-name.md',
        'docs/plans/arbitrary.md',
      ];

      for (const generatedPlanPath of invalidPaths) {
        expect(() => planner.snapshotEvidence({ repo, generatedPlanPath, citedPaths: [] })).toThrow(
          /restricted to docs\/plans\/YYYY-MM-DD-gitnexus-plan|invalid calendar date/,
        );

        const cli = spawnSync(
          process.execPath,
          [
            PLAN_HELPER,
            'snapshot',
            '--repo',
            repo,
            '--schema-version',
            '2',
            '--generated-plan',
            generatedPlanPath,
          ],
          { encoding: 'utf8' },
        );
        expect(cli.status).toBe(1);
        expect(cli.stderr).toMatch(
          /restricted to docs\/plans\/YYYY-MM-DD-gitnexus-plan|invalid calendar date/,
        );
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a worktree mutation observed after layer materialization', async () => {
    const repo = createFixture();
    try {
      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.snapshotEvidence({
          repo,
          generatedPlanPath: GENERATED_PLAN_PATH,
          citedPaths: ['unstaged.txt'],
          testHooks: {
            afterMaterialize() {
              write(repo, 'unstaged.txt', 'raced\n');
            },
          },
        }),
      ).toThrow(
        /changed (before|while) evidence materialization completed|changed while evidence/i,
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['afterMaterialize', 'afterFirstGuardPass'] as const)(
    'rejects an ignored cited path created during %s',
    async (hookName) => {
      const repo = createBaseRepo();
      try {
        write(repo, '.gitignore', 'ignored-dir/\nignored-leaf.txt\n');
        git(repo, ['add', '.gitignore']);
        git(repo, ['commit', '--quiet', '-m', 'ignore evidence fixtures']);
        const planner = await importHelper(PLAN_HELPER);
        const ignoredPath =
          hookName === 'afterMaterialize' ? 'ignored-leaf.txt' : 'ignored-dir/leaf.txt';
        expect(() =>
          planner.snapshotEvidence({
            repo,
            generatedPlanPath: GENERATED_PLAN_PATH,
            citedPaths: [ignoredPath],
            testHooks: {
              [hookName]() {
                write(repo, ignoredPath, 'appeared\n');
              },
            },
          }),
        ).toThrow(/(appeared before evidence materialization completed|Absence anchor changed)/);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('anchors HEAD layers to the captured OID and detects an A-to-B-to-A ref ABA', async () => {
    const repo = createBaseRepo();
    try {
      const commitA = git(repo, ['rev-parse', 'HEAD']);
      write(repo, 'second.txt', 'second\n');
      git(repo, ['add', 'second.txt']);
      git(repo, ['commit', '--quiet', '-m', 'second']);
      const commitB = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['reset', '--hard', '--quiet', commitA]);

      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.snapshotEvidence({
          repo,
          generatedPlanPath: GENERATED_PLAN_PATH,
          citedPaths: ['base.txt'],
          testHooks: {
            afterAnchorCapture() {
              git(repo, ['update-ref', 'HEAD', commitB]);
            },
            afterGitLayerLoad() {
              git(repo, ['update-ref', 'HEAD', commitA]);
            },
          },
        }),
      ).toThrow(/Git (HEAD|refs\/|logs\/).*changed while evidence was materialized/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('materializes one captured index listing and detects an index ABA', async () => {
    const repo = createBaseRepo();
    try {
      write(repo, 'alternate.txt', 'alternate index bytes\n');
      const alternateOid = git(repo, ['hash-object', '-w', 'alternate.txt']);
      fs.unlinkSync(path.join(repo, 'alternate.txt'));
      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.snapshotEvidence({
          repo,
          generatedPlanPath: GENERATED_PLAN_PATH,
          citedPaths: ['base.txt'],
          testHooks: {
            afterAnchorCapture() {
              git(repo, ['update-index', '--cacheinfo', '100644', alternateOid, 'base.txt']);
            },
            afterGitLayerLoad() {
              git(repo, ['read-tree', 'HEAD']);
            },
          },
        }),
      ).toThrow(/Git index changed while evidence was materialized/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('merges overlapping delete/untracked and rename/recreated-source facts deterministically', async () => {
    const repo = createBaseRepo();
    try {
      const sourceContents = new Map([
        [
          'source.txt',
          Array.from({ length: 20 }, (_, index) => `source-one-${index}: stable payload`).join(
            '\n',
          ) + '\n',
        ],
        [
          'source-two.txt',
          Array.from({ length: 20 }, (_, index) => `source-two-${index}: stable payload`).join(
            '\n',
          ) + '\n',
        ],
      ]);
      write(repo, 'overlap.txt', 'overlap:base\n');
      for (const [file, contents] of sourceContents) write(repo, file, contents);
      git(repo, ['add', 'overlap.txt', 'source.txt', 'source-two.txt']);
      git(repo, ['commit', '--quiet', '-m', 'overlap base']);
      git(repo, ['config', 'diff.renameLimit', '1']);
      git(repo, ['config', 'status.renameLimit', '1']);
      git(repo, ['rm', '--cached', '--quiet', 'overlap.txt']);
      git(repo, ['mv', 'source.txt', 'destination.txt']);
      git(repo, ['mv', 'source-two.txt', 'destination-two.txt']);
      write(repo, 'destination.txt', `${sourceContents.get('source.txt')}destination-only edit\n`);
      write(
        repo,
        'destination-two.txt',
        `${sourceContents.get('source-two.txt')}destination-only edit\n`,
      );
      git(repo, ['add', 'destination.txt', 'destination-two.txt']);
      write(repo, 'source.txt', 'source.txt:recreated\n');
      write(repo, 'source-two.txt', 'source-two.txt:recreated\n');

      expect(
        git(repo, ['status', '--porcelain=v2', '--untracked-files=all', '--find-renames=50%']),
      ).not.toContain('2 R');

      const planner = await importHelper(PLAN_HELPER);
      const snapshot = planner.snapshotEvidence({
        repo,
        generatedPlanPath: GENERATED_PLAN_PATH,
        citedPaths: [
          'overlap.txt',
          'source.txt',
          'destination.txt',
          'source-two.txt',
          'destination-two.txt',
        ],
      });
      const byPath = new Map(snapshot.cited_path_manifest.map((entry) => [entry.path, entry]));

      expect(byPath.get('overlap.txt')).toMatchObject({
        state: 'mixed',
        object_kind: {
          head: 'regular',
          index: 'absent',
          worktree: 'absent',
          untracked: 'regular',
        },
      });
      for (const [source, destination] of [
        ['source.txt', 'destination.txt'],
        ['source-two.txt', 'destination-two.txt'],
      ]) {
        expect(byPath.get(source)).toMatchObject({
          state: 'mixed',
          rename_from: null,
          rename_to: destination,
          object_kind: {
            head: 'regular',
            index: 'absent',
            worktree: 'absent',
            untracked: 'regular',
          },
        });
        expect(byPath.get(destination)).toMatchObject({
          state: 'renamed',
          rename_from: source,
          rename_to: null,
          object_kind: {
            head: 'absent',
            index: 'regular',
            worktree: 'regular',
            untracked: 'absent',
          },
        });
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('canonicalizes an untracked embedded repository as one bounded directory record', async () => {
    const repo = createBaseRepo();
    try {
      const child = path.join(repo, 'child');
      fs.mkdirSync(child);
      git(child, ['init', '--quiet']);
      write(child, 'nested.txt', 'nested\n');
      expect(git(repo, ['status', '--porcelain=v2', '--untracked-files=all'])).toContain(
        '? child/',
      );

      const planner = await importHelper(PLAN_HELPER);
      const input = {
        repo,
        generatedPlanPath: GENERATED_PLAN_PATH,
        citedPaths: ['child'],
      };
      const first = planner.snapshotEvidence(input);
      const childEntry = first.cited_path_manifest.find((entry) => entry.path === 'child');
      expect(childEntry).toMatchObject({
        state: 'untracked',
        object_kind: {
          head: 'absent',
          index: 'absent',
          worktree: 'absent',
          untracked: 'directory',
        },
      });
      write(child, '.git/audit-noise', 'administrative bytes are outside the parent snapshot\n');
      const second = planner.snapshotEvidence(input);
      expect(second.global_dirty_digest.value).toBe(first.global_dirty_digest.value);
      expect(planner.DIRECTORY_LIMITS).toEqual({
        maxEntries: 10_000,
        maxDepth: 256,
        maxBytes: 256 * 1024 * 1024,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requires every checked-out gitlink to be its own initialized repository with HEAD', async () => {
    const repo = createBaseRepo();
    try {
      const oid = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['update-index', '--add', '--cacheinfo', '160000', oid, 'plain-link']);
      git(repo, ['update-index', '--add', '--cacheinfo', '160000', oid, 'unborn-link']);
      git(repo, ['commit', '--quiet', '-m', 'gitlinks']);
      fs.mkdirSync(path.join(repo, 'plain-link'));
      fs.mkdirSync(path.join(repo, 'unborn-link'));
      git(path.join(repo, 'unborn-link'), ['init', '--quiet']);

      const planner = await importHelper(PLAN_HELPER);
      for (const gitlink of ['plain-link', 'unborn-link']) {
        expect(() =>
          planner.snapshotEvidence({
            repo,
            generatedPlanPath: GENERATED_PLAN_PATH,
            citedPaths: [gitlink],
          }),
        ).toThrow(/not its own repository|Cannot resolve checked-out gitlink HEAD/);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['staged', 'unstaged', 'untracked', 'ignored'] as const)(
    'fails closed on %s bytes in a checked-out gitlink whose HEAD is unchanged',
    async (dirtyState) => {
      const repo = createBaseRepo();
      try {
        const gitlink = path.join(repo, 'gitlink');
        fs.mkdirSync(gitlink);
        git(gitlink, ['init', '--quiet']);
        git(gitlink, ['config', 'user.name', 'GitNexus Test']);
        git(gitlink, ['config', 'user.email', 'gitnexus@example.invalid']);
        write(gitlink, 'tracked.txt', 'base\n');
        write(gitlink, '.gitignore', 'ignored.txt\n');
        git(gitlink, ['add', 'tracked.txt', '.gitignore']);
        git(gitlink, ['commit', '--quiet', '-m', 'nested base']);
        git(repo, ['add', 'gitlink']);
        git(repo, ['commit', '--quiet', '-m', 'gitlink']);
        const nestedHead = git(gitlink, ['rev-parse', 'HEAD']);

        if (dirtyState === 'untracked') {
          write(gitlink, 'untracked.txt', 'untracked\n');
        } else if (dirtyState === 'ignored') {
          write(gitlink, 'ignored.txt', 'ignored\n');
        } else {
          write(gitlink, 'tracked.txt', `${dirtyState}\n`);
          if (dirtyState === 'staged') git(gitlink, ['add', 'tracked.txt']);
        }

        expect(git(gitlink, ['rev-parse', 'HEAD'])).toBe(nestedHead);
        const planner = await importHelper(PLAN_HELPER);
        expect(() =>
          planner.snapshotEvidence({
            repo,
            generatedPlanPath: GENERATED_PLAN_PATH,
            citedPaths: ['gitlink'],
          }),
        ).toThrow(/Checked-out gitlink is dirty/);
        expect(git(gitlink, ['rev-parse', 'HEAD'])).toBe(nestedHead);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('visits each node in a deep directory exactly once', async () => {
    const repo = createBaseRepo();
    try {
      const depth = 40;
      const components = Array.from({ length: depth }, (_, index) => `d${index}`);
      write(repo, path.join('deep', ...components, 'leaf.txt'), 'leaf\n');
      const planner = await importHelper(PLAN_HELPER);
      let visits = 0;
      planner.snapshotEvidence({
        repo,
        generatedPlanPath: GENERATED_PLAN_PATH,
        citedPaths: ['deep'],
        testHooks: {
          onDirectoryEntry() {
            visits += 1;
          },
        },
      });
      expect(visits).toBe(depth + 1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

const SAFE_WRITE_FIXTURES = process.platform === 'linux' ? describe : describe.skip;

SAFE_WRITE_FIXTURES('generated-plan safe writer', () => {
  it('reads an exact descriptor-anchored plan receipt through both API and CLI', async () => {
    const repo = createBaseRepo('gitnexus-plan-reader-');
    try {
      const contents = '# exact plan\n\u2603\n';
      write(repo, SAFE_PLAN_PATH, contents);
      const planner = await importHelper(PLAN_HELPER);
      const receipt = planner.readPlanSafely({ repo, generatedPlanPath: SAFE_PLAN_PATH });
      expect(receipt).toEqual({
        generated_plan_path: SAFE_PLAN_PATH,
        bytes_read: Buffer.byteLength(contents),
        plan_digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        plan_bytes_base64: Buffer.from(contents).toString('base64'),
      });

      const cli = spawnSync(
        process.execPath,
        [PLAN_HELPER, 'read-plan', '--repo', repo, '--generated-plan', SAFE_PLAN_PATH],
        { encoding: 'utf8' },
      );
      expect(cli.status, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual(receipt);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([DOCUMENTED_TWO_WORD_PLAN_PATH, LEGACY_PLAN_PATH])(
    'reads the compatible existing plan path %s without widening the write policy',
    async (generatedPlanPath) => {
      const repo = createBaseRepo('gitnexus-plan-reader-');
      try {
        const contents = '# compatible existing plan\n';
        write(repo, generatedPlanPath, contents);
        const planner = await importHelper(PLAN_HELPER);
        expect(planner.readPlanSafely({ repo, generatedPlanPath })).toMatchObject({
          generated_plan_path: generatedPlanPath,
          plan_bytes_base64: Buffer.from(contents).toString('base64'),
        });
        expect(() =>
          planner.writePlanSafely({ repo, generatedPlanPath, contents: '# replacement\n' }),
        ).toThrow(/Generated-plan writes are restricted/);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each(['symlink parent', 'symlink leaf'])(
    'read-plan rejects a %s without reading outside the repository',
    async (hazard) => {
      const repo = createBaseRepo('gitnexus-plan-reader-');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-plan-reader-outside-'));
      try {
        write(outside, 'outside.md', '# outside\n');
        if (hazard === 'symlink parent') {
          fs.symlinkSync(outside, path.join(repo, 'docs'));
        } else {
          fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
          fs.symlinkSync(path.join(outside, 'outside.md'), path.join(repo, SAFE_PLAN_PATH));
        }
        const planner = await importHelper(PLAN_HELPER);
        expect(() => planner.readPlanSafely({ repo, generatedPlanPath: SAFE_PLAN_PATH })).toThrow(
          /parent is not a real directory|regular file, never a symlink/,
        );
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('read-plan detects a leaf swap after opening the held descriptor', async () => {
    const repo = createBaseRepo('gitnexus-plan-reader-');
    try {
      write(repo, SAFE_PLAN_PATH, '# original\n');
      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.readPlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          testHooks: {
            afterPlanOpen({ finalPath }) {
              fs.unlinkSync(finalPath);
              fs.writeFileSync(finalPath, '# replacement\n');
            },
          },
        }),
      ).toThrow(/changed (while evidence was being read|before its receipt was produced)/);
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe('# replacement\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('creates and deliberately replaces only a regular repo-relative plan', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      const generatedPlanPath = SAFE_PLAN_PATH;
      expect(planner.writePlanSafely({ repo, generatedPlanPath, contents: '# first\n' })).toEqual({
        generated_plan_path: generatedPlanPath,
        bytes_written: 8,
      });
      expect(fs.readFileSync(path.join(repo, generatedPlanPath), 'utf8')).toBe('# first\n');
      expect(() =>
        planner.writePlanSafely({ repo, generatedPlanPath, contents: '# accidental\n' }),
      ).toThrow(/already exists/);
      const deepenReceipt = planner.writePlanSafely({
        repo,
        generatedPlanPath,
        contents: '# deepen\n',
        replace: true,
        expectedPlanPath: generatedPlanPath,
        expectedPlanDigest: loadedPlanDigest(planner, repo, generatedPlanPath),
      });
      expect(fs.readFileSync(path.join(repo, generatedPlanPath), 'utf8')).toBe('# deepen\n');
      expect(deepenReceipt.prior_plan_backup_git_path).toMatch(
        /^gitnexus-plan-backups\/\.gitnexus-plan-prior-plan-/,
      );
      expect(
        fs.readFileSync(
          path.resolve(
            repo,
            git(repo, [
              'rev-parse',
              '--git-path',
              deepenReceipt.prior_plan_backup_git_path as string,
            ]),
          ),
          'utf8',
        ),
      ).toBe('# first\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cannot be used as an arbitrary repository-file overwrite primitive', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      const gitConfig = fs.readFileSync(path.join(repo, '.git/config'));
      for (const generatedPlanPath of ['.git/config', 'docs/plans/arbitrary.md']) {
        expect(() =>
          planner.writePlanSafely({
            repo,
            generatedPlanPath,
            contents: '# overwrite\n',
            replace: true,
            expectedPlanPath: generatedPlanPath,
            expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
          }),
        ).toThrow(/restricted to docs\/plans\/YYYY-MM-DD-gitnexus-plan/);
      }
      expect(fs.readFileSync(path.join(repo, '.git/config'))).toEqual(gitConfig);
      expect(fs.existsSync(path.join(repo, 'docs/plans/arbitrary.md'))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requires literal API controls and a path-bound receipt for every replacement', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# blocked\n',
          replace: 'false' as unknown as boolean,
        }),
      ).toThrow(/replace must be a literal boolean/);
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# blocked\n',
          replace: true,
          expectedPlanPath: SAFE_PLAN_PATH,
        }),
      ).toThrow(/expectedPlanDigest from the read-plan receipt/);
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# blocked\n',
          replace: true,
          expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
        }),
      ).toThrow(/expectedPlanPath from the read-plan receipt must be a string/);
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# blocked\n',
          expectedPlanPath: SAFE_PLAN_PATH,
          expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
        }),
      ).toThrow(/valid only when replace is true/);
      expect(fs.existsSync(path.join(repo, SAFE_PLAN_PATH))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ['snapshot', ['--replace'], /--replace is not valid for snapshot/],
    [
      'snapshot',
      ['--expected-plan-digest', `sha256:${'0'.repeat(64)}`],
      /--expected-plan-digest is not valid for snapshot/,
    ],
    [
      'snapshot',
      ['--expected-plan-path', SAFE_PLAN_PATH],
      /--expected-plan-path is not valid for snapshot/,
    ],
    ['read-plan', ['--cited', 'base.txt'], /--cited is not valid for read-plan/],
    ['read-plan', ['--schema-version', '2'], /--schema-version is not valid for read-plan/],
    ['write-plan', ['--schema-version', '2'], /--schema-version is not valid for write-plan/],
    ['write-plan', ['--cited', 'base.txt'], /--cited is not valid for write-plan/],
    [
      'write-plan',
      ['--replace'],
      /--replace requires --expected-plan-path and --expected-plan-digest/,
    ],
    [
      'write-plan',
      ['--replace', '--expected-plan-digest', `sha256:${'0'.repeat(64)}`],
      /--replace requires --expected-plan-path and --expected-plan-digest/,
    ],
    [
      'write-plan',
      ['--expected-plan-digest', `sha256:${'0'.repeat(64)}`],
      /--expected-plan-path and --expected-plan-digest require --replace/,
    ],
    [
      'write-plan',
      ['--expected-plan-path', SAFE_PLAN_PATH],
      /--expected-plan-path and --expected-plan-digest require --replace/,
    ],
  ] as const)('rejects command-inapplicable CLI options for %s', (command, extra, pattern) => {
    const repo = createBaseRepo('gitnexus-plan-cli-options-');
    try {
      const result = spawnSync(
        process.execPath,
        [PLAN_HELPER, command, '--repo', repo, '--generated-plan', SAFE_PLAN_PATH, ...extra],
        { encoding: 'utf8', input: '# plan\n' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(pattern);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never overwrites a destination created immediately before initial publication', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# intended initial plan\n',
          testHooks: {
            beforePublication({ finalPath }) {
              fs.writeFileSync(finalPath, '# raced destination\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/publication was refused because the destination raced/);
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe(
        '# raced destination\n',
      );
      expect(artifactContents(repo, message, 'unpublished-plan')).toBe('# intended initial plan\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves the prior plan and never overwrites a destination raced into Deepen publication', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# prior plan\n',
      });

      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# intended deepen plan\n',
          replace: true,
          expectedPlanPath: SAFE_PLAN_PATH,
          expectedPlanDigest: loadedPlanDigest(planner, repo),
          testHooks: {
            beforePublication({ finalPath }) {
              fs.writeFileSync(finalPath, '# raced destination\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/publication was refused because the destination raced/);
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe(
        '# raced destination\n',
      );
      expect(artifactContents(repo, message, 'prior-plan')).toBe('# prior plan\n');
      expect(artifactContents(repo, message, 'unpublished-plan')).toBe('# intended deepen plan\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves both destination versions when Deepen races before the backup move', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# expected prior plan\n',
      });

      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# intended deepen plan\n',
          replace: true,
          expectedPlanPath: SAFE_PLAN_PATH,
          expectedPlanDigest: loadedPlanDigest(planner, repo),
          testHooks: {
            beforeBackupMove({ finalPath }) {
              fs.unlinkSync(finalPath);
              fs.writeFileSync(finalPath, '# displaced raced plan\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(
        /Generated plan changed (during the write|through its open descriptor)/,
      );
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe(
        '# displaced raced plan\n',
      );
      expect(artifactContents(repo, message, 'expected-prior-plan')).toBe(
        '# expected prior plan\n',
      );
      expect(artifactContents(repo, message, 'unpublished-plan')).toBe('# intended deepen plan\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a same-inode Deepen edit against the exact read-plan digest', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# prior-plan\n',
      });
      const receipt = planner.readPlanSafely({ repo, generatedPlanPath: SAFE_PLAN_PATH });
      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# intended deepen\n',
          replace: true,
          expectedPlanPath: receipt.generated_plan_path,
          expectedPlanDigest: receipt.plan_digest,
          testHooks: {
            beforeBackupMove({ finalPath }) {
              fs.writeFileSync(finalPath, '# raced-plan\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/exact digest from the read-plan receipt/);
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe('# raced-plan\n');
      expect(artifactContents(repo, message, 'unpublished-plan')).toBe('# intended deepen\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a plan changed between read-plan and Deepen write', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# loaded prior\n',
      });
      const receipt = planner.readPlanSafely({ repo, generatedPlanPath: SAFE_PLAN_PATH });
      fs.writeFileSync(path.join(repo, SAFE_PLAN_PATH), '# newer prior\n');
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# stale deepen\n',
          replace: true,
          expectedPlanPath: receipt.generated_plan_path,
          expectedPlanDigest: receipt.plan_digest,
        }),
      ).toThrow(/exact digest from the read-plan receipt/);
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe('# newer prior\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cannot use an identical-content receipt from plan A to replace plan B', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      for (const generatedPlanPath of [SAFE_PLAN_PATH, ALTERNATE_SAFE_PLAN_PATH]) {
        planner.writePlanSafely({
          repo,
          generatedPlanPath,
          contents: '# identical prior\n',
        });
      }
      const receiptA = planner.readPlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
      });

      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: ALTERNATE_SAFE_PLAN_PATH,
          contents: '# unauthorized replacement\n',
          replace: true,
          expectedPlanPath: receiptA.generated_plan_path,
          expectedPlanDigest: receiptA.plan_digest,
        }),
      ).toThrow(/expectedPlanPath.*must exactly match generatedPlanPath/);

      const cli = spawnSync(
        process.execPath,
        [
          PLAN_HELPER,
          'write-plan',
          '--repo',
          repo,
          '--generated-plan',
          ALTERNATE_SAFE_PLAN_PATH,
          '--replace',
          '--expected-plan-path',
          receiptA.generated_plan_path,
          '--expected-plan-digest',
          receiptA.plan_digest,
        ],
        { encoding: 'utf8', input: '# unauthorized CLI replacement\n' },
      );
      expect(cli.status).toBe(1);
      expect(cli.stderr).toMatch(/expectedPlanPath.*must exactly match generatedPlanPath/);
      expect(fs.readFileSync(path.join(repo, ALTERNATE_SAFE_PLAN_PATH), 'utf8')).toBe(
        '# identical prior\n',
      );

      const receiptB = planner.readPlanSafely({
        repo,
        generatedPlanPath: ALTERNATE_SAFE_PLAN_PATH,
      });
      const authorizedCli = spawnSync(
        process.execPath,
        [
          PLAN_HELPER,
          'write-plan',
          '--repo',
          repo,
          '--generated-plan',
          ALTERNATE_SAFE_PLAN_PATH,
          '--replace',
          '--expected-plan-path',
          receiptB.generated_plan_path,
          '--expected-plan-digest',
          receiptB.plan_digest,
        ],
        { encoding: 'utf8', input: '# authorized CLI replacement\n' },
      );
      expect(authorizedCli.status, authorizedCli.stderr).toBe(0);
      expect(fs.readFileSync(path.join(repo, ALTERNATE_SAFE_PLAN_PATH), 'utf8')).toBe(
        '# authorized CLI replacement\n',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detects a post-open destination swap and reports only fresh-root Git-admin artifacts', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# prior plan\n',
      });

      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# replacement plan\n',
          replace: true,
          expectedPlanPath: SAFE_PLAN_PATH,
          expectedPlanDigest: loadedPlanDigest(planner, repo),
          testHooks: {
            afterFinalOpen({ finalPath }) {
              fs.unlinkSync(finalPath);
              fs.writeFileSync(finalPath, '# attacker replacement\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).not.toContain('docs/plans/.gitnexus-plan-recovery');
      expect(artifactContents(repo, message, 'prior-plan')).toBe('# prior plan\n');
      expect(artifactContents(repo, message, 'intended-plan')).toBe('# replacement plan\n');
      expect(fs.readFileSync(path.join(repo, SAFE_PLAN_PATH), 'utf8')).toBe(
        '# attacker replacement\n',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['symlink parent', 'non-directory parent', 'final symlink'])(
    'rejects a %s without writing through it',
    async (hazard) => {
      const repo = createBaseRepo('gitnexus-plan-writer-');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-plan-outside-'));
      try {
        const planner = await importHelper(PLAN_HELPER);
        if (hazard === 'symlink parent') {
          fs.symlinkSync(outside, path.join(repo, 'docs'));
        } else if (hazard === 'non-directory parent') {
          write(repo, 'docs', 'not a directory\n');
        } else {
          fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
          write(outside, 'target.md', 'outside\n');
          fs.symlinkSync(path.join(outside, 'target.md'), path.join(repo, SAFE_PLAN_PATH));
        }
        expect(() =>
          planner.writePlanSafely({
            repo,
            generatedPlanPath: SAFE_PLAN_PATH,
            contents: '# blocked\n',
          }),
        ).toThrow(/not a real directory|regular file|symlink/);
        expect(
          fs.existsSync(path.join(outside, 'plans', path.posix.basename(SAFE_PLAN_PATH))),
        ).toBe(false);
        if (hazard === 'final symlink') {
          expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe('outside\n');
        }
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('rejects a lexical-parent swap after opening the anchored descriptor', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-plan-outside-'));
    try {
      fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
      const planner = await importHelper(PLAN_HELPER);
      expect(() =>
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# blocked\n',
          testHooks: {
            afterParentOpen() {
              fs.renameSync(path.join(repo, 'docs/plans'), path.join(repo, 'docs/plans-original'));
              fs.symlinkSync(outside, path.join(repo, 'docs/plans'));
            },
          },
        }),
      ).toThrow(/moved or was replaced|no longer matches/);
      expect(fs.existsSync(path.join(outside, path.posix.basename(SAFE_PLAN_PATH)))).toBe(false);
      expect(
        fs.existsSync(path.join(repo, 'docs/plans-original', path.posix.basename(SAFE_PLAN_PATH))),
      ).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports durable Git-admin recovery after the plan parent moves post-publication', async () => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# prior plan\n',
      });

      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# replacement plan\n',
          replace: true,
          expectedPlanPath: SAFE_PLAN_PATH,
          expectedPlanDigest: loadedPlanDigest(planner, repo),
          testHooks: {
            afterPublication() {
              fs.renameSync(path.join(repo, 'docs/plans'), path.join(repo, 'docs/plans-moved'));
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/parent moved or was replaced/);
      expect(message).not.toContain('docs/plans/.gitnexus-plan-recovery');
      expect(artifactContents(repo, message, 'prior-plan')).toBe('# prior plan\n');
      expect(artifactContents(repo, message, 'intended-plan')).toBe('# replacement plan\n');
      expect(
        fs.readFileSync(
          path.join(repo, 'docs/plans-moved', path.posix.basename(SAFE_PLAN_PATH)),
          'utf8',
        ),
      ).toBe('# replacement plan\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['modify', 'replace'])('rejects a temp-path %s race before rename', async (mode) => {
    const repo = createBaseRepo('gitnexus-plan-writer-');
    try {
      fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
      const planner = await importHelper(PLAN_HELPER);
      let failure: unknown;
      try {
        planner.writePlanSafely({
          repo,
          generatedPlanPath: SAFE_PLAN_PATH,
          contents: '# expected\n',
          testHooks: {
            beforeRename({ tempPath }) {
              if (mode === 'replace') fs.unlinkSync(tempPath);
              fs.writeFileSync(tempPath, '# tampered\n');
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/temporary path or content changed/);
      expect(fs.existsSync(path.join(repo, SAFE_PLAN_PATH))).toBe(false);
      expect(
        fs
          .readdirSync(path.join(repo, 'docs/plans'))
          .some((entry) => entry.startsWith('.gitnexus-plan-') && entry.endsWith('.tmp')),
      ).toBe(false);
      expect(artifactContents(repo, message, 'unpublished-plan')).toBe('# tampered\n');
      expect(artifactContents(repo, message, 'intended-plan')).toBe('# expected\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fsyncs every created directory and both sides of preservation moves', async () => {
    const repo = createBaseRepo('gitnexus-plan-durability-');
    const fsyncedDirectories: string[] = [];
    const realFsync = fs.fsyncSync.bind(fs);
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      try {
        const resolved = fs.realpathSync(`/proc/self/fd/${fd}`);
        if (fs.fstatSync(fd).isDirectory()) fsyncedDirectories.push(resolved);
      } catch {
        // The production call below owns any real fsync error.
      }
      return realFsync(fd);
    });
    try {
      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# initial\n',
      });
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# deepen\n',
        replace: true,
        expectedPlanPath: SAFE_PLAN_PATH,
        expectedPlanDigest: loadedPlanDigest(planner, repo),
      });
      const gitDirectory = fs.realpathSync(path.join(repo, '.git'));
      for (const durableDirectory of [
        repo,
        path.join(repo, 'docs'),
        path.join(repo, 'docs/plans'),
        gitDirectory,
        path.join(gitDirectory, 'gitnexus-plan-backups'),
      ]) {
        expect(fsyncedDirectories).toContain(fs.realpathSync(durableDirectory));
      }
      expect(
        fsyncedDirectories.filter(
          (entry) => entry === fs.realpathSync(path.join(repo, 'docs/plans')),
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        fsyncedDirectories.filter(
          (entry) => entry === fs.realpathSync(path.join(gitDirectory, 'gitnexus-plan-backups')),
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uses a validated absolute python3 candidate from a nonstandard PATH directory', async () => {
    const repo = createBaseRepo('gitnexus-plan-python-path-');
    const toolsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-safe-tools-'));
    const marker = path.join(toolsDirectory, 'python-used');
    const originalPath = process.env.PATH;
    const originalMarker = process.env.GITNEXUS_TEST_PYTHON_MARKER;
    try {
      fs.chmodSync(toolsDirectory, 0o700);
      const pythonLookup = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
      const gitLookup = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
      expect(pythonLookup.status).toBe(0);
      expect(gitLookup.status).toBe(0);
      const python = fs.realpathSync(pythonLookup.stdout.trim());
      const gitExecutable = fs.realpathSync(gitLookup.stdout.trim());
      const wrapper = path.join(toolsDirectory, 'python3');
      fs.writeFileSync(
        wrapper,
        `#!/bin/sh\n: > "$GITNEXUS_TEST_PYTHON_MARKER"\nexec "${python}" "$@"\n`,
        { mode: 0o700 },
      );
      fs.symlinkSync(gitExecutable, path.join(toolsDirectory, 'git'));
      process.env.PATH = toolsDirectory;
      process.env.GITNEXUS_TEST_PYTHON_MARKER = marker;

      const planner = await importHelper(PLAN_HELPER);
      planner.writePlanSafely({
        repo,
        generatedPlanPath: SAFE_PLAN_PATH,
        contents: '# nonstandard python\n',
      });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.GITNEXUS_TEST_PYTHON_MARKER;
      else process.env.GITNEXUS_TEST_PYTHON_MARKER = originalMarker;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(toolsDirectory, { recursive: true, force: true });
    }
  });
});
