import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: writeSyncMock,
  };
});

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

describe('direct CLI tool commands', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
    callToolMock.mockResolvedValue({ summary: { changed_count: 1 } });
    writeSyncMock.mockReturnValue(0);
  });

  it('dispatches detect_changes with normalized CLI options', async () => {
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({
      repo: 'GitNexus',
      scope: 'compare',
      baseRef: 'main',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'GitNexus',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining('"changed_count": 1'),
    );
  });
});
