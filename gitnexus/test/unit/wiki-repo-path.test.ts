/**
 * Which repository `gitnexus wiki <path>` documents when the path is a folder
 * or a file inside an indexed repository (#493). Git runs for real on
 * temporary repositories; the LLM config and the generator are mocked, and
 * the first block also mocks the index lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StorageState } from '../../src/storage/storage-resolver.js';

/** Mocks the LLM config, the generator and the progress bar for one `wiki` run. */
function mockWikiRun() {
  const generatorCtor = vi.fn().mockImplementation(function () {
    return { run: vi.fn().mockResolvedValue({ mode: 'up-to-date', pagesGenerated: 0 }) };
  });
  vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
    loadMeta: vi.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
    loadCLIConfig: vi.fn().mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      provider: 'openai',
    }),
    saveCLIConfig: vi.fn(),
  }));
  vi.doMock('../../src/core/wiki/llm-client.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/core/wiki/llm-client.js')>()),
    resolveLLMConfig: vi.fn().mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 16_384,
      temperature: 0,
      provider: 'openai',
    }),
  }));
  vi.doMock('../../src/core/wiki/generator.js', () => ({ WikiGenerator: generatorCtor }));
  vi.doMock('cli-progress', () => ({
    default: {
      SingleBar: vi.fn(function () {
        return { start: vi.fn(), update: vi.fn(), stop: vi.fn() };
      }),
      Presets: { shades_grey: {} },
    },
  }));
  return generatorCtor;
}

/** Runs `gitnexus wiki <target>`: what it documented, from which storage, and what it printed. */
async function runWiki(target: string, generatorCtor: ReturnType<typeof mockWikiRun>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { wikiCommand } = await import('../../src/cli/wiki.js');
  await wikiCommand(target, {});
  const [documented, storagePath, lbugPath] = (generatorCtor.mock.calls[0] ?? []) as (
    | string
    | undefined
  )[];
  return {
    documented,
    storagePath,
    lbugPath,
    output: log.mock.calls.map((call) => call.join(' ')).join('\n'),
  };
}

const ENV_KEYS = [
  'GIT_CEILING_DIRECTORIES',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GITNEXUS_HOME',
  'GITNEXUS_STORAGE_PATH',
] as const;

describe('wikiCommand path inside a repository', () => {
  const originalExitCode = process.exitCode;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let root: string;
  let outside: string;
  let other: string;
  let indexed: Set<string>;
  /** The storage state of folders that are not indexed; `missing` when absent. */
  let states: Map<string, { state: StorageState; hasCodeIndexDB?: boolean; reason?: string }>;

  async function wiki(target: string) {
    vi.doMock('../../src/storage/storage-resolver.js', async (importActual) => {
      const actual = await importActual<typeof import('../../src/storage/storage-resolver.js')>();
      return {
        ...actual,
        // A folder has an index only when it was analyzed itself.
        requireStoragePath: vi.fn(async (repoPath: string) => {
          const storagePath = path.join(repoPath, '.gitnexus');
          if (indexed.has(repoPath)) return storagePath;
          const {
            state,
            hasCodeIndexDB = false,
            reason,
          } = states.get(repoPath) ?? {
            state: 'missing',
          };
          throw new actual.StorageRequirementError(
            { repoPath, storagePath, state, hasCodeIndexDB, reason },
            actual.STATUS_STORAGE_REQUIREMENTS,
          );
        }),
      };
    });
    return runWiki(target, mockWikiRun());
  }

  beforeEach(async () => {
    vi.resetModules();
    process.exitCode = undefined;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-repo-path-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-no-repo-')));
    other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-other-repo-')));
    // Keep git from finding a repository above the temporary folders.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    await fs.mkdir(path.join(root, 'api'));
    await fs.writeFile(path.join(root, 'api', 'orders.ts'), 'export const orders = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['init', '-q'], { cwd: other });
    indexed = new Set([root]);
    states = new Map();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/storage/storage-resolver.js');
    vi.doUnmock('../../src/core/wiki/llm-client.js');
    vi.doUnmock('../../src/core/wiki/generator.js');
    vi.doUnmock('cli-progress');
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, outside, other]) await fs.rm(dir, { recursive: true, force: true });
  });

  it('documents the repository it is given', async () => {
    const run = await wiki(root);

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.lbugPath?.startsWith(path.join(root, '.gitnexus') + path.sep)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a folder', async () => {
    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.lbugPath?.startsWith(path.join(root, '.gitnexus') + path.sep)).toBe(true);
    expect(run.output).toContain(`Using the index of ${root}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a file', async () => {
    const run = await wiki(path.join(root, 'api', 'orders.ts'));

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.output).not.toContain('Not a git repository');
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the index of a folder that was analyzed on its own', async () => {
    indexed.add(path.join(root, 'api'));

    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBe(path.join(root, 'api'));
    expect(run.storagePath).toBe(path.join(root, 'api', '.gitnexus'));
    expect(run.output).not.toContain('Using the index of');
  });

  it.each([
    ['empty', 'empty'],
    ['owned without a code index', 'owned'],
  ] as const)('uses the repository when the folder storage is %s', async (_label, state) => {
    states.set(path.join(root, 'api'), { state });

    expect((await wiki(path.join(root, 'api'))).documented).toBe(root);
  });

  it('does not move to the repository when the folder storage could not be read', async () => {
    states.set(path.join(root, 'api'), {
      state: 'owned',
      reason: 'EIO: i/o error, access',
    });

    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(
      `No GitNexus index found at ${path.join(root, 'api', '.gitnexus')}`,
    );
    expect(process.exitCode).toBe(1);
  });

  it.each(['foreign', 'unowned', 'invalid_storage'] as const)(
    'reports a folder storage in the %s state instead of moving to the repository',
    async (state) => {
      states.set(path.join(root, 'api'), { state, hasCodeIndexDB: state === 'foreign' });

      const run = await wiki(path.join(root, 'api'));

      expect(run.documented).toBeUndefined();
      expect(run.output).toContain(`Error: Storage path is in state "${state}"`);
      expect(run.output).not.toContain('It is the index of');
      expect(process.exitCode).toBe(1);
    },
  );

  it("names the repository's index when neither the folder nor the repository is indexed", async () => {
    indexed.clear();

    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(`No GitNexus index found at ${path.join(root, '.gitnexus')}`);
    expect(process.exitCode).toBe(1);
  });

  it("names the repository when the repository's own storage cannot be used", async () => {
    indexed.clear();
    states.set(root, { state: 'unowned' });

    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain('Error: Storage path is in state "unowned"');
    expect(run.output).toContain(
      `It is the index of ${root}, which contains ${path.join(root, 'api')}.`,
    );
    expect(process.exitCode).toBe(1);
  });

  it('documents the repository when the folder is reached through a symlink', async () => {
    const link = path.join(outside, 'repo-link');
    await fs.symlink(root, link, 'dir');

    const run = await wiki(path.join(link, 'api'));

    expect(run.documented).toBe(root);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not use another checkout named by GIT_DIR and GIT_WORK_TREE', async () => {
    indexed = new Set([other]);
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;

    const run = await wiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(
      `No GitNexus index found at ${path.join(root, 'api', '.gitnexus')}`,
    );
    expect(process.exitCode).toBe(1);
  });

  it('still refuses a path outside any repository', async () => {
    const run = await wiki(outside);

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain('Not a git repository');
    expect(process.exitCode).toBe(1);
  });

  it('reports a path it cannot read as outside any repository', async () => {
    const run = await wiki(path.join(outside, 'x'.repeat(300)));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain('Not a git repository');
    expect(process.exitCode).toBe(1);
  });
});

describe('wikiCommand path inside a repository, with GITNEXUS_STORAGE_PATH', () => {
  const originalExitCode = process.exitCode;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let root: string;
  let home: string;
  let storage: string;

  beforeEach(async () => {
    vi.resetModules();
    process.exitCode = undefined;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-path-')));
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-home-')));
    storage = path.join(home, 'index');
    await fs.mkdir(path.join(root, 'api'));
    await fs.writeFile(path.join(root, 'api', 'orders.ts'), 'export const orders = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    // The repository's index, written outside it, as `analyze` does with this variable set.
    await fs.mkdir(storage);
    await fs.writeFile(
      path.join(storage, 'gitnexus.json'),
      JSON.stringify({ repoPath: root, storagePath: storage }),
    );
    await fs.writeFile(path.join(storage, 'lbug'), '');
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
    process.env.GITNEXUS_HOME = home;
    process.env.GITNEXUS_STORAGE_PATH = storage;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/wiki/llm-client.js');
    vi.doUnmock('../../src/core/wiki/generator.js');
    vi.doUnmock('cli-progress');
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home]) await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['the repository', ''],
    ['a folder inside it', 'api'],
    ['a file inside it', path.join('api', 'orders.ts')],
  ])('documents the repository from %s', async (_label, relative) => {
    const run = await runWiki(path.join(root, relative), mockWikiRun());

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(storage);
    expect(run.lbugPath).toBe(path.join(storage, 'lbug'));
    expect(run.output).not.toContain('Error');
    expect(process.exitCode).toBeUndefined();
  });
});
