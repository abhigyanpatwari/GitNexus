// Run one fixture in its own process: real registry, persisted index, and public tools.
// Build first (`npm run build`); no compiler or test-runner API is loaded by this runner.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runFullAnalysis } from '../../dist/core/run-analyze.js';
import { LocalBackend } from '../../dist/mcp/local/local-backend.js';
import * as adapter from '../../dist/core/lbug/lbug-adapter.js';
import { getStoragePaths, listRegisteredRepos, loadMeta } from '../../dist/storage/repo-manager.js';

const [fixtureDirectory, temporaryDirectory, reportPath] = process.argv.slice(2);
const specification = JSON.parse(
  await fs.readFile(path.join(fixtureDirectory, 'case.json'), 'utf8'),
);
const root = path.join(temporaryDirectory, 'repo');
const repo = 'rename-fixture';
let backend;

async function files(directory, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(result, await files(path.join(directory, entry.name), relative));
    else result[relative] = await fs.readFile(path.join(directory, entry.name), 'utf8');
  }
  return result;
}

async function assertSources(expected) {
  for (const [file, source] of Object.entries(expected)) {
    assert.equal(
      await fs.readFile(path.join(root, file), 'utf8'),
      source,
      `Unexpected contents: ${file}`,
    );
  }
}

async function index(useParseCache = false) {
  const result = await runFullAnalysis(
    root,
    {
      force: true,
      useParseCache,
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
  assert.equal(result.graphWriteCollapsed, undefined);
  assert.ok(result.stats.nodes > 0, 'Index must contain real parsed nodes');
  const parseCache = {
    hitFileCount: result.pipelineResult.parseCacheHitFileCount,
    reparsedFileCount: result.pipelineResult.reparsedFileCount,
    usedWorkerPool: result.pipelineResult.usedWorkerPool,
  };
  if (useParseCache) {
    assert.ok(parseCache.hitFileCount > 0, 'Warm indexing must load real cached captures');
    assert.equal(parseCache.reparsedFileCount, 0, 'Warm indexing must not reparse sources');
    assert.equal(parseCache.usedWorkerPool, false, 'Warm indexing must bypass parse workers');
  }
  const storage = getStoragePaths(root);
  const meta = await loadMeta(storage.storagePath);
  assert.ok(meta?.pdg, 'Real indexing must produce PDG metadata');
  assert.equal(meta.graphWriteCollapsed, undefined);
  assert.equal(meta.incrementalInProgress, undefined);
  assert.equal(meta.scopeExtractionReceipt, 1, 'Every grammar must be available');
  assert.equal(meta.scopeExtractionFailures?.total ?? 0, 0);
  const registrations = await listRegisteredRepos({ validate: true });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, repo);
  assert.equal(await fs.realpath(registrations[0].path), await fs.realpath(root));
  assert.equal(
    await fs.realpath(registrations[0].storagePath),
    await fs.realpath(result.storagePath),
  );
  await adapter.initLbug(storage.lbugPath, { skipFts: true });
  try {
    const nodes = await adapter.executeQuery(
      'MATCH (n) WHERE n.filePath IS NOT NULL RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS startLine',
    );
    const edges = await adapter.executeQuery(
      'MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS source, b.id AS target, r.type AS type',
    );
    return {
      nodes: nodes.map((node) => ({ ...node, kind: node.id.split(':')[0] })),
      edges,
      parseCache,
    };
  } finally {
    await adapter.closeLbug();
  }
}

function select(nodes, selector) {
  const matches = nodes.filter((node) =>
    Object.entries(selector).every(([key, value]) => node[key] === value),
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one indexed symbol for ${JSON.stringify(selector)}; got ${JSON.stringify(matches)}; nearby: ${JSON.stringify(nodes.filter((node) => node.name === selector.name || node.file === selector.file))}`,
  );
  return matches[0];
}

function assertEdges(graph, expected, exactOutgoing = false) {
  for (const edge of expected) {
    assert.ok(
      graph.edges.some(
        (actual) =>
          actual.type === edge.type &&
          actual.source === edge.source.id &&
          actual.target === edge.target.id,
      ),
      `Missing persisted ${edge.type}: ${JSON.stringify(edge.source)} -> ${JSON.stringify(edge.target)}`,
    );
    if (exactOutgoing) {
      const actualTargets = graph.edges
        .filter((actual) => actual.type === edge.type && actual.source === edge.source.id)
        .map((actual) => actual.target);
      const expectedTargets = expected
        .filter((other) => other.type === edge.type && other.source.id === edge.source.id)
        .map((other) => other.target.id);
      assert.deepEqual(
        [...new Set(actualTargets)].sort(),
        [...new Set(expectedTargets)].sort(),
        `Unexpected persisted ${edge.type} targets from ${JSON.stringify(edge.source)}`,
      );
    }
  }
}

try {
  const before = await files(path.join(fixtureDirectory, 'before'));
  const after = await files(path.join(fixtureDirectory, 'after'));
  assert.deepEqual(
    Object.keys(before).sort(),
    Object.keys(after).sort(),
    'Every source needs an explicit expected snapshot',
  );
  await fs.cp(path.join(fixtureDirectory, 'before'), root, { recursive: true });
  let graph = await index();
  const target = select(graph.nodes, specification.target);
  const expectedEdges = (specification.edges ?? []).map((edge) => ({
    type: edge.type,
    source: select(graph.nodes, edge.from),
    target: select(graph.nodes, edge.to),
  }));
  assertEdges(graph, expectedEdges, specification.exactOutgoing);
  if (specification.warmParseCache === true) {
    const warm = await index(true);
    assert.deepEqual(
      select(warm.nodes, specification.target),
      target,
      'Warm indexing must preserve the persisted target identity',
    );
    assertEdges(warm, expectedEdges, specification.exactOutgoing);
    graph = warm;
  }
  backend = new LocalBackend();
  assert.equal(await backend.init(), true);
  const request = { repo, symbol_uid: target.id, new_name: specification.newName };
  const preview = await backend.callTool('rename_preview', request);
  assert.equal(preview.status, specification.expect.status, JSON.stringify(preview));
  await assertSources(before);
  const applied = await backend.callTool('rename', { ...request, dry_run: false });
  assert.equal(applied.status, specification.expect.status, JSON.stringify(applied));
  if (specification.expect.status === 'success') {
    assert.equal(preview.applied, false);
    assert.equal(preview.total_edits, specification.expect.edits, JSON.stringify(preview));
    assert.equal(applied.applied, true);
    assert.equal(applied.total_edits, specification.expect.edits);
    assert.deepEqual(applied.changes, preview.changes, 'Apply must execute the previewed edits');
  } else {
    for (const result of [preview, applied]) {
      assert.equal(result.code, specification.expect.code, JSON.stringify(result));
      assert.equal(result.planning_status, specification.expect.planningStatus);
      assert.equal(result.total_edits, 0);
      assert.equal(result.applied, false);
    }
    assert.deepEqual(after, before, 'Refused operations must retain all source bytes');
  }
  await assertSources(after);
  await backend.dispose();
  backend = undefined;
  if (specification.expect.status === 'success') {
    const reindexed = await index();
    select(reindexed.nodes, {
      ...specification.target,
      name: specification.expectedTargetName ?? specification.newName,
    });
    // Names/IDs may change across the entire family; declaration positions do not.
    const corresponding = (node) =>
      select(reindexed.nodes, {
        file: node.file,
        kind: node.kind,
        startLine: node.startLine,
      });
    assertEdges(
      reindexed,
      expectedEdges.map((edge) => ({
        type: edge.type,
        source: corresponding(edge.source),
        target: corresponding(edge.target),
      })),
      specification.exactOutgoing,
    );
  }
  await fs.writeFile(
    reportPath,
    JSON.stringify({
      status: 'passed',
      nodes: graph.nodes.length,
      graphAssertions: expectedEdges.length,
      edits: applied.total_edits,
      reindexed: specification.expect.status === 'success',
      ...(specification.warmParseCache === true ? { warmParseCache: graph.parseCache } : {}),
    }),
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
