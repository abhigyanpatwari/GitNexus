/** Compare real analyzer writes with a fresh build of the identical final graph. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: fileURLToPath(new URL('../../../', import.meta.url)) },
    output: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-compact-writes-'));
process.env.GITNEXUS_HOME = path.join(temporary, 'home');
process.env.GITNEXUS_SHARED_STORE = 'off';
process.env.GITNEXUS_MEMORY = 'off';
process.env.GITNEXUS_LBUG_BUFFER_POOL_SIZE = String(256 * 1024 ** 2);
const repo = path.join(temporary, 'repo');
const runtime = path.resolve(values.runtime);
const adapter = await import(
  pathToFileURL(path.join(runtime, 'gitnexus/dist/core/lbug/lbug-adapter.js'))
);
const { runFullAnalysis } = await import(
  pathToFileURL(path.join(runtime, 'gitnexus/dist/core/run-analyze.js'))
);
const { getStoragePaths } = await import(
  pathToFileURL(path.join(runtime, 'gitnexus/dist/storage/repo-manager.js'))
);
const runs = [];
const options = { skipAgentsMd: true, skipSkills: true, workerPoolSize: 1 };

async function run(name, extra = {}) {
  const start = performance.now();
  const result = await runFullAnalysis(repo, { ...options, ...extra }, { onProgress() {} });
  const { lbugPath } = getStoragePaths(repo);
  const stat = await fs.stat(lbugPath);
  const sample = {
    name,
    elapsedMs: performance.now() - start,
    bytes: stat.size,
    inode: stat.ino,
    stats: result.stats,
    incrementalStats: result.incrementalStats,
    alreadyUpToDate: result.alreadyUpToDate,
    ftsSkipped: result.ftsSkipped,
  };
  runs.push(sample);
  return sample;
}

async function fingerprint() {
  const { lbugPath } = getStoragePaths(repo);
  await adapter.initLbug(lbugPath);
  try {
    const nodes = await adapter.executeQuery(
      'MATCH (n) RETURN label(n) AS label, n.id AS id ORDER BY label, id',
    );
    const edges = await adapter.executeQuery(
      'MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS src, b.id AS dst, r.type AS type, r.reason AS reason ORDER BY src, dst, type, reason',
    );
    return {
      nodes: nodes.length,
      edges: edges.length,
      sha256: createHash('sha256')
        .update(JSON.stringify(nodes))
        .update(JSON.stringify(edges))
        .digest('hex'),
    };
  } finally {
    await adapter.closeLbug();
  }
}

try {
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  for (let file = 0; file < 128; file++) {
    let source = '';
    for (let fn = 0; fn < 32; fn++) {
      source += `export function fn${fn}(x: number): number { return x > 0 ? fn${(fn + 1) % 32}(x - 1) : ${fn}; }\n`;
    }
    await fs.writeFile(path.join(repo, 'src', `file${file}.ts`), source);
  }
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  const first = await run('fresh');
  const unchanged = await run('no-op');
  assert.equal(unchanged.alreadyUpToDate, true);
  assert.equal(unchanged.inode, first.inode);
  for (let file = 0; file < 3; file++) {
    await fs.appendFile(path.join(repo, 'src', `file${file}.ts`), '\n// equivalent-source edit\n');
    await run(`edit-${file + 1}`);
  }
  const modified = await fingerprint();
  await run('force-control', { force: true });
  const control = await fingerprint();
  assert.deepEqual(
    modified,
    control,
    'modified and forced graphs must have identical node/edge identities',
  );
  const report = {
    runtime,
    node: process.version,
    runs,
    modified,
    control,
    ...(values.keep ? { directory: temporary } : {}),
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await fs.writeFile(values.output, json);
  else console.log(json);
} finally {
  await adapter.closeLbug();
  if (!values.keep) await fs.rm(temporary, { recursive: true, force: true });
}
