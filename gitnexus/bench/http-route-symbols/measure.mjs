#!/usr/bin/env node
/** Real LadybugDB symbol lookups through HttpRouteExtractor.extract(). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { evaluateScaling } from '../method-declaration-facts/scaling.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    sizes: { type: 'string', default: '256,1024,4096' },
    samples: { type: 'string', default: '7' },
    arm: { type: 'string', default: 'spread,dense,sparse' },
    output: { type: 'string' },
    check: { type: 'boolean', default: false },
    child: { type: 'boolean', default: false },
  },
});
const root = path.resolve(values.root ?? fileURLToPath(new URL('../..', import.meta.url)));
const sizes = values.sizes.split(',').map(Number);
const samples = Number(values.samples);
const arms = values.arm.split(',');
assert(
  sizes.length >= (values.child ? 1 : 3) &&
    sizes.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > sizes[i - 1])),
);
assert(Number.isSafeInteger(samples) && samples >= 3);
assert(arms.length && arms.every((arm) => ['spread', 'dense', 'sparse'].includes(arm)));
if (values.check) {
  assert(!values.child, '--check must run the complete benchmark');
  assert.deepEqual(sizes, [256, 1024, 4096], '--check requires the reviewed sizes');
  assert.deepEqual(arms, ['spread', 'dense', 'sparse'], '--check requires every arm');
  assert(samples >= 7, '--check requires at least seven samples');
}
assert(global.gc, 'Run with --expose-gc');
const output = path.resolve(values.output ?? `http-route-symbols-${Date.now()}.json`);
const outputFile = await fs.open(output, 'wx');
const require = createRequire(path.join(root, 'package.json'));
const lbug = require('@ladybugdb/core');
const sourcePath = path.join(root, 'src/core/group/extractors/http-route-extractor.ts');
const { HttpRouteExtractor, HANDLES_ROUTE_QUERY } = await import(pathToFileURL(sourcePath));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

// PROFILE renders sibling operators side by side. Follow each scan's column,
// not the next tuple count in the whole string (which may belong to a sibling).
function scannedRows(plan) {
  const lines = plan.split('\n');
  let rows = 0,
    scans = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(/SCAN_NODE_TABLE\[\d+\]/g)) {
      const left = lines[i].lastIndexOf('│', match.index);
      const right = lines[i].indexOf('│', match.index);
      assert(left >= 0 && right > left, 'Unrecognized PROFILE scan column');
      let count;
      for (let j = i + 1; j < lines.length && lines[j][left] === '│'; j++) {
        const found = lines[j].slice(left + 1, right).match(/NumOutputTuples:\s*(\d+)/);
        if (found) {
          count = Number(found[1]);
          break;
        }
      }
      assert(Number.isSafeInteger(count), 'PROFILE omitted a scan tuple count');
      rows += count;
      scans++;
    }
  }
  assert(scans > 0, 'No measurable symbol-table scan in PROFILE');
  return rows;
}

async function fixture(arm, size) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-http-symbols-'));
  const repoPath = path.join(dir, 'repo');
  await fs.mkdir(repoPath);
  const database = new lbug.Database(':memory:', 128 * 1024 * 1024);
  const connection = new lbug.Connection(database, 1);
  const query = async (cypher, params) => {
    const result = params
      ? await connection.execute(await connection.prepare(cypher), params)
      : await connection.query(cypher);
    try {
      return await result.getAll();
    } finally {
      result.close();
    }
  };
  const labels = ['Function', 'Method', 'CodeElement'];
  for (const label of labels) {
    await query(
      `CREATE NODE TABLE ${label}(id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, PRIMARY KEY(id))`,
    );
    // Two symbols per label per unit. Handler is the second Function in its
    // unit, so dense files require progressively later lookups.
    await query(`UNWIND range(0, ${size * 2 - 1}) AS n
      CREATE (:${label} { id: '${label}:' + CAST(n AS STRING), name: 'handler' + CAST(n AS STRING),
        filePath: 'routes/r' + CAST(${arm === 'dense' ? '0' : 'CAST(floor(n / 2.0) AS INT64)'} AS STRING) + '.opaque',
        startLine: n * 3, endLine: n * 3 + 2 })`);
    // As many symbols again in files no route names. A loader that fetches
    // more than the requested files' rows returns these and fails the run.
    await query(`UNWIND range(0, ${size * 2 - 1}) AS n
      CREATE (:${label} { id: '${label}:other:' + CAST(n AS STRING), name: 'other' + CAST(n AS STRING),
        filePath: 'lib/o' + CAST(CAST(floor(n / 2.0) AS INT64) AS STRING) + '.opaque',
        startLine: n * 3, endLine: n * 3 + 2 })`);
  }
  const count = arm === 'sparse' ? 1 : size;
  // Rows of the requested files: one six-symbol file (sparse), or all route files.
  const requestedRows = arm === 'sparse' ? 6 : size * 6;
  const routes = Array.from({ length: count }, (_, i) => ({
    fileId: `File:${i}`,
    filePath: `routes/r${arm === 'dense' ? 0 : i}.opaque`,
    routePath: `/r${i}`,
    routeId: `Route:${i}`,
    routeMethod: 'GET',
    handlerSymbolId: `Function:${i * 2 + 1}`,
    responseKeys: [],
    routeSource: 'benchmark',
  }));
  const expected = routes.map((r, i) => ({
    contractId: `http::GET::/r${i}`,
    type: 'http',
    role: 'provider',
    symbolUid: r.handlerSymbolId,
    symbolRef: { filePath: r.filePath, name: `handler${i * 2 + 1}` },
    symbolName: `handler${i * 2 + 1}`,
    confidence: 0.9,
    meta: {
      method: 'GET',
      path: `/r${i}`,
      pathSegments: [`r${i}`],
      extractionStrategy: 'graph_assisted',
      routeSource: 'benchmark',
    },
  }));
  // Pin canonical file order, then the fixture's stable identity order. Here
  // File:<index> and /r<index> have the same lexical order. Keep comparing the
  // complete returned array; sorting actual output would conceal order drift.
  expected.sort((a, b) => {
    const left = a.symbolRef.filePath;
    const right = b.symbolRef.filePath;
    if (left !== right) return left < right ? -1 : 1;
    return a.meta.path < b.meta.path ? -1 : a.meta.path > b.meta.path ? 1 : 0;
  });
  const expectedHash = hash(JSON.stringify(canonical(expected)));
  const repo = { id: 'benchmark', path: 'repo', repoPath, storagePath: dir };
  async function run(profile = false) {
    const stats = { queries: 0, rowsReturned: 0, scannedRows: 0, symbolIdReads: 0, plans: [] };
    const executor = async (cypher, params) => {
      if (cypher === HANDLES_ROUTE_QUERY) return routes;
      if (cypher.includes("type: 'FETCHES'")) return [];
      assert(cypher.includes('sym:Function'), `Unexpected query: ${cypher}`);
      stats.queries++;
      if (profile) {
        const rows = await query('PROFILE ' + cypher, params);
        const plan = rows[0]['explain result'];
        stats.scannedRows += scannedRows(plan);
        stats.plans.push(plan);
      }
      const rows = await query(cypher, params);
      stats.rowsReturned += rows.length;
      return profile
        ? rows.map(
            (row) =>
              new Proxy(row, {
                get(target, key) {
                  if (key === 'uid' || key === '0') stats.symbolIdReads++;
                  return Reflect.get(target, key);
                },
              }),
          )
        : rows;
    };
    const cpu = process.cpuUsage();
    const start = performance.now();
    const contracts = await new HttpRouteExtractor().extract(executor, repoPath, repo);
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const memory = process.memoryUsage();
    assert.deepEqual(contracts, expected, `${arm}/${size}: exact contract drift`);
    assert.equal(
      stats.rowsReturned,
      requestedRows,
      `${arm}/${size}: symbol queries must return the requested files' rows and no others`,
    );
    return {
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      heapBytes: memory.heapUsed,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      rssBytes: memory.rss,
      contracts: contracts.length,
      fingerprint: expectedHash,
      ...stats,
    };
  }
  return {
    run,
    close: async () => {
      await connection.close();
      await database.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const report = {
  protocol: 'http-route-symbols-v3-unrequested-symbols',
  source: {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    extractorSha256: hash(await fs.readFile(sourcePath)),
    lockfileSha256: hash(await fs.readFile(path.join(root, 'package-lock.json'))),
    scalingGuardSha256: hash(
      await fs.readFile(new URL('../method-declaration-facts/scaling.mjs', import.meta.url)),
    ),
    harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
  },
  environment: {
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0].model,
    databaseThreads: 1,
    bufferPoolBytes: 128 * 1024 * 1024,
    loadAverage: os.loadavg(),
  },
  sizes,
  samples,
  warmups: 2,
  results: [],
  scaling: {},
};
try {
  if (!values.child) {
    const resultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-symbol-results-'));
    try {
      for (const arm of arms) {
        for (const size of sizes) {
          const childOutput = path.join(resultsDir, `${arm}-${size}.json`);
          execFileSync(
            process.execPath,
            [
              '--expose-gc',
              '--import',
              'tsx',
              fileURLToPath(import.meta.url),
              '--child',
              '--root',
              root,
              '--sizes',
              String(size),
              '--samples',
              String(samples),
              '--arm',
              arm,
              '--output',
              childOutput,
            ],
            {
              cwd: fileURLToPath(new URL('../..', import.meta.url)),
              stdio: ['ignore', 'inherit', 'inherit'],
            },
          );
          const child = JSON.parse(await fs.readFile(childOutput, 'utf8'));
          assert.equal(
            child.source.extractorSha256,
            report.source.extractorSha256,
            'Source changed during benchmark',
          );
          report.results.push(...child.results);
        }
        const rows = report.results.filter((r) => r.arm === arm);
        report.scaling[arm] = evaluateScaling(
          rows.map((r) => ({
            size: r.size,
            ...r.median,
            scannedRows: r.verified.scannedRows,
            rowsReturned: r.verified.rowsReturned,
            symbolIdReads: r.verified.symbolIdReads,
          })),
          [
            'wallMs',
            'cpuMs',
            'heapBytes',
            'rssBytes',
            'peakRssBytes',
            'scannedRows',
            'rowsReturned',
            'symbolIdReads',
          ],
        );
      }
    } finally {
      await fs.rm(resultsDir, { recursive: true, force: true });
    }
  } else {
    for (const arm of arms) {
      const fixtures = new Map();
      try {
        for (const size of sizes) {
          const instance = await fixture(arm, size);
          fixtures.set(size, instance);
          const verified = await instance.run(true);
          for (let i = 0; i < report.warmups; i++) await instance.run();
          report.results.push({ arm, size, verified, samples: [] });
        }
        for (let rep = 0; rep < samples; rep++) {
          for (const size of rep % 2 ? [...sizes].reverse() : sizes) {
            global.gc();
            const measurement = await fixtures.get(size).run();
            report.results.find((r) => r.arm === arm && r.size === size).samples.push(measurement);
          }
        }
        const rows = report.results.filter((r) => r.arm === arm);
        for (const row of rows) {
          row.median = Object.fromEntries(
            ['wallMs', 'cpuMs', 'heapBytes', 'rssBytes', 'peakRssBytes'].map((key) => [
              key,
              median(row.samples.map((r) => r[key])),
            ]),
          );
          console.log(
            JSON.stringify({
              arm,
              size: row.size,
              ...row.median,
              queries: row.verified.queries,
              scannedRows: row.verified.scannedRows,
            }),
          );
        }
      } finally {
        for (const instance of fixtures.values()) await instance.close();
      }
    }
  }
  report.passed = Object.values(report.scaling).every((r) => r.passed);
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${output}`);
  if (values.check && !report.passed) process.exitCode = 1;
} catch (error) {
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await outputFile.writeFile(JSON.stringify(report, null, 2) + '\n');
  await outputFile.close();
}
