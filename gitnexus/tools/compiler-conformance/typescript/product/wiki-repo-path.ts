/**
 * Which repository `gitnexus wiki <path>` documents when the path is a folder
 * or a file inside an indexed repository (#493). Git runs for real on
 * temporary repositories; the LLM config and the generator are mocked, and
 * the first block also mocks the index lookup.
 */
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as resolver from '../../../../dist/storage/storage-resolver.js';
import * as manager from '../../../../dist/storage/repo-manager.js';
import * as llm from '../../../../dist/core/wiki/llm-client.js';
import type { StorageState } from '../../../../dist/storage/storage-resolver.js';

const requireStorage = mock.fn(resolver.requireStoragePath);
const recorded = mock.fn((_repo: string, _storage: string, _lbug: string) => {});
const config = {
  apiKey: 'test',
  baseUrl: 'https://example.invalid/v1',
  model: 'test',
  provider: 'openai',
};
const modules = [
  mock.module(new URL('../../../../dist/storage/storage-resolver.js', import.meta.url).href, {
    namedExports: { ...resolver, requireStoragePath: requireStorage },
  }),
  mock.module(new URL('../../../../dist/storage/repo-manager.js', import.meta.url).href, {
    namedExports: {
      ...manager,
      loadMeta: async () => ({ createdAt: '2026-01-01T00:00:00Z' }),
      loadCLIConfig: async () => config,
      saveCLIConfig: async () => {},
    },
  }),
  mock.module(new URL('../../../../dist/core/wiki/llm-client.js', import.meta.url).href, {
    namedExports: {
      ...llm,
      resolveLLMConfig: async () => ({ ...config, maxTokens: 16_384, temperature: 0 }),
    },
  }),
  mock.module(new URL('../../../../dist/core/wiki/generator.js', import.meta.url).href, {
    namedExports: {
      WikiGenerator: class {
        constructor(repo: string, storage: string, lbug: string) {
          recorded(repo, storage, lbug);
        }
        async run() {
          return { mode: 'up-to-date', pagesGenerated: 0 };
        }
      },
    },
  }),
  mock.module('cli-progress', {
    defaultExport: {
      SingleBar: class {
        start() {}
        update() {}
        stop() {}
      },
      Presets: { shades_grey: {} },
    },
  }),
];
after(() => {
  for (const module of modules) module.restore();
});
const { wikiCommand } = await import('../../../../dist/cli/wiki.js');

beforeEach(() => {
  recorded.mock.resetCalls();
  requireStorage.mock.mockImplementation(resolver.requireStoragePath);
});

async function runWiki(target: string) {
  const log = mock.method(console, 'log', () => {});
  try {
    await wikiCommand(target, {});
    const [documented, storagePath, lbugPath] = recorded.mock.calls[0]?.arguments ?? [];
    return {
      documented,
      storagePath,
      lbugPath,
      output: log.mock.calls.map((call) => call.arguments.join(' ')).join('\n'),
    };
  } finally {
    log.mock.restore();
  }
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

  beforeEach(async () => {
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
    requireStorage.mock.mockImplementation(async (repoPath) => {
      const storagePath = path.join(repoPath, '.gitnexus');
      if (indexed.has(repoPath)) return storagePath;
      const {
        state,
        hasCodeIndexDB = false,
        reason,
      } = states.get(repoPath) ?? { state: 'missing' };
      throw new resolver.StorageRequirementError(
        { repoPath, storagePath, state, hasCodeIndexDB, reason },
        resolver.STATUS_STORAGE_REQUIREMENTS,
      );
    });
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, outside, other]) await fs.rm(dir, { recursive: true, force: true });
  });

  it('documents the repository it is given', async () => {
    const run = await runWiki(root);

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.lbugPath?.startsWith(path.join(root, '.gitnexus') + path.sep)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a folder', async () => {
    const run = await runWiki(path.join(root, 'api'));

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.lbugPath?.startsWith(path.join(root, '.gitnexus') + path.sep)).toBe(true);
    expect(run.output).toContain(`Using the index of ${root}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a file', async () => {
    const run = await runWiki(path.join(root, 'api', 'orders.ts'));

    expect(run.documented).toBe(root);
    expect(run.storagePath).toBe(path.join(root, '.gitnexus'));
    expect(run.output).not.toContain('Not a git repository');
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the index of a folder that was analyzed on its own', async () => {
    indexed.add(path.join(root, 'api'));

    const run = await runWiki(path.join(root, 'api'));

    expect(run.documented).toBe(path.join(root, 'api'));
    expect(run.storagePath).toBe(path.join(root, 'api', '.gitnexus'));
    expect(run.output).not.toContain('Using the index of');
  });

  for (const [label, state] of [
    ['empty', 'empty'],
    ['owned without a code index', 'owned'],
  ] as const) {
    it(`uses the repository when the folder storage is ${label}`, async () => {
      states.set(path.join(root, 'api'), { state });

      expect((await runWiki(path.join(root, 'api'))).documented).toBe(root);
    });
  }

  it('does not move to the repository when the folder storage could not be read', async () => {
    states.set(path.join(root, 'api'), {
      state: 'owned',
      reason: 'EIO: i/o error, access',
    });

    const run = await runWiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(
      `No GitNexus index found at ${path.join(root, 'api', '.gitnexus')}`,
    );
    expect(process.exitCode).toBe(1);
  });

  for (const state of ['foreign', 'unowned', 'invalid_storage'] as const) {
    it(`reports a folder storage in the ${state} state instead of moving to the repository`, async () => {
      states.set(path.join(root, 'api'), { state, hasCodeIndexDB: state === 'foreign' });

      const run = await runWiki(path.join(root, 'api'));

      expect(run.documented).toBeUndefined();
      expect(run.output).toContain(`Error: Storage path is in state "${state}"`);
      expect(run.output).not.toContain('It is the index of');
      expect(process.exitCode).toBe(1);
    });
  }

  it("names the repository's index when neither the folder nor the repository is indexed", async () => {
    indexed.clear();

    const run = await runWiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(`No GitNexus index found at ${path.join(root, '.gitnexus')}`);
    expect(process.exitCode).toBe(1);
  });

  it("names the repository when the repository's own storage cannot be used", async () => {
    indexed.clear();
    states.set(root, { state: 'unowned' });

    const run = await runWiki(path.join(root, 'api'));

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

    const run = await runWiki(path.join(link, 'api'));

    expect(run.documented).toBe(root);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not use another checkout named by GIT_DIR and GIT_WORK_TREE', async () => {
    indexed = new Set([other]);
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;

    const run = await runWiki(path.join(root, 'api'));

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain(
      `No GitNexus index found at ${path.join(root, 'api', '.gitnexus')}`,
    );
    expect(process.exitCode).toBe(1);
  });

  it('still refuses a path outside any repository', async () => {
    const run = await runWiki(outside);

    expect(run.documented).toBeUndefined();
    expect(run.output).toContain('Not a git repository');
    expect(process.exitCode).toBe(1);
  });

  it('reports a path it cannot read as outside any repository', async () => {
    const run = await runWiki(path.join(outside, 'x'.repeat(300)));

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
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home]) await fs.rm(dir, { recursive: true, force: true });
  });

  for (const [label, relative] of [
    ['the repository', ''],
    ['a folder inside it', 'api'],
    ['a file inside it', path.join('api', 'orders.ts')],
  ] as const) {
    it(`documents the repository from ${label}`, async () => {
      const run = await runWiki(path.join(root, relative));

      expect(run.documented).toBe(root);
      expect(run.storagePath).toBe(storage);
      expect(run.lbugPath).toBe(path.join(storage, 'lbug'));
      expect(run.output).not.toContain('Error');
      expect(process.exitCode).toBeUndefined();
    });
  }
});
