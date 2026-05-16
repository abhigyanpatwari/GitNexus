/**
 * Shared helpers for hook test files (unit + integration).
 */
import { spawnSync } from 'child_process';

export function runHook(
  hookPath: string,
  input: Record<string, any>,
  cwd?: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

export function parseHookOutput(
  stdout: string,
): { hookEventName?: string; additionalContext?: string } | null {
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed.hookSpecificOutput || null;
  } catch {
    return null;
  }
}
