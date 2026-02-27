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
