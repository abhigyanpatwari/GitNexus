import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeWin32Command } from '../../src/core/embeddings/runtime-install.js';

/**
 * Real-spawn round-trip proving the on-demand npm install delivers its args to
 * the child process intact — including shell-dangerous ones — on EVERY platform,
 * via the exact mechanism `installEmbeddingRuntime` uses for that platform (#2372):
 *
 *  - **win32**: `composeWin32Command` + `spawn(string, {shell:true})`, exercising
 *    the full `cmd.exe /c` → `.cmd %*` re-parse → node argv chain (the npm.cmd /
 *    BatBadBut surface). The pure `quoteWin32Arg` tests only check the string
 *    against our *model* of cmd.exe; this checks it against real cmd.exe.
 *  - **linux/macos**: the array form `spawn(cmd, args)` with **no shell**, so the
 *    args reach the child through `execve` untouched — no quoting, no shell to
 *    inject through. This also guards against a regression to `shell:true` on
 *    POSIX (which would let `a&b` split).
 *
 * Runs on all three platforms: the full ubuntu suite covers Linux, and the
 * cross-platform runner (scripts/cross-platform-tests.ts) covers windows + macos.
 */

interface CaptureOpts {
  command: string;
  args?: string[];
  commandLine?: string;
  cwd: string;
  shell: boolean;
}

const capture = (opts: CaptureOpts): Promise<string[]> =>
  new Promise<string[]>((resolve, reject) => {
    const child = opts.shell
      ? spawn(opts.commandLine as string, {
          cwd: opts.cwd,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(opts.command, opts.args as string[], {
          cwd: opts.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`exit ${code}: ${err}`)),
    );
  });

/** Spawn an argv-echo the SAME way installEmbeddingRuntime spawns npm on this platform. */
async function roundTrip(intended: string[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'gnx-argv-'));
  try {
    writeFileSync(
      join(dir, 'echo-argv.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
    );
    if (process.platform === 'win32') {
      // A .cmd shim forwarding %* to node — the same node+%* shape npm.cmd uses,
      // so the batch re-parse layer is genuinely exercised.
      writeFileSync(join(dir, 'echo.cmd'), '@node "%~dp0echo-argv.mjs" %*\r\n');
      return await capture({
        command: 'echo.cmd',
        commandLine: composeWin32Command('echo.cmd', intended),
        cwd: dir,
        shell: true,
      });
    }
    // POSIX: array form, no shell — args reach execve untouched.
    return await capture({
      command: process.execPath,
      args: [join(dir, 'echo-argv.mjs'), ...intended],
      cwd: dir,
      shell: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('embedding-install arg delivery — real spawn round-trip (#2372)', () => {
  it('adversarial args reach the spawned child intact on this platform', async () => {
    // Every class the install spawn must pass through safely — dangerous under
    // BOTH cmd.exe and sh, so surviving intact proves injection-safety on each.
    // (The documented ceilings %VAR% / delayed-! are excluded — no arg-passing
    // scheme neutralizes them.)
    const intended = [
      '--prefix',
      'C:\\Users\\John Doe\\.gitnexus\\embedding-runtime', // whitespace (+ backslashes)
      '@huggingface/transformers@^4.1.0', // caret in a semver range
      'C:\\Users\\John Doe\\rt\\', // trailing backslash + whitespace
      'a&b|c<d>e(f)', // shell metacharacters
    ];
    expect(await roundTrip(intended)).toEqual(intended);
  }, 30_000);
});
