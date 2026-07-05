import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeWin32Command } from '../../src/core/embeddings/runtime-install.js';

/**
 * Real-cmd.exe round-trip for the win32 install quoting (#2372).
 *
 * The pure `quoteWin32Arg` tests only assert the composed string matches our
 * *model* of cmd.exe — a wrong model would pass. This test proves the quoting
 * survives the actual parse chain the npm spawn goes through: `cmd.exe /c` →
 * a `.cmd` shim's `%*` re-parse (exactly what `npm.cmd` does — the BatBadBut
 * surface a plain-exe round-trip would skip) → node's CRT argv parse. If any
 * quoting rule is wrong for real cmd.exe, the argv node receives diverges from
 * what we intended and this fails.
 *
 * Windows-only (no cmd.exe elsewhere); registered in `scripts/cross-platform-tests.ts`
 * so it runs on real windows-latest, skipped on the POSIX runners.
 */
const win32It = process.platform === 'win32' ? it : it.skip;

describe('win32 npm-install arg quoting — real cmd.exe round-trip (#2372)', () => {
  win32It(
    'adversarial args survive cmd.exe -> .cmd %* -> node argv intact',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gnx-win32-quote-'));
      try {
        // Prints the argv it actually received, so we can compare to intent.
        writeFileSync(
          join(dir, 'echo-argv.mjs'),
          'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
        );
        // A .cmd shim that forwards %* to node — the same node+%* shape npm.cmd
        // uses, so the second (batch) parse layer is genuinely exercised.
        writeFileSync(join(dir, 'echo.cmd'), '@node "%~dp0echo-argv.mjs" %*\r\n');

        // Every class the quoting claims to handle (the documented ceilings
        // %VAR% / delayed-! are deliberately excluded — quoting can't close them).
        const intended = [
          '--prefix',
          'C:\\Users\\John Doe\\.gitnexus\\embedding-runtime', // whitespace
          '@huggingface/transformers@^4.1.0', // caret in a semver range
          'C:\\Users\\John Doe\\rt\\', // trailing backslash + whitespace
          'a&b|c<d>e(f)', // shell metacharacters
        ];
        const commandLine = composeWin32Command('echo.cmd', intended);

        const received = await new Promise<string[]>((resolve, reject) => {
          const child = spawn(commandLine, {
            cwd: dir,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
          child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0
              ? resolve(JSON.parse(out) as string[])
              : reject(new Error(`echo.cmd exited ${code}: ${err}`)),
          );
        });

        expect(received).toEqual(intended);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
