/**
 * Lets detect-changes-stderr-child.ts run the real `detect_changes` path
 * without a LadybugDB index.
 *
 * Loaded with `node --import <tsx> --import <this file>` BEFORE the child.
 * The child then imports LocalBackend, which would open the index and read
 * the global registry. Those two modules are swapped for thin wrappers: git
 * diff still runs for real, and the graph query returns no rows.
 *
 * The wrappers re-export the real modules (imported once, with `?bypass=1`
 * so this hook does not recurse) and override only the calls the tool makes
 * before and after `git diff`.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const poolReal = pathToFileURL(path.join(srcRoot, 'core/lbug/pool-adapter.ts')).href;
const repoReal = pathToFileURL(path.join(srcRoot, 'storage/repo-manager.ts')).href;

const POOL_OVERRIDES = new Set(['initLbug', 'executeParameterized', 'executeQuery', 'isLbugReady']);

const REPO_OVERRIDES = new Set(['listRegisteredRepos']);

function reexportLines(names, overridden) {
  const lines = [];
  for (const name of names) {
    if (overridden.has(name) || name === 'default') continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    lines.push(`export const ${name} = real[${JSON.stringify(name)}];`);
  }
  if (names.includes('default') && !overridden.has('default')) {
    lines.push('export default real.default;');
  }
  return lines.join('\n');
}

let poolNames = [];
let repoNames = [];

registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('bypass=1')) return nextLoad(url, context);
    const isPool = url.includes('/core/lbug/pool-adapter.');
    const isRepo = url.includes('/storage/repo-manager.');
    if (!isPool && !isRepo) return nextLoad(url, context);
    if ((isPool && poolNames.length === 0) || (isRepo && repoNames.length === 0)) {
      throw new Error(`detect-changes stderr hook ran before the real module was indexed (${url})`);
    }

    const real = (isPool ? poolReal : repoReal) + '?bypass=1';
    const override = isPool
      ? `
        export const initLbug = async () => {};
        export const executeParameterized = async () => [];
        export const executeQuery = async () => [];
        export const isLbugReady = () => true;
      `
      : `
        export const listRegisteredRepos = async () => {
          const { join } = await import('node:path');
          const repo = process.env.DETECT_CHANGES_REPO;
          if (!repo) throw new Error('DETECT_CHANGES_REPO is not set');
          return [{
            name: 'autocrlf-repo',
            path: repo,
            storagePath: join(repo, '.gitnexus'),
            indexedAt: '2026-01-01T00:00:00.000Z',
            lastCommit: 'abc1234',
            stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
          }];
        };
      `;

    return {
      format: 'module',
      shortCircuit: true,
      source: `import * as real from ${JSON.stringify(real)};\n${override}\n${reexportLines(
        isPool ? poolNames : repoNames,
        isPool ? POOL_OVERRIDES : REPO_OVERRIDES,
      )}\n`,
    };
  },
});

poolNames = Object.keys(await import(poolReal + '?bypass=1'));
repoNames = Object.keys(await import(repoReal + '?bypass=1'));
if (poolNames.length === 0 || repoNames.length === 0) {
  throw new Error('detect-changes stderr hook could not read the real module exports');
}
