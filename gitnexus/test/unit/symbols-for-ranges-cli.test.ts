import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const { initMock, callToolMock, writeSyncMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  callToolMock: vi.fn(),
  writeSyncMock: vi.fn(),
}));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeSync: writeSyncMock,
  };
});

describe('symbols-for-ranges CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  it('loads the input JSON file and dispatches caller-supplied ranges', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-symbol-ranges-cli-'));
    try {
      const inputPath = path.join(tempDir, 'ranges.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          ranges: [
            {
              filePath: 'src/app.ts',
              startLine: 2,
              endLine: 4,
              side: 'new',
              changeType: 'modified',
            },
          ],
        }),
      );
      callToolMock.mockResolvedValue({
        schema_version: 'symbols-for-ranges.v1alpha1',
        summary: { input_ranges: 1, matched_symbols: 1, unmatched_ranges: 0 },
        symbols: [
          {
            id: 'Function:src/app.ts:mapped',
            name: 'mapped',
          },
        ],
        unmatched_ranges: [],
      });

      const { symbolsForRangesCommand } = await import('../../src/cli/symbols-for-ranges.js');

      await symbolsForRangesCommand({ input: inputPath, repo: 'gitnexus-local-features' });

      expect(callToolMock).toHaveBeenCalledWith('symbols_for_ranges', {
        repo: 'gitnexus-local-features',
        ranges: [
          {
            filePath: 'src/app.ts',
            startLine: 2,
            endLine: 4,
            side: 'new',
            change_type: 'modified',
          },
        ],
      });

      const output: string = writeSyncMock.mock.calls[0][1];
      const parsed = JSON.parse(output);
      expect(parsed.schema_version).toBe('symbols-for-ranges.v1alpha1');
      expect(parsed.symbols[0].name).toBe('mapped');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
