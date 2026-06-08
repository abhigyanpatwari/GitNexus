/**
 * Unit Tests: server-discovery — binary resolution for LSP servers.
 *
 * Decision-table coverage for the 4 resolution sources
 * (node_modules/.bin | PATH | npx | absent) plus the spec-level
 * guarantees (version parsing, no installs).
 *
 * Strategy: mock `child_process` and `fs` via `vi.mock`, drive
 * each branch with a hoisted state object, and assert the public
 * `discoverServers()` contract end-to-end. `parseVersion` is
 * also unit-tested directly so the parsing logic is locked
 * down independently of the spawn plumbing.
 *
 * Isolation: tests use `discoverOne(bin, { cwd })` whenever they
 * need a clean directory tree (the staged binaries live in
 * /var/folders tmp dirs). The public `discoverServers()`
 * surface is exercised in one test that stages its binary
 * inside the project's actual cwd tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync as mockedExecFileSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Hoisted mock state ────────────────────────────────────────────────
//
// vi.hoisted() lets the mock factories (which run at module-load
// time, before vi.mock) share state with the test bodies (which
// run after imports). The factories only know the SHAPE of the
// state; the bodies fill it in per-test.

const { spawnBehavior, fsFiles, npxCalls, execFileCalls } = vi.hoisted(() => ({
  /**
   * Per-cmd response map. Key = the command name passed to
   * execFileSync. Value = the function that returns stdout for
   * that command, or throws to simulate "not found" / non-zero
   * exit / npx package missing.
   */
  spawnBehavior: new Map<string, (args: string[]) => string>(),

  /**
   * Mocked-on-disk files. Keys are absolute paths; presence
   * means `fs.statSync` reports a regular file.
   */
  fsFiles: new Set<string>(),

  /** All npx invocations recorded (cmd + args). */
  npxCalls: [] as Array<{ cmd: string; args: string[] }>,

  /** All execFileSync invocations recorded, for install-grep. */
  execFileCalls: [] as Array<{ cmd: string; args: string[] }>,
}));

// Mutable test fixtures — plain `let` bindings so the test
// bodies can flip them per-test. Cleared in beforeEach.
let npxResponse: string | null = null;

// ─── Mock factories ───────────────────────────────────────────────────

vi.mock('child_process', () => ({
  // Single dispatch: look up the cmd in spawnBehavior; if missing,
  // throw (mimicking "command not found"). Each test registers
  // exactly the responses it needs; an absent test registers none.
  execFileSync: vi.fn((cmd: string, args: any) => {
    const a = (args ?? []) as string[];
    execFileCalls.push({ cmd, args: a });
    if (cmd === 'npx') {
      npxCalls.push({ cmd, args: a });
      // npxResponse null = "no successful npx result registered"
      // — fall through to the spawn map, which throws when no
      // handler is registered. npxResponse set = return that
      // verbatim as stdout (success path).
      if (npxResponse !== null) return npxResponse;
    }
    const handler = spawnBehavior.get(cmd);
    if (!handler) {
      const e: any = new Error(`spawn ${cmd} ENOENT`);
      e.code = 'ENOENT';
      e.status = 127;
      throw e;
    }
    return handler(a);
  }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // The implementation imports `fs` as a default import
  // (`import fs from 'fs'`) which under esModuleInterop resolves
  // to the namespace. We must mock BOTH the namespace AND the
  // default export so both call-sites get the same mocked fn.
  const statSyncMock = vi.fn((p: string) => {
    const abs = path.resolve(p);
    if (fsFiles.has(abs)) {
      return { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false };
    }
    const e: any = new Error(`ENOENT: no such file or directory, stat '${p}'`);
    e.code = 'ENOENT';
    throw e;
  });
  const existsSyncMock = vi.fn((p: string) => fsFiles.has(path.resolve(p)));
  return {
    ...actual,
    statSync: statSyncMock,
    existsSync: existsSyncMock,
    default: { ...actual, statSync: statSyncMock, existsSync: existsSyncMock },
  };
});

// ─── Imports under test ───────────────────────────────────────────────

import {
  discoverServers,
  discoverOne,
  parseVersion,
  TYPESCRIPT_LANGUAGE_SERVER_BIN,
} from '../../../src/core/ingestion/lsp/server-discovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function stageBinary(absPath: string): void {
  fsFiles.add(path.resolve(absPath));
}

function registerSpawn(cmd: string, handler: (args: string[]) => string): void {
  spawnBehavior.set(cmd, handler);
}

beforeEach(() => {
  spawnBehavior.clear();
  fsFiles.clear();
  npxCalls.length = 0;
  execFileCalls.length = 0;
  npxResponse = null;
  // Re-apply default impl to `execFileSync` — some tests override
  // it with mockImplementation and we must restore the factory
  // behavior between tests.
  (mockedExecFileSync as any).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('server-discovery', () => {
  describe('discoverServers (public surface)', () => {
    it('exports the expected signature', () => {
      expect(typeof discoverServers).toBe('function');
    });

    it('returns the documented result shape on success', async () => {
      // discoverServers() uses process.cwd() — stage the binary
      // in the project's existing node_modules/.bin so the
      // walker finds it without us having to override cwd.
      // The gitnexus project doesn't ship the binary, so we
      // add a synthetic entry to fsFiles for its notional path.
      const projectNmBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(projectNmBin);
      registerSpawn(projectNmBin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverServers();

      expect(result).toEqual({
        typescript: { path: projectNmBin, version: '4.3.3' },
      });
    });
  });

  describe('decision table: resolution source', () => {
    // ── 1) node_modules/.bin ────────────────────────────────────────
    it('resolves from node_modules/.bin (walking up from cwd)', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-nm-'));
      const nestedCwd = path.join(projectRoot, 'src', 'core');
      fs.mkdirSync(nestedCwd, { recursive: true });
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: nestedCwd });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(bin);
      expect(result!.version).toBe('4.3.3');
      // Sanity: the binary was spawned with `--version` exactly.
      const versionCall = execFileCalls.find(
        (c) => c.cmd === bin && c.args[0] === '--version',
      );
      expect(versionCall).toBeDefined();

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('walks up multiple levels to find a node_modules', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-deep-'));
      const deep = path.join(projectRoot, 'a', 'b', 'c', 'd', 'e');
      fs.mkdirSync(deep, { recursive: true });
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => '4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: deep });
      expect(result?.path).toBe(bin);

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    // ── 2) PATH fallback ────────────────────────────────────────────
    it('falls back to PATH (which/where) when node_modules has nothing', async () => {
      const fakeBin = '/fake/bin/typescript-language-server';
      stageBinary(fakeBin);
      registerSpawn(fakeBin, () => 'typescript-language-server 5.0.0 (commit abc)\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${fakeBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/cwd/that/definitely/has/no/node_modules',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(fakeBin);
      expect(result!.version).toBe('5.0.0');
    });

    it('PATH fallback handles multi-match where output (uses first line)', async () => {
      const fakeBin1 = '/fake/bin/typescript-language-server';
      const fakeBin2 = '/usr/local/bin/typescript-language-server';
      stageBinary(fakeBin1);
      stageBinary(fakeBin2);
      registerSpawn(fakeBin1, () => 'typescript-language-server 4.3.3\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${fakeBin1}\n${fakeBin2}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result!.path).toBe(fakeBin1);
    });

    // ── 3) npx fallback ─────────────────────────────────────────────
    it('falls back to npx when node_modules and PATH both miss', async () => {
      // SECURITY FIX: tryNpx() no longer synthesizes a
      // DiscoveredServer from the npx binary path. It still
      // runs the npx version probe for diagnostics, but only
      // returns a DiscoveredServer when it can subsequently
      // resolve the actual typescript-language-server binary
      // on disk (via whichOnPath). To simulate that, we stage
      // both the npx binary AND a real typescript-language-server
      // binary that the post-probe PATH lookup will find.
      const npxBin = '/usr/local/bin/npx';
      const tsBin = '/opt/npx-cache/typescript-language-server';
      stageBinary(npxBin);
      stageBinary(tsBin);
      npxResponse = 'typescript-language-server 4.3.3\n';
      // whichOnPath(binaryName) is the post-probe resolution
      // — register `which` to return the staged ts server.
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${tsBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.version).toBe('4.3.3');
      // The returned path is the verified language server, NOT
      // the npx binary — this is the security-critical invariant.
      expect(result!.path).toBe(tsBin);
      expect(result!.path).not.toBe(npxBin);
      // npx was actually invoked with --no-install + the binary.
      expect(npxCalls.length).toBe(1);
      expect(npxCalls[0].args).toEqual(['--no-install', TYPESCRIPT_LANGUAGE_SERVER_BIN, '--version']);
    });

    it('returns null from npx branch when the post-probe PATH resolution fails', async () => {
      // npx probe succeeds (npx found the package), but the
      // subsequent whichOnPath('typescript-language-server')
      // fails — no real binary on disk. tryNpx() must return
      // null rather than synthesize a DiscoveredServer from
      // the npx path. This is the MAJOR security finding fix.
      npxResponse = 'typescript-language-server 4.3.3\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);
      // Deliberately do NOT stage any typescript-language-server
      // binary, and do NOT register a `which` handler — both
      // resolution attempts must return null.

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).toBeNull();
      // Sanity: npx was attempted (diagnostic probe ran), but
      // no DiscoveredServer was returned.
      expect(npxCalls.length).toBe(1);
    });

    it('never returns the npx binary path as the DiscoveredServer.path', async () => {
      // Even when npx succeeds and the post-probe resolution
      // finds a binary, the returned `path` field must be the
      // verified language server — not the npx launcher.
      const npxBin = '/usr/local/bin/npx';
      const tsBin = '/usr/local/lib/node_modules/.bin/typescript-language-server';
      stageBinary(npxBin);
      stageBinary(tsBin);
      npxResponse = 'typescript-language-server 4.3.3\n';
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${tsBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).not.toMatch(/npx/);
      expect(result!.path).toBe(tsBin);
    });

    // ── 4) absent everywhere ────────────────────────────────────────
    it('returns null when the server is absent everywhere (no throw)', async () => {
      // Stage nothing, register nothing — every spawn throws.
      // discoverOne must not throw and must return null.
      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();
    });

    it('discoverServers returns { typescript: null } when absent', async () => {
      // Force a guaranteed-empty cwd by stubbing the project's
      // real node_modules tree. We do this by NOT staging any
      // file at the project's notional path — the test before
      // this one that needed to stage one ran with `stageBinary`
      // and we cleared `fsFiles` in beforeEach.
      const result = await discoverServers();
      expect(result).toEqual({ typescript: null });
    });

    it('never throws on any failure path (sync + async safety)', async () => {
      const result = await discoverServers();
      expect(result).toBeDefined();
      expect(result.typescript).toBeNull();
    });
  });

  describe('parseVersion (defensive parser)', () => {
    // ── 5) version parsing ──────────────────────────────────────────
    it('extracts a clean x.y.z version', () => {
      expect(parseVersion('typescript-language-server 4.3.3')).toBe('4.3.3');
    });

    it('strips a leading v prefix', () => {
      expect(parseVersion('v4.3.3')).toBe('4.3.3');
    });

    it('handles x.y.z (commit hash) suffixes', () => {
      expect(parseVersion('typescript-language-server 4.3.3 (commit abc1234)')).toBe('4.3.3');
    });

    it('handles 4-part versions (4.3.3.1)', () => {
      expect(parseVersion('typescript-language-server 4.3.3.1')).toBe('4.3.3.1');
    });

    it('handles 2-part versions (1.0)', () => {
      expect(parseVersion('typescript-language-server 1.0')).toBe('1.0');
    });

    it('falls back to "unknown" on garbage input', () => {
      expect(parseVersion('something completely unparseable')).toBe('unknown');
      expect(parseVersion('')).toBe('unknown');
      expect(parseVersion('\n\n')).toBe('unknown');
    });

    it('integrates with discoverOne (version parsed from --version stdout)', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-ver-'));
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: projectRoot });
      expect(result?.version).toBe('4.3.3');

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
  });

  describe('no-install guarantee', () => {
    // ── 6) never installs ───────────────────────────────────────────
    it('does not invoke npm install / npm i / yarn add / pnpm add', async () => {
      // The implementation should NEVER spawn a package manager
      // mutator. The only npx invocations allowed use the
      // `--no-install` flag. (We assert against the bare-arg
      // form to avoid false positives on the flag itself.)
      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();

      for (const call of execFileCalls) {
        const argv = [call.cmd, ...(call.args ?? [])].join(' ').toLowerCase();
        // No bare "install" subcommand (npm install / yarn install / pnpm install)
        expect(argv, `discover must not invoke: ${argv}`).not.toMatch(/(^|\s)(npm|yarn|pnpm)\s+install\b/);
        // No `npm i <pkg>`, `yarn add <pkg>`, or `pnpm add <pkg>`
        expect(argv, `discover must not invoke: ${argv}`).not.toMatch(/(^|\s)(npm\s+i|yarn\s+add|pnpm\s+add)\b\s+\S+/);
      }
    });

    it('npx fallback uses --no-install (no side-effect download)', async () => {
      npxResponse = 'typescript-language-server 4.3.3\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);

      await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      // The npx invocation MUST include --no-install to prevent
      // a stray download when the binary is missing.
      expect(npxCalls.length).toBe(1);
      expect(npxCalls[0].args).toContain('--no-install');
    });

    it('never writes to the filesystem (no fs.writeFile, no fs.mkdir)', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const rmSpy = vi.spyOn(fs, 'rmSync');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();

      expect(writeSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolution-source priority', () => {
    it('node_modules wins over PATH when both are available', async () => {
      // Stage BOTH: a node_modules binary AND a PATH binary.
      // The node_modules one must win (lower-numbered source).
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-prio-'));
      const nmBin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      const pathBin = '/opt/bin/typescript-language-server';
      stageBinary(nmBin);
      stageBinary(pathBin);

      registerSpawn(nmBin, () => 'typescript-language-server 9.9.9\n');
      registerSpawn(pathBin, () => 'typescript-language-server 1.0.0\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${pathBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: projectRoot,
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(nmBin);
      expect(result!.version).toBe('9.9.9');

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('PATH wins over npx when both are available', async () => {
      const pathBin = '/opt/bin/typescript-language-server';
      stageBinary(pathBin);
      registerSpawn(pathBin, () => 'typescript-language-server 5.0.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${pathBin}\n`);

      // If the impl falls through to npx, npxCalls would grow.
      npxResponse = 'typescript-language-server 1.0.0\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pathBin);
      expect(result!.version).toBe('5.0.0');
      // npx must NOT have been called.
      expect(npxCalls.length).toBe(0);
    });
  });
});
