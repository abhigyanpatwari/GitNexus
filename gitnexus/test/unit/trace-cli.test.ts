/**
 * Unit Tests: CLI trace command wiring
 *
 * Tests that traceCommand forwards CLI flags to callTool('trace', ...)
 * with correct parameter names. Mocked LocalBackend — no graph/DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callTool, init } = vi.hoisted(() => ({
  callTool: vi.fn(),
  init: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = init;
    callTool = callTool;
  },
  VALID_NODE_LABELS: new Set(['Function', 'Class', 'Interface', 'Method', 'Constructor']),
}));

vi.mock('node:fs', () => ({ writeSync: vi.fn() }));

vi.mock('../../src/core/lbug/native-check.js', () => ({
  checkLbugNative: () => ({ ok: true }),
}));

import { traceCommand } from '../../src/cli/tool.js';

describe('CLI trace command', () => {
  beforeEach(() => {
    callTool.mockReset();
    callTool.mockResolvedValue({ status: 'ok', hopCount: 1 });
  });

  it('forwards from/to as positional args', async () => {
    await traceCommand('validateUser', 'executeQuery', {});

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        from: 'validateUser',
        to: 'executeQuery',
      }),
    );
  });

  it('forwards --from-uid/--to-uid as from_uid/to_uid', async () => {
    await traceCommand('A', 'B', {
      fromUid: 'uid:A',
      toUid: 'uid:B',
    });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        from_uid: 'uid:A',
        to_uid: 'uid:B',
      }),
    );
  });

  it('forwards --from-file/--to-file as from_file/to_file', async () => {
    await traceCommand('A', 'B', {
      fromFile: 'src/a.ts',
      toFile: 'src/b.ts',
    });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        from_file: 'src/a.ts',
        to_file: 'src/b.ts',
      }),
    );
  });

  it('forwards -f/--file as the source file hint', async () => {
    await traceCommand('A', 'B', {
      file: 'src/a.ts',
    });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        from_file: 'src/a.ts',
      }),
    );
  });

  it('accepts matching --file and --from-file values', async () => {
    await traceCommand('A', 'B', {
      file: 'src/a.ts',
      fromFile: 'src/a.ts',
    });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        from_file: 'src/a.ts',
      }),
    );
  });

  it('exits with usage when --file and --from-file disagree', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(
      traceCommand('A', 'B', { file: 'src/a.ts', fromFile: 'src/other.ts' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('forwards --depth as maxDepth', async () => {
    await traceCommand('A', 'B', { depth: '5' });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({
        maxDepth: 5,
      }),
    );
  });

  it('exits with usage when from is missing and no from_uid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(traceCommand(undefined, 'B', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with usage when --depth is non-numeric instead of forwarding NaN', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(traceCommand('A', 'B', { depth: 'abc' })).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with usage when --from-uid or --to-uid is a swallowed flag value', async () => {
    for (const opts of [{ fromUid: '--oops' }, { toUid: '--oops' }]) {
      callTool.mockReset();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      await expect(traceCommand('A', 'B', opts)).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(callTool).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    }
  });

  it('forwards --include-tests as includeTests', async () => {
    await traceCommand('A', 'B', { includeTests: true });

    expect(callTool).toHaveBeenCalledWith('trace', expect.objectContaining({ includeTests: true }));
  });

  it('parses -f through the real CLI dispatcher', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'gitnexus', 'trace', 'A', 'B', '-f', 'src/a.ts'];
    try {
      vi.resetModules();
      await import('../../src/cli/index.js');
      await vi.waitFor(() => {
        expect(callTool).toHaveBeenCalledWith(
          'trace',
          expect.objectContaining({
            from: 'A',
            to: 'B',
            from_file: 'src/a.ts',
          }),
        );
      });
    } finally {
      process.argv = originalArgv;
    }
  });
});
