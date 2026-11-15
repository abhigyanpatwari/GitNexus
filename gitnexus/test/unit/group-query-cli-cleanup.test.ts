import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const groupQueryMock = vi.fn();
const disconnectMock = vi.fn();
const disposeMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    disconnect = disconnectMock;
    dispose = disposeMock;
    getGroupService() {
      return { groupQuery: groupQueryMock };
    }
  },
}));

describe('group query CLI cleanup', () => {
  beforeEach(() => {
    initMock.mockReset().mockResolvedValue(true);
    groupQueryMock.mockReset().mockResolvedValue({ results: [], per_repo: [] });
    disconnectMock.mockReset().mockResolvedValue(undefined);
    disposeMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('disconnects the backend after a successful query', async () => {
    const { registerGroupCommands } = await import('../../src/cli/group.js');
    const program = new Command().exitOverride();
    registerGroupCommands(program);

    await program.parseAsync(['node', 'gitnexus', 'group', 'query', 'team', 'auth flow']);

    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(disposeMock).not.toHaveBeenCalled();
  });

  it('disconnects the backend when a group query fails', async () => {
    groupQueryMock.mockRejectedValue(new Error('query failed'));
    const { registerGroupCommands } = await import('../../src/cli/group.js');
    const program = new Command().exitOverride();
    registerGroupCommands(program);

    await expect(
      program.parseAsync(['node', 'gitnexus', 'group', 'query', 'team', 'auth flow']),
    ).rejects.toThrow('query failed');

    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(disposeMock).not.toHaveBeenCalled();
  });
});
