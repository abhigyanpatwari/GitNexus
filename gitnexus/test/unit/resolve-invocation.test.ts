import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  formatAnalyzeCommand,
  getNpmMajorVersion,
  resolveInvocationMode,
  warnIfNpm11NpxRisk,
  NPX_REF,
} from '../../src/cli/resolve-invocation.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockedExec = vi.mocked(execFileSync);

describe('resolve-invocation', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_INVOCATION;
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
