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

// Report every byte written, as the real call does; output() loops until all land.
vi.mock('node:fs', () => ({
  writeSync: vi.fn((_fd: number, bytes: Buffer, offset = 0) => bytes.length - offset),
}));

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

  it('forwards a from-name with only --to-uid', async () => {
    await traceCommand('A', undefined, { toUid: 'Function:route.ts:gamma' });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({ from: 'A', to_uid: 'Function:route.ts:gamma' }),
    );
  });

  it('forwards a to-name with only --from-uid', async () => {
    await traceCommand(undefined, 'B', { fromUid: 'Function:route.ts:alpha' });

    expect(callTool).toHaveBeenCalledWith(
      'trace',
      expect.objectContaining({ from_uid: 'Function:route.ts:alpha', to: 'B' }),
    );
  });

  it('exits with usage when to is missing and no to_uid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(traceCommand('A', undefined, {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with usage when to is missing and only from_uid is given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(
      traceCommand('A', undefined, { fromUid: 'Function:route.ts:alpha' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with usage when from is missing and only to_uid is given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(
      traceCommand(undefined, 'B', { toUid: 'Function:route.ts:gamma' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('accepts UID-only endpoints through the real CLI dispatcher (#4124)', async () => {
    const originalArgv = process.argv;
    process.argv = [
      'node',
      'gitnexus',
      'trace',
      '--from-uid',
      'Function:route.ts:alpha',
      '--to-uid',
      'Function:route.ts:gamma',
    ];
    try {
      vi.resetModules();
      await import('../../src/cli/index.js');
      await vi.waitFor(() => {
        expect(callTool).toHaveBeenCalledWith(
          'trace',
          expect.objectContaining({
            from_uid: 'Function:route.ts:alpha',
            to_uid: 'Function:route.ts:gamma',
          }),
        );
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it('exits with usage through the real CLI dispatcher when an endpoint is missing', async () => {
    // Record-only exit mock: a throwing mock would surface as an unhandled
    // rejection because program.parse does not await async actions. The action
    // keeps running after the no-op exit, so callTool is out of scope here.
    // The stderr assertions pin the layer: on base, Commander prints
    // 'error: missing required argument' and calls exit(1) before the handler,
    // which would satisfy a bare exit-code assertion for the wrong reason.
    // Here the handler itself must be what requests exit(1) and prints usage.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let stderr = '';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    const originalArgv = process.argv;
    process.argv = ['node', 'gitnexus', 'trace', 'A'];
    try {
      vi.resetModules();
      await import('../../src/cli/index.js');
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(stderr).toContain('Usage: gitnexus trace');
      expect(stderr).not.toContain('missing required argument');
    } finally {
      process.argv = originalArgv;
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
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
