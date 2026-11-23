import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const systemTools =
  process.platform === 'win32'
    ? {
        git: ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'],
        tar: ['C:\\Windows\\System32\\tar.exe'],
      }
    : {
        git: ['/usr/bin/git', '/bin/git', '/run/current-system/sw/bin/git'],
        tar: ['/usr/bin/tar', '/bin/tar', '/run/current-system/sw/bin/tar'],
      };

/** The measured checkout and caller's PATH cannot select an executable. */
export function runBenchmarkTool(name, args, options) {
  const candidates = Object.hasOwn(systemTools, name) ? systemTools[name] : [];
  const executable = candidates.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
  if (!executable) throw new Error(`Cannot find ${name} in the system tool directories`);
  return execFileSync(executable, args, { ...options, shell: false });
}
