/**
 * Generated, non-confidential #3527 probe. Keeps its indexes and raw responses.
 * Usage: node scripts/repro-3527.mjs <built-gitnexus-package> <new-output-dir>
 * Exit 1 means an integrity/coverage failure; exit 2 means the probe could not run.
 * This does not claim to reproduce the original private macOS checkout.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [runtimeArg, outputArg] = process.argv.slice(2);
assert(runtimeArg && outputArg, 'Supply a built GitNexus package and a NEW output directory');
const runtime = fs.realpathSync(runtimeArg);
const output = path.resolve(outputArg);
fs.mkdirSync(output);
const primary = path.join(output, 'primary');
const repo = path.join(output, 'worktree');
fs.mkdirSync(primary);
const requireRuntime = createRequire(path.join(runtime, 'package.json'));
const lbug = requireRuntime('@ladybugdb/core');
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GITNEXUS_HOME: path.join(output, 'home'),
  GITNEXUS_MEMORY: 'off',
  NODE_OPTIONS: '--max-old-space-size=2048',
  GITNEXUS_LBUG_BUFFER_POOL_SIZE: String(512 * 1024 ** 2),
  GITNEXUS_WORKER_POOL_SIZE: '1',
  GITNEXUS_PARSE_CHUNK_CONCURRENCY: '1',
  GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
};
const expected = {};
const report = {
  runtime,
  node: process.version,
  engine: lbug.VERSION,
  platform: `${process.platform}-${process.arch}`,
  expectedMethods: 4480,
  expectedStructs: 4480,
  queries: [],
  native: [],
  crossLanguageMethodPaths: 0,
  nulStructNames: 0,
  witnesses: [],
};
const save = (name, value) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const git = (args, cwd = primary) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
function cli(args, name) {
  const stderr = fs.openSync(path.join(output, name + '.stderr.txt'), 'w');
  try {
    const text = execFileSync(
      process.execPath,
      [path.join(runtime, 'dist/cli/index.js'), ...args],
      {
        cwd: repo,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', stderr],
        maxBuffer: 32 * 1024 ** 2,
        timeout: 300_000,
      },
    );
    fs.writeFileSync(path.join(output, name + '.txt'), text);
    return text;
  } finally {
    fs.closeSync(stderr);
  }
}
function source(kind, batch, edit = false) {
  const python = kind === 'python';
  const file = python
    ? `checks/test_integrity_batch_${batch}.py`
    : `Sources/Features/Component${batch}/IntegritySentinels_${batch}.swift`;
  const lines = python ? [`class IntegrityBatch${batch}:`] : [];
  for (let i = 0; i < 64; i++) {
    const name = python
      ? `test_mixed_integrity_${batch}_${i}`
      : `MixedIntegritySentinel${batch}_${i}`;
    const startLine = lines.length + 1;
    const marker = `mixed integrity sentinel ${batch}_${i}${edit && i === 0 ? ' changed' : ''}`;
    const block = python
      ? [`    def ${name}(self):`, `        return "${marker}"`]
      : [`struct ${name} {`, `    let marker = "${marker}"`, '}'];
    const id = python
      ? `Method:${file}:IntegrityBatch${batch}.${name}#0`
      : `Struct:${file}:${name}`;
    expected[id] = { id, name, filePath: file, startLine, endLine: startLine + block.length - 1 };
    lines.push(...block, '');
  }
  const root = fs.existsSync(repo) ? repo : primary;
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), lines.join('\n'));
  expected['File:' + file] = { id: 'File:' + file, name: path.basename(file), filePath: file };
}
function mismatches(rows) {
  return rows.filter(
    (row) =>
      !expected[row.id] ||
      Object.keys(expected[row.id]).some((k) => row[k] !== expected[row.id][k]),
  );
}
async function nativeChecks() {
  const entry = JSON.parse(fs.readFileSync(path.join(output, 'home/registry.json'))).find(
    (entry) => fs.realpathSync(entry.path) === fs.realpathSync(repo),
  );
  assert(entry, 'The exact worktree must be registered');
  const meta = JSON.parse(fs.readFileSync(path.join(entry.storagePath, 'gitnexus.json')));
  const dbPath = meta.graphPath || path.join(entry.storagePath, 'lbug');
  report.dbPath = dbPath;
  report.lastCommit = meta.lastCommit;
  assert.equal(meta.lastCommit, git(['rev-parse', 'HEAD'], repo).toString().trim());
  const db = new lbug.Database(dbPath, 512 * 1024 ** 2, false, true);
  const conn = new lbug.Connection(db);
  const fields =
    'n.id AS id,n.name AS name,n.filePath AS filePath,n.startLine+1 AS startLine,n.endLine+1 AS endLine';
  async function read(query, params) {
    const result = params
      ? await conn.execute(await conn.prepare(query), params)
      : await conn.query(query);
    try {
      return await result.getAll();
    } finally {
      await result.close();
    }
  }
  async function check(rows, ids, stage) {
    const bad = mismatches(rows);
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    const duplicates = rows.length - found.size;
    report.crossLanguageMethodPaths += bad.filter(
      (row) => row.id?.startsWith('Method:') && row.filePath?.includes('.swift'),
    ).length;
    report.nulStructNames += bad.filter(
      (row) => row.id?.startsWith('Struct:') && row.name?.includes('\0'),
    ).length;
    report.native.push({
      stage,
      rows: rows.length,
      bad: bad.length,
      missing: missing.length,
      duplicates,
    });
    if ((bad.length || missing.length || duplicates) && report.witnesses.length < 8) {
      const uid = missing[0] || bad.find((row) => expected[row.id])?.id;
      const primaryKey = uid
        ? await read(`MATCH(n:${uid.split(':')[0]} {id:$uid}) RETURN ${fields}`, { uid })
        : [];
      report.witnesses.push({
        stage,
        bad: bad.slice(0, 3),
        missing: missing.slice(0, 3),
        uid,
        primaryKey,
      });
    }
  }
  try {
    const methods = Object.keys(expected).filter((id) => id.startsWith('Method:'));
    const structs = Object.keys(expected).filter((id) => id.startsWith('Struct:'));
    for (const [table, ids] of [
      ['Method', methods],
      ['Struct', structs],
    ]) {
      await check(await read(`MATCH(n:${table}) RETURN ${fields}`), ids, table + '-all');
    }
    const statement = await conn.prepare(
      `MATCH(n) WHERE n.id IN $ids RETURN ${fields} ORDER BY startLine,id`,
    );
    for (let i = 0; i < 150; i++) {
      const ids = [methods[(i * 29) % methods.length], structs[(i * 67) % structs.length]];
      if (i % 3) ids.splice(i % 2, 1);
      const result = await conn.execute(statement, { ids });
      let rows;
      try {
        rows = await result.getAll();
      } finally {
        await result.close();
      }
      await check(rows, ids, 'mixed-' + i);
    }
  } finally {
    await conn.close();
    await db.close();
  }
}
try {
  for (let i = 0; i < 70; i++) for (const kind of ['python', 'swift']) source(kind, i);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.gitnexus/\n');
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'mixed language fixture']);
  git(['worktree', 'add', '-b', 'verification', repo]);
  cli(['analyze', '--index-only', '.'], 'baseline-analyze');
  for (let round = 0; round < 3; round++) {
    source('python', round, true); // Leave every Swift file untouched.
    git(['add', '.'], repo);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', `incremental edit ${round}`], repo);
    const name = `round-${round}-analyze`;
    const analyze = cli(['analyze', '--index-only', '.'], name);
    assert(
      !/switching to a full DB write|escalated/i.test(
        analyze + fs.readFileSync(path.join(output, name + '.stderr.txt')),
      ),
      'Probe requires selective writeback',
    );
    cli(['status'], `round-${round}-status`);
    const terms = [
      'mixed integrity sentinel',
      'test_mixed_integrity',
      'MixedIntegritySentinel',
      'integrity batch',
    ];
    for (const [i, term] of terms.entries()) {
      const text = cli(['query', term, '--repo', repo], `round-${round}-query-${i}`);
      const result = JSON.parse(text.slice(text.indexOf('{')));
      const rows = [...(result.process_symbols ?? []), ...(result.definitions ?? [])];
      const relevant = rows.filter((row) => /^(Method|Struct|File):/.test(row.id));
      report.queries.push({
        round,
        term,
        error: result.error,
        partial: result.partial,
        rows: rows.length,
        methods: rows.filter((r) => r.id?.startsWith('Method:')).length,
        structs: rows.filter((r) => r.id?.startsWith('Struct:')).length,
        bad: mismatches(relevant),
      });
    }
    save('report.json', report);
  }
  save('expected.json', expected);
  await nativeChecks();
  report.passed =
    report.queries.every((q) => !q.error && !q.partial && q.rows > 0 && !q.bad.length) &&
    report.queries.some((q) => q.methods > 0) &&
    report.queries.some((q) => q.structs > 0) &&
    report.native.every((q) => !q.bad && !q.missing && !q.duplicates);
  save('report.json', report);
  console.log(
    JSON.stringify({
      engine: report.engine,
      passed: report.passed,
      report: path.join(output, 'report.json'),
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  report.probeError = String(error);
  save('report.json', report);
  console.error(error);
  process.exitCode = 2;
}
