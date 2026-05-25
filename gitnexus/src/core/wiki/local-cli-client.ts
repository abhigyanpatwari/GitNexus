/**
 * Local agent CLI clients for wiki generation.
 *
 * These providers use the user's authenticated local CLI session instead of
 * an OpenAI-compatible HTTP API.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { LLMResponse, CallLLMOptions } from './llm-client.js';

import { logger } from '../logger.js';

export type LocalAgentProvider = 'claude' | 'codex';

export interface LocalCLIConfig {
  model?: string;
  workingDirectory?: string;
  requestTimeoutMs?: number;
}

const COMMANDS: Record<LocalAgentProvider, string> = {
  claude: 'claude',
  codex: 'codex',
};

interface LocalCommand {
  displayName: string;
  command: string;
  argsPrefix: string[];
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

function isVerbose(): boolean {
  return process.env.GITNEXUS_VERBOSE === '1';
}

function verboseLog(provider: LocalAgentProvider, ...args: unknown[]): void {
  if (isVerbose()) {
    logger.info({ provider, args }, '[local-cli]');
  }
}

const cachedCommands = new Map<LocalAgentProvider, LocalCommand | null>();

export function detectLocalCLI(provider: LocalAgentProvider): string | null {
  if (cachedCommands.has(provider)) return cachedCommands.get(provider)?.displayName ?? null;
  const commandInfo = resolveLocalCommand(provider);
  try {
    execFileSync(commandInfo.command, [...commandInfo.argsPrefix, '--version'], {
      stdio: 'ignore',
    });
    cachedCommands.set(provider, commandInfo);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound && err instanceof Error) {
      logger.warn(
        `${provider} CLI found but --version failed (exit ${(err as { status?: number }).status ?? '?'}). ` +
          `Ensure it is authenticated: run \`${COMMANDS[provider]} --version\` manually.`,
      );
    }
    cachedCommands.set(provider, null);
  }
  return cachedCommands.get(provider)?.displayName ?? null;
}

export function resolveLocalCLIConfig(overrides?: Partial<LocalCLIConfig>): LocalCLIConfig {
  return {
    model: overrides?.model,
    workingDirectory: overrides?.workingDirectory,
    requestTimeoutMs: overrides?.requestTimeoutMs,
  };
}

export async function callClaudeLLM(
  prompt: string,
  config: LocalCLIConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const commandInfo = getDetectedCommand('claude');
  if (!commandInfo) {
    throw new Error('Claude CLI not found. Install Claude Code and ensure `claude` is on PATH.');
  }

  const args = ['-p', '--output-format', 'text', '--no-session-persistence'];
  if (config.model) {
    args.push('--model', config.model);
  }
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

  const response = await runLocalCLI('claude', commandInfo, args, config, fullPrompt, options);
  if (!response.content) {
    throw new Error('claude CLI returned empty output');
  }
  return response;
}

export async function callCodexLLM(
  prompt: string,
  config: LocalCLIConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const commandInfo = getDetectedCommand('codex');
  if (!commandInfo) {
    throw new Error('Codex CLI not found. Install Codex CLI and ensure `codex` is on PATH.');
  }

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-codex-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  const workingDirectory = config.workingDirectory || process.cwd();
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  const args = [
    'exec',
    '--cd',
    workingDirectory,
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--color',
    'never',
    '--output-last-message',
    outputPath,
  ];

  if (config.model) {
    args.push('--model', config.model);
  }
  args.push('-');

  try {
    const response = await runLocalCLI('codex', commandInfo, args, config, fullPrompt, options);
    const lastMessage = await fs.readFile(outputPath, 'utf-8').catch(() => '');
    const content = (lastMessage || response.content).trim();
    if (!content) {
      throw new Error('codex CLI returned empty output');
    }
    return { content };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runLocalCLI(
  provider: LocalAgentProvider,
  commandInfo: LocalCommand,
  args: string[],
  config: LocalCLIConfig,
  stdinText?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const finalArgs = [...commandInfo.argsPrefix, ...args];
  verboseLog(
    provider,
    'Spawning:',
    commandInfo.command,
    maskPromptArgs(provider, finalArgs).join(' '),
  );
  verboseLog(provider, 'Working directory:', config.workingDirectory || process.cwd());
  if (config.model) {
    verboseLog(provider, 'Model:', config.model);
  } else {
    verboseLog(provider, 'Model: default');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(commandInfo.command, finalArgs, {
      cwd: config.workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CI: '1',
      },
    });

    verboseLog(provider, 'Process spawned with PID:', child.pid);

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdinError: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    };

    const resolveOnce = (response: LLMResponse) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(response);
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
            `${provider} CLI timed out after ${duration}. ` +
              'Increase --timeout or omit it to disable the request timeout.',
          ),
        );
      }, config.requestTimeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const chunkStr = stdoutDecoder.write(chunk);
      stdout += chunkStr;
      verboseLog(provider, `[stdout] received ${chunkStr.length} chars, total: ${stdout.length}`);
      options?.onChunk?.(stdout.length);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const chunkStr = stderrDecoder.write(chunk);
      stderr += chunkStr;
      verboseLog(provider, '[stderr]', chunkStr.trim());
    });

    child.stdin.on('error', (err: Error) => {
      stdinError = err;
      verboseLog(provider, 'stdin error:', err.message);
    });

    child.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      verboseLog(provider, `Process exited with code ${code} after ${elapsed}s`);

      if (code !== 0) {
        const details = stderr.trim() || stdinError?.message || stdout.trim();
        rejectOnce(new Error(`${provider} CLI exited with code ${code}: ${details}`));
        return;
      }
      if (stdinError) {
        rejectOnce(new Error(`${provider} CLI stdin error: ${stdinError.message}`));
        return;
      }
      resolveOnce({ content: stdout.trim() });
    });

    child.on('error', (err) => {
      rejectOnce(new Error(`Failed to spawn ${provider} CLI: ${err.message}`));
    });

    child.stdin.end(stdinText);
  });
}

function maskPromptArgs(provider: LocalAgentProvider, args: string[]): string[] {
  if (provider === 'codex') {
    return args.map((arg) => (arg === '-' ? '[stdin prompt]' : arg));
  }
  return args;
}

function getDetectedCommand(provider: LocalAgentProvider): LocalCommand | null {
  detectLocalCLI(provider);
  return cachedCommands.get(provider) ?? null;
}

function resolveLocalCommand(provider: LocalAgentProvider): LocalCommand {
  const displayName = COMMANDS[provider];
  if (process.platform !== 'win32') {
    return { displayName, command: displayName, argsPrefix: [] };
  }

  const npmBin = findWindowsCommand(`${displayName}.cmd`) || findWindowsCommand(displayName);
  if (npmBin) {
    const binDir = path.dirname(npmBin);
    if (provider === 'claude') {
      const exePath = path.join(
        binDir,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      );
      if (existsSync(exePath)) {
        return { displayName, command: exePath, argsPrefix: [] };
      }
    }

    if (provider === 'codex') {
      const scriptPath = path.join(binDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(scriptPath)) {
        return { displayName, command: process.execPath, argsPrefix: [scriptPath] };
      }
    }
  }

  // Last-resort fallback for non-npm Windows installations that only expose a
  // .cmd shim. Prompts are passed via stdin, so repo content is not placed on
  // the command line.
  return {
    displayName,
    command: process.env.ComSpec || 'cmd.exe',
    argsPrefix: ['/d', '/s', '/c', displayName],
  };
}

function findWindowsCommand(command: string): string | null {
  try {
    const output = execFileSync('where.exe', [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}
