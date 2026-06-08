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

describe('impact-for-symbols CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  it('loads the input JSON file and dispatches caller-supplied symbols', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-impact-symbols-cli-'));
    try {
      const inputPath = path.join(tempDir, 'symbols.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          symbols: [
            {
              id: 'Function:src/app.ts:mapped',
              name: 'mapped',
              type: 'Function',
              filePath: 'src/app.ts',
              startLine: 1,
              endLine: 3,
            },
          ],
        }),
      );
      callToolMock.mockResolvedValue({
        schema_version: 'impact-for-symbols.v1alpha1',
        summary: {
          input_symbols: 1,
          resolved_symbols: 1,
          symbols_with_processes: 1,
          unmapped_symbols: 0,
          unknown_symbols: 0,
          affected_processes: 1,
        },
        symbols: [
          {
            id: 'Function:src/app.ts:mapped',
            name: 'mapped',
            processes: [{ id: 'Process:login-flow', name: 'LoginFlow' }],
          },
        ],
        unmapped_symbols: [],
        unknown_symbols: [],
      });

      const { impactForSymbolsCommand } = await import('../../src/cli/impact-for-symbols.js');

      await impactForSymbolsCommand({ input: inputPath, repo: 'gitnexus-local-features' });

      expect(callToolMock).toHaveBeenCalledWith('impact_for_symbols', {
        repo: 'gitnexus-local-features',
        symbols: [
          {
            id: 'Function:src/app.ts:mapped',
            name: 'mapped',
            type: 'Function',
            filePath: 'src/app.ts',
            startLine: 1,
            endLine: 3,
          },
        ],
      });

      const output: string = writeSyncMock.mock.calls[0][1];
      const parsed = JSON.parse(output);
      expect(parsed.schema_version).toBe('impact-for-symbols.v1alpha1');
      expect(parsed.symbols[0].processes[0].name).toBe('LoginFlow');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
