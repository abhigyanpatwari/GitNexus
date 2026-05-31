import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  formatAnalyzeCommand,
  getNpmMajorVersion,
  resolveGitnexusBin,
  resolveInvocationMode,
  warnIfNpm11NpxRisk,
  resetInvocationStateForTests,
  NPX_REF,
} from '../../src/cli/resolve-invocation.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockedExec = vi.mocked(execFileSync);

describe('resolve-invocation', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_INVOCATION;
    // Clear the memoized mode + once-only warning flag so neither leaks into
    // the next test (static top-level imports mean vi.resetModules alone would
    // not rebind them).
    resetInvocationStateForTests();
  });

  it('standardizes the invocation ref on gitnexus@latest', () => {
    expect(NPX_REF).toBe('gitnexus@latest');
  });

  it('forces invocation mode via GITNEXUS_INVOCATION', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    expect(resolveInvocationMode()).toBe('pnpm');
    expect(formatAnalyzeCommand()).toBe(`pnpm dlx ${NPX_REF} analyze`);
    expect(formatAnalyzeCommand({ embeddings: true })).toBe(
      `pnpm dlx ${NPX_REF} analyze --embeddings`,
    );
  });

  it('prefers global gitnexus binary on PATH', () => {
    mockedExec.mockReturnValue('/usr/local/bin/gitnexus\n');
    expect(resolveInvocationMode()).toBe('gitnexus');
    expect(formatAnalyzeCommand()).toBe('gitnexus analyze');
  });

  it('falls back to pnpm dlx before npx when pnpm is on PATH', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      const bin = args[0];
      if (bin === 'gitnexus') throw new Error('missing');
      if (bin === 'pnpm') return '/usr/local/bin/pnpm\n';
      throw new Error(`unexpected ${bin}`);
    });
    expect(resolveInvocationMode()).toBe('pnpm');
    expect(formatAnalyzeCommand()).toBe(`pnpm dlx ${NPX_REF} analyze`);
  });

  it('uses pinned npx when neither gitnexus nor pnpm is available', () => {
    mockedExec.mockImplementation(() => {
      throw new Error('missing');
    });
    expect(resolveInvocationMode()).toBe('npx');
    expect(formatAnalyzeCommand()).toBe(`npx ${NPX_REF} analyze`);
  });

  it('parses npm major version', () => {
    mockedExec.mockReturnValue('11.5.2\n');
    expect(getNpmMajorVersion()).toBe(11);
  });

  it('warns once on npm 11+ npx path', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockReturnValue('11.0.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    warnIfNpm11NpxRisk();
    warnIfNpm11NpxRisk();

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('node.target is null');
    expect(String(write.mock.calls[0]?.[0])).toContain('pnpm dlx');
  });

  it('memoizes PATH probing across repeated resolveInvocationMode calls', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      const bin = args[0];
      if (bin === 'gitnexus') throw new Error('missing');
      if (bin === 'pnpm') return '/usr/local/bin/pnpm\n';
      throw new Error(`unexpected ${bin}`);
    });

    expect(resolveInvocationMode()).toBe('pnpm');
    const callsAfterFirst = mockedExec.mock.calls.length;
    expect(resolveInvocationMode()).toBe('pnpm');
    expect(resolveInvocationMode()).toBe('pnpm');
    // No additional PATH probes after the first resolution.
    expect(mockedExec.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not warn when the resolved mode is not npx', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    mockedExec.mockReturnValue('11.0.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not warn when npm is older than 11', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockReturnValue('10.9.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not warn when npm is absent', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockImplementation(() => {
      throw new Error('missing');
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('resolve-analyze-cmd.cjs parity', () => {
  it('keeps the two CJS hook copies byte-identical', () => {
    const inRepo = path.resolve(
      __dirname,
      '..',
      '..',
      'hooks',
      'claude',
      'resolve-analyze-cmd.cjs',
    );
    const plugin = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'gitnexus-claude-plugin',
      'hooks',
      'resolve-analyze-cmd.cjs',
    );
    expect(readFileSync(inRepo, 'utf-8')).toBe(readFileSync(plugin, 'utf-8'));
  });
});

describe('resolveGitnexusBin Windows shim detection', () => {
  let platformDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    vi.clearAllMocks();
    delete process.env.GITNEXUS_INVOCATION;
    resetInvocationStateForTests();
  });

  it('detects a .exe-only global shim (Volta/scoop) and yields gitnexus analyze', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'gitnexus')
        return 'C:\\Users\\me\\AppData\\Local\\Volta\\bin\\gitnexus.exe\r\n';
      throw new Error('missing');
    });
    expect(resolveGitnexusBin()).toBe('C:\\Users\\me\\AppData\\Local\\Volta\\bin\\gitnexus.exe');
    expect(resolveInvocationMode()).toBe('gitnexus');
    expect(formatAnalyzeCommand()).toBe('gitnexus analyze');
  });

  it('detects an extensionless global shim', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'gitnexus') return 'C:\\tools\\gitnexus\r\n';
      throw new Error('missing');
    });
    expect(resolveGitnexusBin()).toBe('C:\\tools\\gitnexus');
    expect(resolveInvocationMode()).toBe('gitnexus');
  });

  it('still detects a .cmd shim and prefers it over an extensionless sibling', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'gitnexus') return 'C:\\npm\\gitnexus\r\nC:\\npm\\gitnexus.cmd\r\n';
      throw new Error('missing');
    });
    expect(resolveGitnexusBin()).toBe('C:\\npm\\gitnexus.cmd');
  });

  it('strips the CRLF carriage return from where output', () => {
    mockedExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'gitnexus') return 'C:\\npm\\gitnexus.cmd\r\n';
      throw new Error('missing');
    });
    const bin = resolveGitnexusBin();
    expect(bin).not.toMatch(/\r/);
    expect(bin).toBe('C:\\npm\\gitnexus.cmd');
  });
});
