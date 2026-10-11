// Real persisted-index safety checks, isolated from other registry/database users.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runFullAnalysis } from '../../dist/core/run-analyze.js';
import { LocalBackend } from '../../dist/mcp/local/local-backend.js';
import * as adapter from '../../dist/core/lbug/lbug-adapter.js';
import { listRegisteredRepos } from '../../dist/storage/repo-manager.js';

const [scenario, temporary, reportPath] = process.argv.slice(2);
const root = path.join(temporary, 'repo');
const sourceDirectory = path.join(root, 'src');
const sourcePath = path.join(sourceDirectory, 'model.ts');
const repo = 'rename-planning-safety';
let backend;

try {
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.copyFile(
    new URL('../fixtures/rename-planning-safety/model.ts', import.meta.url),
    sourcePath,
  );
  const indexed = await runFullAnalysis(
    root,
    {
      force: true,
      useParseCache: false,
      skipGit: true,
      skipFts: true,
      skipSkills: true,
      skipAgentsMd: true,
      embeddings: false,
      pdg: true,
      workerPoolSize: 1,
      registryName: repo,
    },
    { onProgress() {} },
  );
  assert.ok(indexed.stats.nodes > 0);
  assert.equal(indexed.graphWriteCollapsed, undefined);
  const registrations = await listRegisteredRepos({ validate: true });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, repo);
  assert.equal(await fs.realpath(registrations[0].path), await fs.realpath(root));
  await adapter.initLbug(path.join(indexed.storagePath, 'lbug'), { skipFts: true });
  let target;
  try {
    const targets = await adapter.executeQuery(
      "MATCH (n:Function) WHERE n.name = 'target' AND n.filePath = 'src/model.ts' RETURN n.id AS id",
    );
    assert.equal(targets.length, 1);
    target = targets[0].id;
    const calls = await adapter.executeQuery(
      "MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' AND a.name = 'caller' RETURN b.id AS id",
    );
    assert.deepEqual(calls, [{ id: target }]);
  } finally {
    await adapter.closeLbug();
  }

  let expectedCode;
  let expectedPlanning;
  let outsidePath;
  if (scenario === 'unsupported-encoding') {
    await fs.appendFile(sourcePath, Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a]));
    expectedCode = 'unsupported_encoding';
    expectedPlanning = 'unsupported';
  } else {
    assert.equal(scenario, 'symlink-escape');
    const outside = path.join(temporary, 'outside');
    await fs.rename(sourceDirectory, outside);
    await fs.symlink(outside, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    outsidePath = path.join(outside, 'model.ts');
    expectedCode = 'outside_repository';
    expectedPlanning = 'blocked';
  }
  const before = await fs.readFile(sourcePath);
  backend = new LocalBackend();
  assert.equal(await backend.init(), true);
  const request = { repo, symbol_uid: target, new_name: 'renamed' };
  for (const tool of ['rename_preview', 'rename']) {
    const result = await backend.callTool(tool, {
      ...request,
      ...(tool === 'rename' ? { dry_run: false } : {}),
    });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, expectedCode, JSON.stringify(result));
    assert.equal(result.planning_status, expectedPlanning);
    assert.equal(result.application_status, 'not_started');
    assert.equal(result.applied, false);
    assert.equal(result.total_edits, 0);
    assert.equal(result.files_affected, 0);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(await fs.readFile(sourcePath), before);
    if (outsidePath) assert.deepEqual(await fs.readFile(outsidePath), before);
    assert.deepEqual(await fs.readdir(sourceDirectory), ['model.ts']);
  }
  await fs.writeFile(
    reportPath,
    JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes, code: expectedCode }),
  );
} catch (error) {
  await fs.writeFile(
    reportPath,
    JSON.stringify({ status: 'failed', error: error.stack ?? String(error) }),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await backend?.dispose();
  await adapter.closeLbug();
}
