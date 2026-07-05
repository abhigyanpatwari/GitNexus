import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  closeWikiDbMock,
  getAllFilesMock,
  getFilesWithExportsMock,
  initWikiDbMock,
  pinWikiDbMock,
  releaseWikiDbPinMock,
} = vi.hoisted(() => ({
  closeWikiDbMock: vi.fn(),
  getAllFilesMock: vi.fn(),
  getFilesWithExportsMock: vi.fn(),
  initWikiDbMock: vi.fn(),
  pinWikiDbMock: vi.fn(),
  releaseWikiDbPinMock: vi.fn(),
}));

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  initWikiDb: initWikiDbMock,
  closeWikiDb: closeWikiDbMock,
  touchWikiDb: vi.fn(),
  pinWikiDb: pinWikiDbMock,
  getFilesWithExports: getFilesWithExportsMock,
  getAllFiles: getAllFilesMock,
  getIntraModuleCallEdges: vi.fn(),
  getInterModuleCallEdges: vi.fn(),
  getProcessesForFiles: vi.fn(),
  getAllProcesses: vi.fn(),
  getInterModuleEdgesForOverview: vi.fn(),
}));

vi.mock('../../src/core/wiki/html-viewer.js', () => ({
  generateHTMLViewer: vi.fn().mockResolvedValue(''),
}));

describe('WikiGenerator DB pinning', () => {
  let tmpDir: string;
  let repoPath: string;
  let storagePath: string;
  let lbugPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-pin-'));
    repoPath = path.join(tmpDir, 'repo');
    storagePath = path.join(repoPath, '.gitnexus');
    lbugPath = path.join(storagePath, 'lbug');

    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.mkdir(path.join(storagePath, 'wiki'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const value = 1;\n');
    await fs.writeFile(lbugPath, '');
    await fs.writeFile(
      path.join(storagePath, 'wiki', 'module_tree.json'),
      JSON.stringify([{ name: 'Core', slug: 'core', files: ['src/index.ts'] }]),
    );

    initWikiDbMock.mockResolvedValue(undefined);
    closeWikiDbMock.mockResolvedValue(undefined);
    releaseWikiDbPinMock.mockReset();
    pinWikiDbMock.mockReturnValue(releaseWikiDbPinMock);
    getFilesWithExportsMock.mockResolvedValue([
      { filePath: 'src/index.ts', symbols: [{ name: 'value', type: 'Variable' }] },
    ]);
    getAllFilesMock.mockResolvedValue(['src/index.ts']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pins the wiki DB for the run and releases the lease before closing', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      lbugPath,
      {
        provider: 'openai',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test',
      },
      { force: true, reviewOnly: true },
    );

    await expect(generator.run()).resolves.toMatchObject({
      mode: 'full',
      pagesGenerated: 0,
    });

    expect(initWikiDbMock).toHaveBeenCalledWith(lbugPath);
    expect(pinWikiDbMock).toHaveBeenCalledTimes(1);
    expect(releaseWikiDbPinMock).toHaveBeenCalledTimes(1);
    expect(closeWikiDbMock).toHaveBeenCalledTimes(1);
    expect(releaseWikiDbPinMock.mock.invocationCallOrder[0]).toBeLessThan(
      closeWikiDbMock.mock.invocationCallOrder[0],
    );
  });
});
