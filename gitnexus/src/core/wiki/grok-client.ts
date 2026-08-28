/**
 * Grok Build CLI client for wiki generation.
 *
 * Uses headless `grok --prompt-file` so large wiki prompts are not placed on
 * argv or stdin (Grok does not read stdin as the prompt).
 */

import { spawn, execFileSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CallLLMOptions, LLMResponse } from './llm-client.js';
import { resolveWindowsCliCommand, type ResolvedCliCommand } from './local-cli-client.js';
import { logger } from '../logger.js';

export interface GrokConfig {
  model?: string;
  requestTimeoutMs?: number;
}

// Verified live: an empty --tools allowlist does NOT disable the shell tool
// (`run_terminal_cmd`) — Grok still ran `find` across the user's entire home
// directory looking for project context, taking 10+ minutes per call and
// then hitting --max-turns anyway. A denylist naming the tool explicitly is
// what actually blocks it; internal tool IDs, not the CLI-facing names
// (shell is `run_terminal_cmd`, not `bash`).
const GROK_DISALLOWED_TOOLS = 'run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent';

// Defense in depth beyond the tool denylist: a kernel-enforced (Landlock/
// Seatbelt) sandbox so reads/writes stay confined to --cwd (our empty temp
// dir) + system paths even if a future tool slips past the denylist.
const GROK_SANDBOX_PROFILE = 'strict';

// Verified live with the denylist + sandbox above: turn counts vary run to
// run (observed 3-10 across identical prompts, including the large overview
// prompt that aggregates every module's summary). 15 gives real headroom
// over that variance without leaving a runaway session effectively uncapped.
const GROK_MAX_TURNS = '15';

let cachedGrokCommand: ResolvedCliCommand | null | undefined;

function isVerbose(): boolean {
  return process.env.GITNEXUS_VERBOSE === '1';
}

function verboseLog(...args: unknown[]): void {
  if (isVerbose()) {
    logger.info({ args }, '[grok-cli]');
  }
}

function killChildTree(child: import('child_process').ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      // Process may have already exited — fall through to child.kill()
    }
  }
  child.kill();
}

/** Returns `'grok'` when the CLI is on PATH, else null. Cached. */
export function detectGrokCLI(): string | null {
  if (cachedGrokCommand !== undefined) return cachedGrokCommand?.displayName ?? null;
  const resolved = resolveWindowsCliCommand('grok');
  try {
    execFileSync(resolved.command, [...resolved.argsPrefix, '--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    cachedGrokCommand = resolved;
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound && err instanceof Error) {
      logger.warn(
        `grok CLI found but --version failed (exit ${(err as { status?: number }).status ?? '?'}). ` +
          'Ensure it is authenticated: run `grok --version` manually.',
      );
    }
    cachedGrokCommand = null;
  }
  return cachedGrokCommand?.displayName ?? null;
}

function getDetectedGrokCommand(): ResolvedCliCommand | null {
  detectGrokCLI();
  return cachedGrokCommand ?? null;
}

export function resolveGrokConfig(overrides?: Partial<GrokConfig>): GrokConfig {
  return {
    model: overrides?.model,
    requestTimeoutMs: overrides?.requestTimeoutMs,
  };
}

function excerpt(raw: string, max = 200): string {
  const trimmed = raw.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function parseGrokOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('grok CLI returned empty output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`grok CLI returned non-JSON output: ${excerpt(trimmed)}`);
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as {
      type?: string;
      message?: string;
      text?: unknown;
      stopReason?: unknown;
    };
    if (record.type === 'error') {
      throw new Error(record.message || 'grok CLI returned an error');
    }
    if (typeof record.text === 'string') {
      const content = record.text.trim();
      if (!content) {
        throw new Error('grok CLI returned empty text');
      }
      if (record.stopReason !== undefined && record.stopReason !== null) {
        const rawReason = String(record.stopReason);
        if (rawReason && rawReason.toLowerCase() !== 'end_turn') {
          throw new Error(`grok CLI stopped with stopReason=${rawReason}`);
        }
      }
      return content;
    }
    throw new Error(`grok CLI JSON has no text field: ${excerpt(trimmed)}`);
  }

  throw new Error(`grok CLI JSON has no text field: ${excerpt(trimmed)}`);
}

/**
 * Call Grok Build in headless mode and return the assistant text.
 *
 * `--cwd` is an empty temp directory (not the repo) so project AGENTS.md
 * files are not injected into wiki generation.
 */
export async function callGrokLLM(
  prompt: string,
  config: GrokConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const grokCmd = getDetectedGrokCommand();
  if (!grokCmd) {
    throw new Error(
      'Grok CLI not found. Install Grok Build and ensure `grok` is on PATH. Run `grok login` if unauthenticated.',
    );
  }

  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-grok-'));
  const promptPath = path.join(tempDir, 'prompt.txt');
  const childLifecycle = { spawned: false, closed: false };

  try {
    await fs.writeFile(promptPath, fullPrompt, 'utf-8');

    const args = [
      '--prompt-file',
      promptPath,
      '--output-format',
      'json',
      '--max-turns',
      GROK_MAX_TURNS,
      '--no-plan',
      '--no-subagents',
      '--disable-web-search',
      '--disallowed-tools',
      GROK_DISALLOWED_TOOLS,
      '--sandbox',
      GROK_SANDBOX_PROFILE,
      '--cwd',
      tempDir,
    ];
    if (config.model) {
      args.push('--model', config.model);
    }

    verboseLog(
      'Spawning:',
      grokCmd.command,
      [...grokCmd.argsPrefix, ...args].join(' ').replace(promptPath, '[prompt-file]'),
    );
    if (config.model) {
      verboseLog('Model:', config.model);
    }

    const content = await runGrok(
      grokCmd.command,
      [...grokCmd.argsPrefix, ...args],
      tempDir,
      config,
      options,
      childLifecycle,
    );
    return { content };
  } finally {
    // The temp dir is cwd, sandbox root, and prompt-file home. Do not remove it
    // while a live child may still be using it (hard-deadline reject, no close).
    if (!childLifecycle.spawned || childLifecycle.closed) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function runGrok(
  command: string,
  args: string[],
  cwd: string,
  config: GrokConfig,
  options: CallLLMOptions | undefined,
  lifecycle: { spawned: boolean; closed: boolean },
): Promise<string> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      // Grok reads the prompt from --prompt-file, not stdin. An unused stdin
      // pipe can EPIPE-crash the wiki process when grok closes it.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CI: '1',
      },
    });
    lifecycle.spawned = true;

    verboseLog('Process spawned with PID:', child.pid);

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killEscalate: ReturnType<typeof setTimeout> | undefined;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = config.requestTimeoutMs;
    const timeoutError =
      timeoutMs !== undefined && timeoutMs > 0
        ? new Error(
            `grok CLI timed out after ${
              timeoutMs >= 60_000
                ? `${Math.round(timeoutMs / 60_000)}m`
                : `${Math.round(timeoutMs / 1_000)}s`
            }. Increase --timeout or omit it to disable the request timeout.`,
          )
        : undefined;

    const clearKillTimers = () => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (killEscalate !== undefined) clearTimeout(killEscalate);
      if (hardDeadline !== undefined) clearTimeout(hardDeadline);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearKillTimers();
      reject(error);
    };

    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      clearKillTimers();
      resolve(value);
    };

    const KILL_GRACE_MS = 2000;
    if (timeoutMs !== undefined && timeoutMs > 0 && timeoutError) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
        killEscalate = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may have already exited.
          }
          hardDeadline = setTimeout(() => {
            rejectOnce(timeoutError);
          }, KILL_GRACE_MS);
        }, KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const chunkStr = stdoutDecoder.write(chunk);
      stdout += chunkStr;
      options?.onChunk?.(stdout.length);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on('close', (code) => {
      const alreadySettled = settled;
      lifecycle.closed = true;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      verboseLog(
        `Process exited with code ${code} after ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      );

      if (timedOut && timeoutError) {
        rejectOnce(timeoutError);
      } else if (code !== 0) {
        const details = stderr.trim() || stdout.trim();
        rejectOnce(new Error(`grok CLI exited with code ${code}: ${details}`));
      } else {
        try {
          resolveOnce(parseGrokOutput(stdout));
        } catch (err) {
          rejectOnce(err instanceof Error ? err : new Error(String(err)));
        }
      }

      // Hard-deadline reject already left callGrokLLM's finally without rm.
      if (alreadySettled) {
        void fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    child.on('error', (err) => {
      lifecycle.closed = true;
      rejectOnce(new Error(`Failed to spawn grok CLI: ${err.message}`));
    });
  });
}
