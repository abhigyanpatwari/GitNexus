/**
 * Regression test for the buffered-pino + hard-exit diagnostic-loss bug
 * (Codex adversarial review on PR #1336, plan 002).
 *
 * Symptom before the fix: `gitnexus tool query <foo>` with no indexed
 * repos exits non-zero with EMPTY stderr — the `logger.error()` call was
 * routed through pino's `sync: false` SonicBoom buffer, and the
 * subsequent synchronous `process.exit(1)` killed the process before the
 * buffer could drain. Operators saw a silent failure.
 *
 * The fix routes user-facing CLI diagnostics through `cliError` (in
 * `gitnexus/src/cli/cli-message.ts`), which writes plain text directly
 * to `process.stderr` AND tees a structured pino record. Direct stderr
 * writes don't go through the buffer, so they survive `process.exit`.
 *
 * This test spawns the built CLI in a child process and asserts the
 * diagnostic line reaches stderr before exit. Without the fix it fails;
 * with the fix it passes. Characterization-first contract, locked in
 * end-to-end against `dist/`.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

const CHILD_TIMEOUT_MS = process.env.CI ? 20_000 : 10_000;

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built `gitnexus` CLI with arguments, wait for exit, and
 * return captured streams + exit code. Pin GITNEXUS_HOME to a fresh
 * empty temp dir so the LocalBackend init reliably finds zero indexed
 * repos. Force NODE_OPTIONS empty to prevent host-environment overrides
 * from changing buffer / heap behavior (plan 001 U3 added the buffered
 * destination, which is what this test guards against).
 */
function runCli(args: string[]): Promise<ChildResult> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cli-no-index-'));
  return new Promise<ChildResult>((resolve, reject) => {
    const proc = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GITNEXUS_HOME: tmpHome,
        NODE_OPTIONS: '',
        // Force NDJSON path: pino-pretty only activates when stderr is a
        // TTY and !CI && !VITEST. spawn() pipes stderr, so it's not a
        // TTY in this child anyway, but the explicit env is defense-in-depth.
        CI: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`child process exceeded ${CHILD_TIMEOUT_MS}ms timeout`));
    }, CHILD_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Best-effort cleanup of the empty temp home; ignore errors so they
      // don't mask test failures.
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('CLI tool query — diagnostic survives hard exit (plan 002)', () => {
  it('emits the no-index diagnostic to stderr before exit code 1', async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(
        `dist/cli/index.js missing — run \`npm run build\` first (or use \`npm run test:integration\` which builds via pretest:integration).`,
      );
    }

    const result = await runCli(['query', 'whatever']);

    // Without the plan-002 fix, stderr was empty. The diagnostic must be
    // visible regardless of how `process.exit(1)` interacts with the
    // buffered pino destination.
    expect(result.stderr).toContain('No indexed repositories found');
    expect(result.stderr).toContain('gitnexus analyze');

    // Exit code stays 1 — we're only changing the message channel, not
    // the failure semantics.
    expect(result.exitCode).toBe(1);

    // Stdout should not carry the diagnostic. CLI tool data is reserved
    // for stdout (e.g., `gitnexus query | jq`); diagnostics are stderr.
    expect(result.stdout).not.toContain('No indexed repositories found');
  }, 30_000);
});
