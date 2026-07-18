/**
 * Wiki keepalive: the generator must touch the __wiki__ pool entry every 60s
 * for the WHOLE run. Local agent CLI providers (claude/codex/opencode) buffer
 * stdout until process exit, so the old onChunk-based touch never fired during
 * long LLM calls; the pool's 5-minute idle sweep evicted __wiki__ mid-run and
 * the next graph query threw 'LadybugDB not initialized for repo "__wiki__"'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const SLOW_LLM_MS = 6 * 60_000; // longer than the pool's 5-minute idle timeout

describe('WikiGenerator keepalive', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-keepalive-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeGenerator(graphOverrides: Record<string, unknown> = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });

    const touchWikiDb = vi.fn();
    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb,
      getFilesWithExports: vi
        .fn()
        .mockResolvedValue([{ filePath: 'src/a.ts', symbols: [{ name: 'a', type: 'function' }] }]),
      getAllFiles: vi.fn().mockResolvedValue(['src/a.ts']),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
      ...graphOverrides,
    }));
    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn(),
    }));

    const llmClient = await import('../../src/core/wiki/llm-client.js');
    // Buffered provider simulation: nothing streams; the answer lands after 6 min.
    const callLLMSpy = vi
      .spyOn(llmClient, 'callLLM')
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ content: JSON.stringify({ All: ['src/a.ts'] }) }),
              SLOW_LLM_MS,
            ),
          ),
      );

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const storagePath = path.join(tmpDir, 'storage');
    await fs.mkdir(path.join(storagePath, 'wiki'), { recursive: true });
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    const gen = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'test',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { reviewOnly: true },
    );
    return { gen, touchWikiDb, callLLMSpy };
  }

  it('touches the wiki DB every 60s while a buffered LLM call is in flight', async () => {
    const { gen, touchWikiDb, callLLMSpy } = await makeGenerator();

    const run = gen.run();

    // run() does real async I/O (fs.mkdir, meta file read) before it ever
    // reaches the mocked callLLM. Advancing the fake clock before that
    // setTimeout is registered would leave the LLM promise unresolved
    // forever, so wait until the call is actually in flight — polling with
    // real microtasks/timers, since setTimeout/setInterval are the only
    // faked primitives — before advancing the fake clock.
    while (callLLMSpy.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Advance through 6 minutes in 1-minute increments, allowing event loop to process
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // Now await the run to complete
    await run;

    // 6 minutes of silent LLM call → at least 5 keepalive touches
    expect(touchWikiDb.mock.calls.length).toBeGreaterThanOrEqual(5);

    // After run() settles the interval is cleared — no further touches
    const settled = touchWikiDb.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(touchWikiDb.mock.calls.length).toBe(settled);
  }, 60000);

  it('clears the keepalive when the run throws', async () => {
    const { gen, touchWikiDb } = await makeGenerator({
      getFilesWithExports: vi.fn().mockRejectedValue(new Error('boom')),
      getAllFiles: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(gen.run()).rejects.toThrow('boom');

    const settled = touchWikiDb.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SLOW_LLM_MS);
    expect(touchWikiDb.mock.calls.length).toBe(settled);
  });
});
