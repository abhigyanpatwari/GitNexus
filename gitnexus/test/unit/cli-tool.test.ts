import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallTool = vi.fn();
const mockInit = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    callTool = mockCallTool;
    init = mockInit;
  },
}));

const writeSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('CLI tool commands', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit__');
    }) as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockInit.mockResolvedValue(true);
  });

  describe('queryCommand', () => {
    it('errors when queryText is empty', async () => {
      const { queryCommand } = await import('../../src/cli/tool.js');
      await expect(queryCommand('')).rejects.toThrow('__exit__');
      expect(errSpy).toHaveBeenCalledWith('Usage: gitnexus query <search_query>');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('forwards options to callTool and writes result', async () => {
      mockCallTool.mockResolvedValueOnce({ results: ['a', 'b'] });
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('auth flow', {
        repo: 'web',
        context: 'onboarding',
        goal: 'debug',
        limit: '5',
        content: true,
      });

      expect(mockCallTool).toHaveBeenCalledWith('query', {
        query: 'auth flow',
        task_context: 'onboarding',
        goal: 'debug',
        limit: 5,
        include_content: true,
        repo: 'web',
      });
      expect(writeSyncMock).toHaveBeenCalled();
    });

    it('passes include_content=false and limit=undefined by default', async () => {
      mockCallTool.mockResolvedValueOnce({});
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('x');

      expect(mockCallTool).toHaveBeenCalledWith(
        'query',
        expect.objectContaining({ include_content: false, limit: undefined }),
      );
    });
  });

  describe('contextCommand', () => {
    it('errors when both name and uid are empty', async () => {
      const { contextCommand } = await import('../../src/cli/tool.js');
      await expect(contextCommand('')).rejects.toThrow('__exit__');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('gitnexus context'));
    });

    it('accepts uid without a name', async () => {
      mockCallTool.mockResolvedValueOnce({});
      const { contextCommand } = await import('../../src/cli/tool.js');

      await contextCommand('', { uid: 'uid-123' });

      expect(mockCallTool).toHaveBeenCalledWith(
        'context',
        expect.objectContaining({ uid: 'uid-123', name: undefined }),
      );
    });

    it('forwards --file and --content', async () => {
      mockCallTool.mockResolvedValueOnce({});
      const { contextCommand } = await import('../../src/cli/tool.js');

      await contextCommand('validateUser', { file: 'src/auth.ts', content: true });

      expect(mockCallTool).toHaveBeenCalledWith(
        'context',
        expect.objectContaining({
          name: 'validateUser',
          file_path: 'src/auth.ts',
          include_content: true,
        }),
      );
    });
  });

  describe('impactCommand', () => {
    it('errors when target is empty', async () => {
      const { impactCommand } = await import('../../src/cli/tool.js');
      await expect(impactCommand('')).rejects.toThrow('__exit__');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('gitnexus impact'));
    });

    it('defaults direction to upstream and passes depth as integer', async () => {
      mockCallTool.mockResolvedValueOnce({ impacts: [] });
      const { impactCommand } = await import('../../src/cli/tool.js');

      await impactCommand('AuthService', { depth: '3' });

      expect(mockCallTool).toHaveBeenCalledWith(
        'impact',
        expect.objectContaining({
          target: 'AuthService',
          direction: 'upstream',
          maxDepth: 3,
          includeTests: false,
        }),
      );
    });

    it('forwards --direction downstream', async () => {
      mockCallTool.mockResolvedValueOnce({});
      const { impactCommand } = await import('../../src/cli/tool.js');

      await impactCommand('AuthService', { direction: 'downstream' });

      expect(mockCallTool).toHaveBeenCalledWith(
        'impact',
        expect.objectContaining({ direction: 'downstream' }),
      );
    });

    it('emits a structured error object and exits 1 when callTool throws', async () => {
      mockCallTool.mockRejectedValueOnce(new Error('transport failed'));
      const { impactCommand } = await import('../../src/cli/tool.js');

      await expect(impactCommand('AuthService')).rejects.toThrow('__exit__');
      expect(writeSyncMock).toHaveBeenCalled();
      const firstWrite = writeSyncMock.mock.calls[0][1] as string;
      expect(firstWrite).toContain('transport failed');
      expect(firstWrite).toContain('AuthService');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('cypherCommand', () => {
    it('errors when query is empty', async () => {
      const { cypherCommand } = await import('../../src/cli/tool.js');
      await expect(cypherCommand('')).rejects.toThrow('__exit__');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('gitnexus cypher'));
    });

    it('forwards --repo option', async () => {
      mockCallTool.mockResolvedValueOnce({ rows: [] });
      const { cypherCommand } = await import('../../src/cli/tool.js');

      await cypherCommand('MATCH (n) RETURN n', { repo: 'my-repo' });

      expect(mockCallTool).toHaveBeenCalledWith('cypher', {
        query: 'MATCH (n) RETURN n',
        repo: 'my-repo',
      });
    });
  });

  describe('getBackend singleton + init failure', () => {
    it('errors and exits 1 when backend init returns false', async () => {
      mockInit.mockResolvedValueOnce(false);
      const { queryCommand } = await import('../../src/cli/tool.js');

      await expect(queryCommand('x')).rejects.toThrow('__exit__');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No indexed repositories found'));
    });

    it('reuses the same backend across calls', async () => {
      mockCallTool.mockResolvedValue({});
      const { queryCommand, cypherCommand } = await import('../../src/cli/tool.js');

      await queryCommand('a');
      await cypherCommand('MATCH (n) RETURN n');

      expect(mockInit).toHaveBeenCalledTimes(1);
    });
  });

  describe('output() EPIPE fallback', () => {
    it('falls back to stderr and does not crash when stdout write throws non-EPIPE', async () => {
      writeSyncMock.mockImplementationOnce(() => {
        const err = new Error('broken pipe') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });
      mockCallTool.mockResolvedValueOnce({ ok: true });
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('x');

      expect(stderrSpy).toHaveBeenCalled();
    });

    it('exits cleanly (0) on EPIPE write failure', async () => {
      writeSyncMock.mockImplementationOnce(() => {
        const err = new Error('EPIPE') as NodeJS.ErrnoException;
        err.code = 'EPIPE';
        throw err;
      });
      mockCallTool.mockResolvedValueOnce({ ok: true });
      const { queryCommand } = await import('../../src/cli/tool.js');

      await expect(queryCommand('x')).rejects.toThrow('__exit__');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
