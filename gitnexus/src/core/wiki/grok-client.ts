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
import { logger } from '../logger.js';

export interface GrokConfig {
  model?: string;
  workingDirectory?: string;
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

// Verified live with the denylist + sandbox above: wiki generation completes
// in ~3 turns. 5 leaves headroom without letting a stuck session run away.
const GROK_MAX_TURNS = '5';

let cachedGrokBin: string | null | undefined;

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
  if (cachedGrokBin !== undefined) return cachedGrokBin;
  try {
    execFileSync('grok', ['--version'], { stdio: 'ignore', windowsHide: true });
    cachedGrokBin = 'grok';
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound && err instanceof Error) {
      logger.warn(
        `grok CLI found but --version failed (exit ${(err as { status?: number }).status ?? '?'}). ` +
          'Ensure it is authenticated: run `grok --version` manually.',
      );
    }
    cachedGrokBin = null;
  }
  return cachedGrokBin;
}

export function resolveGrokConfig(overrides?: Partial<GrokConfig>): GrokConfig {
  return {
    model: overrides?.model,
    workingDirectory: overrides?.workingDirectory,
    requestTimeoutMs: overrides?.requestTimeoutMs,
  };
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
    throw new Error('grok CLI returned non-JSON output');
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as { type?: string; message?: string; text?: unknown };
    if (record.type === 'error') {
      throw new Error(record.message || 'grok CLI returned an error');
    }
    if (typeof record.text === 'string') {
      const content = record.text.trim();
      if (!content) {
        throw new Error('grok CLI returned empty output');
      }
      return content;
    }
  }

  throw new Error('grok CLI returned empty output');
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
  const grokBin = detectGrokCLI();
  if (!grokBin) {
    throw new Error(
      'Grok CLI not found. Install Grok Build and ensure `grok` is on PATH. Run `grok login` if unauthenticated.',
    );
  }

  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-grok-'));
  const promptPath = path.join(tempDir, 'prompt.txt');

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

    verboseLog('Spawning:', grokBin, args.join(' ').replace(promptPath, '[prompt-file]'));
    if (config.model) {
      verboseLog('Model:', config.model);
    }

    const content = await runGrok(grokBin, args, tempDir, config, options);
    return { content };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runGrok(
  command: string,
  args: string[],
  cwd: string,
  config: GrokConfig,
  options?: CallLLMOptions,
): Promise<string> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CI: '1',
      },
    });

    verboseLog('Process spawned with PID:', child.pid);

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    };

    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };

    if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs > 0) {
      killTimer = setTimeout(() => {
        killChildTree(child);
        const duration =
          config.requestTimeoutMs! >= 60_000
            ? `${Math.round(config.requestTimeoutMs! / 60_000)}m`
            : `${Math.round(config.requestTimeoutMs! / 1_000)}s`;
        rejectOnce(
          new Error(
            `grok CLI timed out after ${duration}. ` +
              'Increase --timeout or omit it to disable the request timeout.',
          ),
        );
      }, config.requestTimeoutMs);
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
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      verboseLog(
        `Process exited with code ${code} after ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      );

      if (code !== 0) {
        const details = stderr.trim() || stdout.trim();
        rejectOnce(new Error(`grok CLI exited with code ${code}: ${details}`));
        return;
      }
      try {
        resolveOnce(parseGrokOutput(stdout));
      } catch (err) {
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.on('error', (err) => {
      rejectOnce(new Error(`Failed to spawn grok CLI: ${err.message}`));
    });

    child.stdin.end();
  });
}
