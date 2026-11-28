import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Script files can satisfy side-effect imports without declaring a module symbol. */
export function compilerImportTrace(root, config) {
  const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
  const run = spawnSync(
    process.execPath,
    [
      cli,
      '--project',
      config,
      '--listFilesOnly',
      '--traceResolution',
      '--locale',
      'en',
      '--pretty',
      'false',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (run.error) throw run.error;
  assert.equal(run.status, 0, run.stderr || run.stdout.slice(-1000));
  const bySource = new Map();
  let importer;
  let specifier;
  for (const line of run.stdout.split(/\r?\n/)) {
    const start = /^======== Resolving module '(.*)' from '(.*)'\. ========$/.exec(line);
    if (start) {
      [, specifier, importer] = start;
      continue;
    }
    const result =
      /^======== Module name '(.*)' was successfully resolved to '(.*?)'(?: with Package ID '.*')?\. ========$/.exec(
        line,
      );
    if (!importer || result?.[1] !== specifier) continue;
    const from = path.resolve(root, importer);
    if (!bySource.has(from)) bySource.set(from, new Map());
    bySource.get(from).set(specifier, path.resolve(root, result[2]));
    importer = undefined;
  }
  return bySource;
}
