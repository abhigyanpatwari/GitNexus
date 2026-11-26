import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';

/** Populate local workspace links for the compiler in a disposable checkout. */
export function withWorkspacePackages(root, run) {
  const manifest = path.join(root, 'package.json');
  const workspaces = existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).workspaces;
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  const patterns = existsSync(pnpm)
    ? parseYaml(readFileSync(pnpm, 'utf8'))?.packages
    : Array.isArray(workspaces)
      ? workspaces
      : workspaces?.packages;
  if (!patterns?.length) return run(root);
  const scratch = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-workspace-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let result;
  try {
    cpSync(root, scratch, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    const packages = globSync(
      patterns
        .filter((pattern) => !pattern.startsWith('!'))
        .map((pattern) => pattern + '/package.json'),
      {
        cwd: scratch,
        exclude: patterns
          .filter((pattern) => pattern.startsWith('!'))
          .map((pattern) => pattern.slice(1) + '/package.json'),
      },
    );
    for (const entry of packages) {
      const directory = path.dirname(path.join(scratch, entry));
      const { name } = JSON.parse(readFileSync(path.join(scratch, entry), 'utf8'));
      if (!name) continue;
      if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/.test(name))
        throw new Error('Invalid workspace name: ' + name);
      const link = path.join(scratch, 'node_modules', name);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(directory, link, 'junction');
    }
    result = run(scratch);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(cleanup);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
  return result;
}
