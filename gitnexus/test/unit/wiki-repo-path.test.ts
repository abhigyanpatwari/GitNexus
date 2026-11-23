/**
 * Which repository `gitnexus wiki <path>` documents when the path is a folder
 * or a file inside an indexed repository (#493). Git runs for real on a
 * temporary repository; the index lookup, the LLM config and the generator
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('wikiCommand path inside a repository', () => {
  const originalExitCode = process.exitCode;
  let root: string;
  let outside: string;
  let indexed: Set<string>;
  /** Folders whose storage belongs to another repository. */
  let foreign: Set<string>;

  beforeEach(async () => {
    vi.resetModules();
    process.exitCode = undefined;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-repo-path-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-no-repo-')));
    await fs.mkdir(path.join(root, 'api'));
    await fs.writeFile(path.join(root, 'api', 'orders.ts'), 'export const orders = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    indexed = new Set([root]);
    foreign = new Set();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/storage/storage-resolver.js');
    vi.doUnmock('../../src/core/wiki/llm-client.js');
    vi.doUnmock('../../src/core/wiki/generator.js');
    vi.doUnmock('cli-progress');
    process.exitCode = originalExitCode;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  /** Runs `gitnexus wiki <target>` and returns the repository it documented and what it printed. */
  async function wiki(target: string) {
    const generatorCtor = vi.fn().mockImplementation(function () {
      return { run: vi.fn().mockResolvedValue({ mode: 'up-to-date', pagesGenerated: 0 }) };
    });
    vi.doMock('../../src/storage/storage-resolver.js', async (importActual) => {
      const actual = await importActual<typeof import('../../src/storage/storage-resolver.js')>();
      return {
        ...actual,
        // A folder has an index only when it was analyzed itself.
        requireStoragePath: vi.fn(async (repoPath: string) => {
          const storagePath = path.join(repoPath, '.gitnexus');
          if (indexed.has(repoPath)) return storagePath;
          const state = foreign.has(repoPath) ? 'foreign' : 'missing';
          throw new actual.StorageRequirementError(
            { repoPath, storagePath, state, hasCodeIndexDB: state === 'foreign' },
            actual.STATUS_STORAGE_REQUIREMENTS,
          );
        }),
      };
    });
    vi.doMock('../../src/storage/repo-manager.js', () => ({
      getStoragePaths: vi.fn((repoPath: string) => ({
        storagePath: path.join(repoPath, '.gitnexus'),
        lbugPath: path.join(repoPath, '.gitnexus', 'lbug'),
      })),
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { wikiCommand } = await import('../../src/cli/wiki.js');
    await wikiCommand(target, {});
    return {
      documented: generatorCtor.mock.calls[0]?.[0] as string | undefined,
      output: log.mock.calls.map((call) => call.join(' ')).join('\n'),
    };
  }

  it('documents the repository it is given', async () => {
    expect((await wiki(root)).documented).toBe(root);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a folder', async () => {
    const { documented, output } = await wiki(path.join(root, 'api'));

    expect(documented).toBe(root);
    expect(output).toContain(`Using the index of ${root}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('documents the indexed repository that contains a file', async () => {
    const { documented, output } = await wiki(path.join(root, 'api', 'orders.ts'));

    expect(documented).toBe(root);
    expect(output).not.toContain('Not a git repository');
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the index of a folder that was analyzed on its own', async () => {
    indexed.add(path.join(root, 'api'));

    const { documented, output } = await wiki(path.join(root, 'api'));

    expect(documented).toBe(path.join(root, 'api'));
    expect(output).not.toContain('Using the index of');
  });

  it("names the repository's index when neither the folder nor the repository is indexed", async () => {
    indexed.clear();

    const { documented, output } = await wiki(path.join(root, 'api'));

    expect(documented).toBeUndefined();
    expect(output).toContain(`No GitNexus index found at ${path.join(root, '.gitnexus')}`);
    expect(process.exitCode).toBe(1);
  });

  it("reports a folder's own index that cannot be used instead of moving to the repository", async () => {
    foreign.add(path.join(root, 'api'));

    const { documented, output } = await wiki(path.join(root, 'api'));

    expect(documented).toBeUndefined();
    expect(output).toContain('Error: Storage path is in state "foreign"');
    expect(process.exitCode).toBe(1);
  });

  it('still refuses a path outside any repository', async () => {
    const { documented, output } = await wiki(outside);

    expect(documented).toBeUndefined();
    expect(output).toContain('Not a git repository');
    expect(process.exitCode).toBe(1);
  });
});
