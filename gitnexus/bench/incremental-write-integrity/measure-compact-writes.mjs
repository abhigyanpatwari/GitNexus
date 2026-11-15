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
    profile: { type: 'boolean', default: false },
    files: { type: 'string', default: '128' },
    functions: { type: 'string', default: '32' },
    edits: { type: 'string', default: '18' },
    repos: { type: 'string', default: '1' },
  },
});
const counts = Object.fromEntries(
  ['files', 'functions', 'edits', 'repos'].map((key) => [key, Number(values[key])]),
);
for (const [key, value] of Object.entries(counts)) {
  assert(Number.isSafeInteger(value) && value > 0, `${key} must be a positive integer`);
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-compact-writes-'));
let adapter;
try {
  process.env.GITNEXUS_HOME = path.join(temporary, 'home');
  process.env.GITNEXUS_SHARED_STORE = 'off';
  process.env.GITNEXUS_MEMORY = 'off';
  process.env.GITNEXUS_LBUG_BUFFER_POOL_SIZE = String(256 * 1024 ** 2);
  let repo;
  const runtime = path.resolve(values.runtime);
  adapter = await import(
    pathToFileURL(path.join(runtime, 'gitnexus/dist/core/lbug/lbug-adapter.js'))
  );
  const { runFullAnalysis } = await import(
    pathToFileURL(path.join(runtime, 'gitnexus/dist/core/run-analyze.js'))
  );
  const { getStoragePaths, loadMeta } = await import(
    pathToFileURL(path.join(runtime, 'gitnexus/dist/storage/repo-manager.js'))
  );
  const runs = [];
  const options = { skipAgentsMd: true, skipSkills: true, workerPoolSize: 1 };

  async function run(name, extra = {}) {
    const start = performance.now();
    const phaseTimingsMs = {};
    let phase = 'preflight';
    let phaseStart = start;
    const recordPhase = (nextPhase) => {
      if (!values.profile) return;
      const now = performance.now();
      phaseTimingsMs[phase] = (phaseTimingsMs[phase] ?? 0) + now - phaseStart;
      phase = nextPhase;
      phaseStart = now;
    };
    const result = await runFullAnalysis(
      repo,
      { ...options, ...extra },
      { onProgress: recordPhase },
    );
    recordPhase('complete');
    const { lbugPath, storagePath } = getStoragePaths(repo);
    const stat = await fs.stat(lbugPath);
    const sample = {
      name,
      repo: path.basename(repo),
      elapsedMs: performance.now() - start,
      bytes: stat.size,
      inode: stat.ino,
      stats: result.stats,
      incrementalStats: result.incrementalStats,
      alreadyUpToDate: result.alreadyUpToDate,
      ftsSkipped: result.ftsSkipped,
      graphCompaction: (await loadMeta(storagePath))?.graphCompaction,
      ...(values.profile ? { phaseTimingsMs } : {}),
    };
    runs.push(sample);
    return sample;
  }

  async function fingerprint() {
    const { lbugPath } = getStoragePaths(repo);
    await adapter.initLbug(lbugPath);
    try {
      const nodes = await adapter.executeQuery('MATCH (n) RETURN n AS node');
      const edges = await adapter.executeQuery(
        'MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS src, b.id AS dst, r AS edge',
      );
      // Native row offsets change after COPY. Keep every persisted property
      // and the label, replacing internal endpoints with stable node IDs.
      const properties = (entity) =>
        Object.fromEntries(
          Object.entries(entity).filter(([key]) => !['_id', '_src', '_dst'].includes(key)),
        );
      const canonical = (value) =>
        JSON.stringify(value, (_key, entry) => {
          if (typeof entry === 'bigint') return { bigint: entry.toString() };
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
          }
          return entry;
        });
      return {
        nodes: nodes.length,
        edges: edges.length,
        sha256: createHash('sha256')
          .update(JSON.stringify(nodes.map(({ node }) => canonical(properties(node))).sort()))
          .update(
            JSON.stringify(
              edges
                .map(({ src, dst, edge }) => canonical({ src, dst, edge: properties(edge) }))
                .sort(),
            ),
          )
          .digest('hex'),
      };
    } finally {
      await adapter.closeLbug();
    }
  }

  const comparisons = [];
  for (let repository = 0; repository < counts.repos; repository++) {
    repo = path.join(temporary, `repo-${repository}`);
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    for (let file = 0; file < counts.files; file++) {
      let source = '';
      for (let fn = 0; fn < counts.functions; fn++) {
        source += `export function fn${fn}(x: number): number { return x > 0 ? fn${(fn + 1) % counts.functions}(x - 1) : ${fn}; }\n`;
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
    for (let edit = 0; edit < counts.edits; edit++) {
      await fs.appendFile(
        path.join(repo, 'src', `file${edit % counts.files}.ts`),
        '\n// equivalent-source edit\n',
      );
      const sample = await run(`edit-${edit + 1}`);
      if (sample.graphCompaction) {
        assert(
          sample.graphCompaction.incrementalWrites <= 16,
          'incremental writes must be bounded',
        );
        if (sample.incrementalStats?.writeMode === 'full') {
          assert.equal(sample.graphCompaction.incrementalWrites, 0);
          assert.equal(sample.graphCompaction.compactBytes, sample.bytes);
        }
      }
    }
    const modified = await fingerprint();
    await run('force-control', { force: true });
    const control = await fingerprint();
    assert.deepEqual(
      modified,
      control,
      'modified and forced graphs must have identical node/edge properties',
    );
    comparisons.push({ repo: path.basename(repo), modified, control });
  }
  const report = {
    runtime,
    node: process.version,
    runs,
    counts,
    comparisons,
    ...(values.keep ? { directory: temporary } : {}),
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await fs.writeFile(values.output, json);
  else console.log(json);
} finally {
  try {
    await adapter?.closeLbug();
  } finally {
    if (!values.keep) await fs.rm(temporary, { recursive: true, force: true });
  }
}
