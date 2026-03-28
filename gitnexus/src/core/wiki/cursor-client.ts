/**
 * Cursor CLI Client for Wiki Generation
 *
 * Wrapper for the Cursor headless CLI (`agent` command).
 * Uses print mode for non-interactive LLM calls.
 *
 * Docs: https://cursor.com/docs/cli/headless
 */

import { spawn, execSync } from 'child_process';
import type { LLMResponse, CallLLMOptions } from './llm-client.js';

export interface CursorConfig {
  model?: string;
  workingDirectory?: string;
}

function isVerbose(): boolean {
  return process.env.GITNEXUS_VERBOSE === '1';
}

function verboseLog(...args: unknown[]): void {
  if (isVerbose()) {
    console.log('[cursor-cli]', ...args);
  }
}

let cachedCursorBin: string | null | undefined;

/**
 * Detect if Cursor CLI is available in PATH.
 * Returns the binary name if found ('agent'), null otherwise.
 * Result is cached after the first call.
 */
export function detectCursorCLI(): string | null {
  if (cachedCursorBin !== undefined) return cachedCursorBin;
  try {
    execSync('agent --version', { stdio: 'ignore' });
    cachedCursorBin = 'agent';
  } catch {
    cachedCursorBin = null;
  }
  return cachedCursorBin;
}

/**
 * Resolve Cursor CLI configuration.
 * Model is optional - if not provided, Cursor CLI uses its default (auto).
 */
export function resolveCursorConfig(overrides?: Partial<CursorConfig>): CursorConfig {
  return {
    model: overrides?.model,
    workingDirectory: overrides?.workingDirectory,
  };
}

/**
 * Call the Cursor CLI in print mode.
 *
 * Uses `agent -p --output-format text` for clean non-streaming output.
 * The prompt is passed as the final CLI argument.
 */
export async function callCursorLLM(
  prompt: string,
  config: CursorConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const cursorBin = detectCursorCLI();
  if (!cursorBin) {
    throw new Error(
      'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation',
    );
  }

  // Always use text format to get clean output without agent narration/thinking.
  // stream-json captures assistant messages which include "Let me explore..." narration
  // that pollutes the actual content when using thinking models.
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

  const args = ['-p', '--output-format', 'text'];

  if (config.model) {
    args.push('--model', config.model);
  }

  // Add the prompt as the final argument
  args.push(fullPrompt);

  verboseLog(
    'Spawning:',
    cursorBin,
    args.slice(0, -1).join(' '),
    '[prompt length:',
    fullPrompt.length,
    'chars]',
  );
  verboseLog('Working directory:', config.workingDirectory || process.cwd());
  if (config.model) {
    verboseLog('Model:', config.model);
  } else {
    verboseLog('Model: auto (default)');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cursorBin, args, {
      cwd: config.workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure non-interactive mode
        CI: '1',
      },
    });

    verboseLog('Process spawned with PID:', child.pid);

    let stdout = '';
    let stderr = '';

    // Text mode - collect all output, report progress based on output size
    child.stdout.on('data', (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      stdout += chunkStr;
      verboseLog(`[stdout] received ${chunkStr.length} chars, total: ${stdout.length}`);

      // Report progress if callback provided
      if (options?.onChunk) {
        options.onChunk(stdout.length);
      }
    });

    child.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      verboseLog(`Process exited with code ${code} after ${elapsed}s`);
      verboseLog(`stdout length: ${stdout.length} chars`);

      if (code !== 0) {
        verboseLog('stderr:', stderr);
        reject(new Error(`Cursor CLI exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ content: stdout.trim() });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      stderr += chunkStr;
      verboseLog('[stderr]', chunkStr.trim());
    });

    child.on('error', (err) => {
      verboseLog('Spawn error:', err.message);
      reject(new Error(`Failed to spawn Cursor CLI: ${err.message}`));
    });

    // Close stdin immediately since we pass prompt as argument
    child.stdin.end();
  });
}
