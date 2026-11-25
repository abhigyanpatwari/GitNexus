import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { walkRepositoryPaths } from '../../../../src/core/ingestion/filesystem-walker.js';

it('traverses top-level and nested parts directories when explicitly unignored (#2673)', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'gn-walker-parts-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await cp(
    new URL(
      '../../../../test/fixtures/compiler-conformance/java-unignored-parts/',
      import.meta.url,
    ),
    repo,
    { recursive: true },
  );
  await mkdir(path.join(repo, 'node_modules/pkg'), { recursive: true });
  await writeFile(path.join(repo, 'node_modules/pkg/index.js'), 'module.exports = {};');
  const paths = (await walkRepositoryPaths(repo)).map((file) => file.path.replaceAll('\\', '/'));
  assert.ok(paths.includes('parts/src/main/java/com/example/Part.java'));
  assert.ok(
    paths.includes('admin/src/main/java/com/example/controller/parts/PartsController.java'),
  );
  assert.ok(paths.every((file) => !file.includes('node_modules/')));
});
