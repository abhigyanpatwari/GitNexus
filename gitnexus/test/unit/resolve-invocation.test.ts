import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  getNpmMajorVersion,
  warnIfNpm11NpxRisk,
  NPX_REF,
} from '../../src/cli/resolve-invocation.js';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const mockedExec = vi.mocked(execFileSync);

const cjsRequire = createRequire(import.meta.url);
const CANONICAL_CJS = path.resolve(
  __dirname,
  '..',
  '..',
  'hooks',
  'claude',
  'resolve-analyze-cmd.cjs',
);
const PLUGIN_CJS = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'resolve-analyze-cmd.cjs',
);

interface CjsModule {
  formatAnalyzeCommand: (
    o?: { embeddings?: boolean },
    deps?: { npmMajor?: number | null; pnpmMajor?: number | null; pnpmMinor?: number | null },
  ) => string;
  formatDocumentationDlxCommand: (args: string, o?: { embeddings?: boolean }) => string;
  formatPnpmAllowBuildArgs: (
    o?: { embeddings?: boolean; alwaysAllowBuild?: boolean },
    deps?: { pnpmMajor?: number | null; pnpmMinor?: number | null },
  ) => string[];
  resolveInvocationMode: (
    probe?: (command: string, gitnexusWrapper?: boolean) => string | null,
    deps?: { npmMajor?: number | null; pnpmMajor?: number | null; pnpmPresent?: boolean },
  ) => 'gitnexus' | 'pnpm' | 'npx';
  resolveOnPath: (
    command: string,
    preferExecExt?: boolean,
    opts?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
  ) => string | null;
  buildRunnerArgv: (
    mode: 'gitnexus' | 'pnpm' | 'npx',
    gitnexusArgs: string[],
    deps?: { pnpmMajor?: number | null; pnpmMinor?: number | null },
  ) => { program: string; args: string[] };
  NPX_REF: string;
}

// Require the real shipped artifact — the hook runtime loads this exact file, so
// the tests exercise production code, not a TypeScript mirror of it.
//
// Determinism invariant: createRequire bypasses vitest's node:child_process mock,
// so the only live subprocess this module can run is probeVersion (`npm`/`pnpm
// --version`). resolveOnPath is now spawn-free — a pure PATH scan — so tests pin
// it by passing an injected `{ platform, env }` (never the host PATH). Mode tests
// inject a fake `probe` or force GITNEXUS_INVOCATION; version tests inject `deps`.
// Keep new tests on one of those paths so results never depend on the host.
const cjs = cjsRequire(CANONICAL_CJS) as CjsModule;

describe('resolve-analyze-cmd.cjs (canonical invocation resolver)', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_INVOCATION;
  });

  it('standardizes the invocation ref on gitnexus@latest', () => {
    expect(cjs.NPX_REF).toBe('gitnexus@latest');
  });

  it('formats each forced mode, with and without --embeddings', () => {
    const allow = '--allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter';
    const allowEmb =
      '--allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter --allow-build=onnxruntime-node';
    const cases = [
      ['gitnexus', 'gitnexus analyze', 'gitnexus analyze --embeddings'],
      [
        'pnpm',
        `pnpm ${allow} dlx ${cjs.NPX_REF} analyze`,
        `pnpm ${allowEmb} dlx ${cjs.NPX_REF} analyze --embeddings`,
      ],
      ['npx', `npx ${cjs.NPX_REF} analyze`, `npx ${cjs.NPX_REF} analyze --embeddings`],
    ] as const;
    for (const [mode, plain, withEmbeddings] of cases) {
      process.env.GITNEXUS_INVOCATION = mode;
      expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 11 })).toBe(plain);
      expect(cjs.formatAnalyzeCommand({ embeddings: true }, { pnpmMajor: 11 })).toBe(
        withEmbeddings,
      );
    }
  });

  it('auto-selects global gitnexus first', () => {
    expect(cjs.resolveInvocationMode(() => '/usr/local/bin/gitnexus')).toBe('gitnexus');
  });

  it('auto-selects pnpm on npm 11+ when pnpm is on PATH', () => {
    const probe = (c: string) => (c === 'pnpm' ? '/usr/local/bin/pnpm' : null);
    expect(cjs.resolveInvocationMode(probe, { npmMajor: 11 })).toBe('pnpm');
  });

  it('auto-selects npx on npm 10 even when pnpm is on PATH', () => {
    const probe = (c: string) => (c === 'pnpm' ? '/usr/local/bin/pnpm' : null);
    expect(cjs.resolveInvocationMode(probe, { npmMajor: 10 })).toBe('npx');
  });

  it('auto-selects pnpm when npm is absent (null injected) but pnpm is on PATH', () => {
    // npmMajor:null means "npm absent" and must be honored via the `in` seam —
    // not fall through to the host's real npm (npm 10.x on CI → would route npx).
    const probe = (c: string) => (c === 'pnpm' ? '/usr/local/bin/pnpm' : null);
    expect(cjs.resolveInvocationMode(probe, { npmMajor: null })).toBe('pnpm');
  });

  it('falls back to npx when npm is null-absent and pnpm is also absent', () => {
    expect(cjs.resolveInvocationMode(() => null, { npmMajor: null })).toBe('npx');
  });

  it('falls back to npx when neither global gitnexus nor pnpm is available', () => {
    expect(cjs.resolveInvocationMode(() => null, { npmMajor: 11 })).toBe('npx');
  });

  it('honors pnpmPresent:true — a present-but-unparseable pnpm selects pnpm, not the npx crash path', () => {
    // Windows headline regression guard: when probeVersion cannot read the
    // version (timeout / Corepack banner) but pnpm is on PATH, formatAnalyzeCommand
    // sets pnpmPresent:true so npm-11 users still get pnpm rather than the npx crash.
    expect(cjs.resolveInvocationMode(() => null, { npmMajor: 11, pnpmPresent: true })).toBe('pnpm');
  });

  it('honors pnpmPresent:false as explicit absence (overrides a PATH hit)', () => {
    const probe = (c: string) => (c === 'pnpm' ? '/usr/local/bin/pnpm' : null);
    expect(cjs.resolveInvocationMode(probe, { npmMajor: 11, pnpmPresent: false })).toBe('npx');
  });

  it('omits --allow-build on pnpm 9 (scripts run by default)', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 9 })).toBe(
      `pnpm dlx ${cjs.NPX_REF} analyze`,
    );
  });

  it('includes --allow-build (pre-dlx) on pnpm 10.x with unknown minor (conservative)', () => {
    // No pnpmMinor injected → minor is null → the gate cannot prove < 10.2, so
    // it conservatively emits the flags. This is the unknown-minor fallback, NOT
    // real pnpm 10.0 (which reports minor=0 and is covered separately below).
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    const allow = '--allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter';
    expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 10 })).toBe(
      `pnpm ${allow} dlx ${cjs.NPX_REF} analyze`,
    );
  });

  it('omits --allow-build on pnpm 10.0 (the flag did not exist until 10.2)', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 10, pnpmMinor: 0 })).toBe(
      `pnpm dlx ${cjs.NPX_REF} analyze`,
    );
  });

  it('omits --allow-build on pnpm 10.1 (the flag was added in 10.2)', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 10, pnpmMinor: 1 })).toBe(
      `pnpm dlx ${cjs.NPX_REF} analyze`,
    );
  });

  it('includes --allow-build on pnpm 10.2 (the first minor that accepts the flag)', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    const allow = '--allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter';
    expect(cjs.formatAnalyzeCommand(undefined, { pnpmMajor: 10, pnpmMinor: 2 })).toBe(
      `pnpm ${allow} dlx ${cjs.NPX_REF} analyze`,
    );
  });

  it('emits --allow-build when the pnpm major is null-injected (absent/unknown)', () => {
    expect(cjs.formatPnpmAllowBuildArgs({}, { pnpmMajor: null })).toEqual([
      '--allow-build=@ladybugdb/core',
      '--allow-build=gitnexus',
      '--allow-build=tree-sitter',
    ]);
  });

  it('formatDocumentationDlxCommand always includes allow-build for committed docs', () => {
    expect(cjs.formatDocumentationDlxCommand('analyze')).toContain('--allow-build=@ladybugdb/core');
    expect(cjs.formatDocumentationDlxCommand('analyze')).toContain('gitnexus@latest analyze');
  });

  it('lets GITNEXUS_INVOCATION override the probe without consulting it', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    const probe = vi.fn(() => '/usr/local/bin/gitnexus');
    expect(cjs.resolveInvocationMode(probe)).toBe('pnpm');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('warnIfNpm11NpxRisk (#1939 npm-11 nudge)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_INVOCATION;
  });

  it('exposes the resolver contract the load-time guard enforces', () => {
    // The module's createRequire guard throws at load if the cjs export shape
    // drifts; that this module imported at all (and these hold) proves it passed.
    expect(typeof NPX_REF).toBe('string');
    expect(typeof getNpmMajorVersion).toBe('function');
    expect(typeof warnIfNpm11NpxRisk).toBe('function');
  });

  it('parses the npm major version', () => {
    mockedExec.mockReturnValue('11.5.2\n');
    expect(getNpmMajorVersion()).toBe(11);
  });

  it('handles edge npm --version output (pre-release / empty / non-numeric)', () => {
    mockedExec.mockReturnValue('12.0.0-pre\n');
    expect(getNpmMajorVersion()).toBe(12);
    mockedExec.mockReturnValue('\n');
    expect(getNpmMajorVersion()).toBeNull();
    mockedExec.mockReturnValue('not-a-version\n');
    expect(getNpmMajorVersion()).toBeNull();
  });

  it('tolerates a Corepack/notice banner line before the version', () => {
    mockedExec.mockReturnValue(
      'Corepack is about to download https://registry.npmjs.org/npm/-/npm-11.0.0.tgz\n11.0.0\n',
    );
    expect(getNpmMajorVersion()).toBe(11);
  });

  it('passes a shell on Windows so the .cmd npm shim resolves (load-bearing for the warning)', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockedExec.mockReturnValue('11.0.0\n');
      getNpmMajorVersion();
      expect(mockedExec).toHaveBeenCalledWith(
        'npm',
        ['--version'],
        expect.objectContaining({ shell: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  it('uses no shell on POSIX (direct PATH lookup)', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockedExec.mockReturnValue('11.0.0\n');
      getNpmMajorVersion();
      expect(mockedExec).toHaveBeenCalledWith(
        'npm',
        ['--version'],
        expect.objectContaining({ shell: false }),
      );
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  it('warns on the npm 11+ npx path', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockReturnValue('11.0.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('node.target is null');
    expect(String(write.mock.calls[0]?.[0])).toContain('--allow-build=@ladybugdb/core');
    expect(String(write.mock.calls[0]?.[0])).toContain(`gitnexus@latest analyze`);
    write.mockRestore();
  });

  it('does not warn when a global gitnexus or pnpm is preferred', () => {
    process.env.GITNEXUS_INVOCATION = 'pnpm';
    mockedExec.mockReturnValue('11.0.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('does not warn when a global gitnexus is preferred', () => {
    process.env.GITNEXUS_INVOCATION = 'gitnexus';
    mockedExec.mockReturnValue('11.0.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('does not warn when npm is older than 11', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockReturnValue('10.9.0\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('does not warn when npm is absent', () => {
    process.env.GITNEXUS_INVOCATION = 'npx';
    mockedExec.mockImplementation(() => {
      throw new Error('missing');
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfNpm11NpxRisk();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});

describe('buildRunnerArgv (project-local runner exec, #1945)', () => {
  it('passes gitnexus args straight through for the global-binary mode', () => {
    expect(cjs.buildRunnerArgv('gitnexus', ['group', 'list'])).toEqual({
      program: 'gitnexus',
      args: ['group', 'list'],
    });
  });

  it('prefixes the registry ref for npx mode', () => {
    expect(cjs.buildRunnerArgv('npx', ['analyze'])).toEqual({
      program: 'npx',
      args: ['gitnexus@latest', 'analyze'],
    });
  });

  it('builds the pre-`dlx` --allow-build invocation for pnpm mode', () => {
    // Inject a pnpm version >= 10.2 so the allow-build flags are emitted without
    // a live `pnpm --version` probe.
    const { program, args } = cjs.buildRunnerArgv('pnpm', ['analyze'], {
      pnpmMajor: 10,
      pnpmMinor: 14,
    });
    expect(program).toBe('pnpm');
    // Flags must precede `dlx` (ERR_PNPM_SPEC_NOT_SUPPORTED otherwise, #1939).
    const dlxIdx = args.indexOf('dlx');
    expect(dlxIdx).toBeGreaterThan(0);
    expect(args.slice(0, dlxIdx)).toEqual([
      '--allow-build=@ladybugdb/core',
      '--allow-build=gitnexus',
      '--allow-build=tree-sitter',
    ]);
    expect(args.slice(dlxIdx)).toEqual(['dlx', 'gitnexus@latest', 'analyze']);
  });

  it('widens the pnpm allow-build set when --embeddings is requested', () => {
    const { args } = cjs.buildRunnerArgv('pnpm', ['analyze', '--embeddings'], {
      pnpmMajor: 10,
      pnpmMinor: 14,
    });
    expect(args).toContain('--allow-build=onnxruntime-node');
  });

  it('widens the allow-build set for the --embeddings=N equals form too', () => {
    const { args } = cjs.buildRunnerArgv('pnpm', ['analyze', '--embeddings=5000'], {
      pnpmMajor: 10,
      pnpmMinor: 14,
    });
    expect(args).toContain('--allow-build=onnxruntime-node');
  });

  it('omits onnxruntime-node when --embeddings is absent', () => {
    const { args } = cjs.buildRunnerArgv('pnpm', ['analyze'], { pnpmMajor: 10, pnpmMinor: 14 });
    expect(args).not.toContain('--allow-build=onnxruntime-node');
  });
});

describe('resolveOnPath — pure-Node PATH scan (#1938, all-OS, spawn-free)', () => {
  const tmpDirs: string[] = [];
  const mkBinDir = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'resolve-path-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  });

  it('finds an executable launcher on a POSIX PATH', () => {
    const dir = mkBinDir();
    const bin = path.join(dir, 'gitnexus');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    expect(cjs.resolveOnPath('gitnexus', true, { platform: 'linux', env: { PATH: dir } })).toBe(
      bin,
    );
  });

  // X_OK is meaningless on Windows (every file reads as accessible), so this
  // POSIX-only guarantee can only be asserted on a POSIX host.
  it.skipIf(process.platform === 'win32')(
    'skips a non-executable file on POSIX (requires X_OK)',
    () => {
      const dir = mkBinDir();
      writeFileSync(path.join(dir, 'gitnexus'), 'not executable'); // intentionally no chmod +x
      expect(
        cjs.resolveOnPath('gitnexus', true, { platform: 'linux', env: { PATH: dir } }),
      ).toBeNull();
    },
  );

  it('returns null when the launcher is absent or PATH is empty', () => {
    const dir = mkBinDir();
    expect(
      cjs.resolveOnPath('gitnexus', true, { platform: 'linux', env: { PATH: dir } }),
    ).toBeNull();
    expect(cjs.resolveOnPath('gitnexus', true, { platform: 'linux', env: {} })).toBeNull();
  });

  it('honors PATHEXT on Windows (a .cmd shim is detected)', () => {
    const dir = mkBinDir();
    const bin = path.join(dir, 'gitnexus.cmd');
    writeFileSync(bin, '@echo off\r\n');
    // The PATHEXT entry case matches the fixture so the assertion is deterministic
    // on case-sensitive CI filesystems; real Windows is case-insensitive, so the
    // casing of PATHEXT vs the on-disk shim never matters there.
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.cmd' },
      }),
    ).toBe(bin);
  });

  it('does not treat a .ps1-only shim as on PATH when PATHEXT excludes .PS1', () => {
    // A .ps1 is not launchable as `gitnexus` without a shell and is absent from
    // default PATHEXT, so mirroring `where`/cmd.exe (PATHEXT-driven) avoids a hint
    // that would fail when run.
    const dir = mkBinDir();
    writeFileSync(path.join(dir, 'gitnexus.ps1'), 'exit 0');
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      }),
    ).toBeNull();
  });

  it('on Windows ignores a bare extensionless file and returns the PATHEXT shim', () => {
    // Windows matches PATHEXT extensions only — an extensionless `gitnexus` is not
    // launchable as `gitnexus` from a shell, so when both exist the .cmd shim wins
    // and the bare file is never the result (it would be an un-spawnable hint).
    const dir = mkBinDir();
    writeFileSync(path.join(dir, 'gitnexus'), 'not a shim');
    const cmd = path.join(dir, 'gitnexus.cmd');
    writeFileSync(cmd, '@echo off\r\n');
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.cmd' },
      }),
    ).toBe(cmd);
  });

  it('on Windows returns null for an extensionless-only file (not in PATHEXT)', () => {
    const dir = mkBinDir();
    writeFileSync(path.join(dir, 'gitnexus'), 'not a shim');
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      }),
    ).toBeNull();
  });

  it('with preferExecExt, prefers a .cmd/.exe shim over an exotic .COM hit, but accepts .COM alone', () => {
    // preferExecExt mirrors the old `where` wrapper preference: a recognized
    // .cmd/.bat/.exe wins over a .COM, yet a lone .COM is still detected (better a
    // resolvable hint than none). Fixture/PATHEXT cases match for CI determinism.
    const both = mkBinDir();
    writeFileSync(path.join(both, 'gitnexus.com'), 'x');
    const cmd = path.join(both, 'gitnexus.cmd');
    writeFileSync(cmd, '@echo off\r\n');
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: both, PATHEXT: '.com;.cmd' },
      }),
    ).toBe(cmd);

    const comOnly = mkBinDir();
    const com = path.join(comOnly, 'gitnexus.com');
    writeFileSync(com, 'x');
    expect(
      cjs.resolveOnPath('gitnexus', true, {
        platform: 'win32',
        env: { PATH: comOnly, PATHEXT: '.com;.cmd' },
      }),
    ).toBe(com);
  });
});

describe('formatAnalyzeCommand end-to-end via the pure scan (#1938)', () => {
  // Exercises the public entry through resolveOnPath against a real PATH (no
  // mocks, no GITNEXUS_INVOCATION): with a launcher on PATH the hint resolves to
  // `gitnexus analyze`. Because resolveOnPath is now spawn-free, this works
  // identically on every OS — there is no `where`/`which` reachability caveat.
  const savedPath = process.env.PATH;
  let binDir: string | undefined;
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (binDir) rmSync(binDir, { recursive: true, force: true });
    binDir = undefined;
    delete process.env.GITNEXUS_INVOCATION;
  });

  it('resolves `gitnexus analyze` when a launcher is the only thing on PATH', () => {
    binDir = mkdtempSync(path.join(os.tmpdir(), 'gn-e2e-'));
    const isWin = process.platform === 'win32';
    const launcher = path.join(binDir, isWin ? 'gitnexus.cmd' : 'gitnexus');
    writeFileSync(launcher, isWin ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    if (!isWin) chmodSync(launcher, 0o755);
    // PATH reduced to just the launcher dir — the former `where`/`which` resolver
    // would have ENOENT'd here; the pure scan finds the launcher directly.
    process.env.PATH = binDir;
    expect(cjs.formatAnalyzeCommand()).toBe('gitnexus analyze');
  });
});

describe('resolve-analyze-cmd.cjs parity', () => {
  it('keeps the two CJS hook copies byte-identical', () => {
    expect(readFileSync(CANONICAL_CJS, 'utf-8')).toBe(readFileSync(PLUGIN_CJS, 'utf-8'));
  });
});

describe('CLI module-load posture (R3/R4 regression guard)', () => {
  const cliDir = path.resolve(__dirname, '..', '..', 'src', 'cli');

  it('does not probe invocation hints at index.ts module load (#207/#1383)', () => {
    const indexSrc = readFileSync(path.join(cliDir, 'index.ts'), 'utf-8');
    // Every command — including the `gitnexus mcp` stdio server — pays index.ts
    // module load. warnIfNpm11NpxRisk()/PATH probing must stay out of module
    // scope, or it reintroduces the startup-spawn regression (#207, #1383).
    expect(indexSrc).not.toMatch(/warnIfNpm11NpxRisk/);
    expect(indexSrc).not.toMatch(/resolve-invocation/);
  });

  it('wires the npm-11 warning into the analyze command instead', () => {
    const analyzeSrc = readFileSync(path.join(cliDir, 'analyze.ts'), 'utf-8');
    expect(analyzeSrc).toMatch(/warnIfNpm11NpxRisk\(\)/);
  });
});
