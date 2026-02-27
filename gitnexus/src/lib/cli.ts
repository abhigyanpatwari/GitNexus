import { execFileSync } from 'child_process';

const whichCmd = process.platform === 'win32' ? 'where' : 'which';

/** Check if a CLI tool is available on PATH. */
export function isCLIAvailable(tool: string): boolean {
  try {
    execFileSync(whichCmd, [tool], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a copy of process.env with all CLAUDE* vars removed.
 * Prevents "nested session" detection when spawning claude CLI
 * from inside a Claude Code session.
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE')) delete env[key];
  }
  return env;
}
