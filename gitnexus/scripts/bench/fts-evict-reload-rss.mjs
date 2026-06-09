// FTS evict→reload RSS repro (gitnexus-enterprise PR #222 / local U3).
//
// Settles ONE empirical question that no static read can answer: when a
// LadybugDB database that has `LOAD EXTENSION fts` applied is closed and a
// fresh one is opened + re-LOADed (the pool's evict→reload cycle), does the
// native FTS arena get reclaimed by `db.close()` — or is it stranded, so RSS
// climbs without bound over a long-lived MCP `serve` session?
//
//   • PLATEAU across cycles  → db.close() reclaims the FTS arena; the OSS pool's
//     footprint is bounded by MAX_POOL_SIZE (~5 live arenas). No unbounded leak;
//     the #222 worker-isolation rewrite (plan U4) is NOT justified for OSS.
//   • MONOTONIC CLIMB         → the FTS arena is stranded per reopen; the user's
//     hypothesis holds and U4 (route FTS reads through a reclaimable worker) is
//     justified.
//
// Two modes:
//   (default) NATIVE — reproduces the native sequence doInitLbug()+closeOne()
//     perform (open Database → new Connection → LOAD EXTENSION fts →
//     QUERY_FTS_INDEX → close), against K self-built FTS fixtures, with no
//     gitnexus build required. Most decisive for the native question and runs
//     anywhere @ladybugdb/core + a baked fts extension exist.
//   --via-pool <lbugPath> — drives the REAL gitnexus pool from compiled dist
//     (initLbug → executeParameterized → closeLbug) against an existing analyzed
//     repo, exercising the production path + the GITNEXUS_POOL_RSS_TRACE
//     instrumentation. Forces an explicit close+reinit each cycle.
//
// Run with --expose-gc so RSS excludes V8-heap noise:
//   node --expose-gc gitnexus/scripts/bench/fts-evict-reload-rss.mjs
//   node --expose-gc gitnexus/scripts/bench/fts-evict-reload-rss.mjs --cycles 30 --repos 6
//   GITNEXUS_POOL_RSS_TRACE=1 node --expose-gc \
//     gitnexus/scripts/bench/fts-evict-reload-rss.mjs --via-pool /path/to/repo/.gitnexus/lbug
//
// Memory benches are noisy. Default is 24 cycles; trust the TREND (slope /
// first-third vs last-third), never a single delta. A flat trend is a real
// NEGATIVE result (no unbounded leak), not a failed run.

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const lbugModule = require('@ladybugdb/core');
const lbug = lbugModule.default ?? lbugModule;

const LBUG_MAX_DB_SIZE = 16 * 1024 * 1024 * 1024;

// ── args ──────────────────────────────────────────────────────────────────
function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const CYCLES = Math.max(6, parseInt(argVal('--cycles', '24'), 10) || 24);
const REPOS = Math.max(1, parseInt(argVal('--repos', '6'), 10) || 6); // >5 mirrors LRU thrash
const VIA_POOL = argVal('--via-pool', null);
const READONLY = !process.argv.includes('--read-write');

if (typeof global.gc !== 'function') {
  console.error(
    '[fts-rss] WARNING: run with --expose-gc for clean RSS samples ' +
      '(`node --expose-gc <thisfile>`). Continuing without forced GC — results are noisier.',
  );
}

const gc = () => {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
};
const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixture: a minimal FTS-bearing .lbug ────────────────────────────────────
const WORDS = [
  'login auth session token user password validate verify credential',
  'parse tree syntax node grammar lexer token ast traversal visitor',
  'graph query cypher match relation node edge pattern aggregate index',
  'memory pool buffer arena allocate reclaim evict cache resident heap',
  'search rank score bm25 fts index stem porter keyword document corpus',
  'worker fork process spawn kill reclaim isolate native binding addon',
];

function buildFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'fixture.lbug');
  const db = new lbug.Database(dbPath, 0, false, false, LBUG_MAX_DB_SIZE);
  const conn = new lbug.Connection(db);
  return (async () => {
    await conn.query('LOAD EXTENSION fts');
    await conn.query(
      'CREATE NODE TABLE Doc(id STRING, name STRING, content STRING, PRIMARY KEY(id))',
    );
    // ~600 rows so the FTS index has real content to map/scan.
    for (let i = 0; i < 600; i++) {
      const w = WORDS[i % WORDS.length];
      const name = `sym_${i}`;
      const content = `${w} ${name} block number ${i} ${WORDS[(i + 3) % WORDS.length]}`;
      await conn.query(
        `CREATE (:Doc {id: 'doc:${i}', name: '${name}', content: '${content.replace(/'/g, '')}'})`,
      );
    }
    await conn.query(
      "CALL CREATE_FTS_INDEX('Doc', 'doc_fts', ['name', 'content'], stemmer := 'porter')",
    );
    await conn.close();
    await db.close();
    return dbPath;
  })();
}

const QUERIES = ['login token', 'parse node', 'memory arena', 'search index', 'worker reclaim'];

// ── NATIVE mode ─────────────────────────────────────────────────────────────
async function runNative() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-rss-'));
  console.error(
    `[fts-rss] NATIVE mode: ${REPOS} fixtures × ${CYCLES} cycles  (readOnly=${READONLY})`,
  );
  console.error(`[fts-rss] building ${REPOS} FTS fixture(s) under ${root} …`);

  const srcDb = await buildFixture(path.join(root, 'src'));
  const repoPaths = [];
  for (let k = 0; k < REPOS; k++) {
    const dst = path.join(root, `repo-${k}`);
    fs.cpSync(path.dirname(srcDb), dst, { recursive: true });
    repoPaths.push(path.join(dst, 'fixture.lbug'));
  }

  // Mirror the pool's evict→reload: each visit opens a FRESH Database, makes a
  // Connection, LOADs fts, runs an FTS query, then closes — no caching, so every
  // visit is a reload. K>5 amplifies the LRU-thrash signal the pool would see.
  const series = [];
  gc();
  await sleep(50);
  const baseline = rssMb();
  console.error(`[fts-rss] baseline RSS=${baseline}MB`);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (let k = 0; k < REPOS; k++) {
      const db = new lbug.Database(repoPaths[k], 0, false, READONLY, LBUG_MAX_DB_SIZE);
      const conn = new lbug.Connection(db);
      try {
        await conn.query('LOAD EXTENSION fts'); // the per-reload re-LOAD under test
        const q = QUERIES[(cycle + k) % QUERIES.length];
        const res = await conn.query(
          `CALL QUERY_FTS_INDEX('Doc', 'doc_fts', '${q}') RETURN node.id AS id, score ORDER BY score DESC LIMIT 20`,
        );
        // Drain so the query actually materializes results.
        if (res && typeof res.getAll === 'function') await res.getAll();
      } catch (e) {
        console.error(`[fts-rss] query error (cycle ${cycle}, repo ${k}): ${e?.message || e}`);
      } finally {
        // Await close — the BEST case for reclamation. If RSS still climbs with
        // awaited closes, the leak is unambiguously native (the pool's
        // fire-and-forget close cannot do better).
        try {
          await conn.close();
          await db.close();
        } catch {
          /* ignore */
        }
      }
    }
    gc();
    await sleep(20);
    const rss = rssMb();
    series.push(rss);
    console.error(`[fts-rss] cycle ${String(cycle + 1).padStart(3)}/${CYCLES}  rssMB=${rss}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  return { baseline, series };
}

// ── VIA-POOL mode (real gitnexus pool from compiled dist) ───────────────────
async function runViaPool(lbugPath) {
  if (!fs.existsSync(lbugPath)) {
    console.error(`[fts-rss] --via-pool path not found: ${lbugPath}`);
    process.exit(2);
  }
  // Compiled dist is required (the pool pulls the native addon + many modules).
  const distUrl = new URL('../../dist/core/lbug/pool-adapter.js', import.meta.url);
  let pool;
  try {
    pool = await import(distUrl.href);
  } catch (e) {
    console.error(
      `[fts-rss] could not import compiled pool-adapter (${e?.message}). ` +
        `Run \`node scripts/build.js\` first, or use NATIVE mode.`,
    );
    process.exit(2);
  }
  const { initLbug, executeParameterized, closeLbug } = pool;
  console.error(
    `[fts-rss] VIA-POOL mode on ${lbugPath} × ${CYCLES} cycles ` +
      `(explicit closeLbug+initLbug per cycle = forced evict→reload)`,
  );

  const series = [];
  gc();
  const baseline = rssMb();
  console.error(`[fts-rss] baseline RSS=${baseline}MB`);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    try {
      await initLbug(lbugPath, lbugPath);
      // Run the real FTS read path against whatever FTS indexes the repo has.
      const q = QUERIES[cycle % QUERIES.length];
      for (const { table, indexName } of [
        { table: 'Function', indexName: 'function_fts' },
        { table: 'File', indexName: 'file_fts' },
      ]) {
        await executeParameterized(
          lbugPath,
          `CALL QUERY_FTS_INDEX('${table}', '${indexName}', $q) RETURN node.id AS id, score ORDER BY score DESC LIMIT 20`,
          { q },
        ).catch(() => []);
      }
      await closeLbug(lbugPath); // force eviction → next cycle reopens + re-LOADs fts
    } catch (e) {
      console.error(`[fts-rss] pool cycle ${cycle} error: ${e?.message || e}`);
    }
    gc();
    await sleep(20);
    const rss = rssMb();
    series.push(rss);
    console.error(`[fts-rss] cycle ${String(cycle + 1).padStart(3)}/${CYCLES}  rssMB=${rss}`);
  }
  await closeLbug().catch(() => {});
  return { baseline, series };
}

// ── verdict ─────────────────────────────────────────────────────────────────
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function slopeMbPerCycle(series) {
  // Least-squares slope of rss vs cycle index.
  const n = series.length;
  const xs = series.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (series[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function verdict({ baseline, series }) {
  const third = Math.max(1, Math.floor(series.length / 3));
  const firstMed = median(series.slice(0, third));
  const lastMed = median(series.slice(-third));
  const delta = lastMed - firstMed;
  const slope = slopeMbPerCycle(series);
  const peak = Math.max(...series);

  // CLIMB requires BOTH a meaningful per-cycle slope and a meaningful net delta,
  // to avoid calling noise a leak.
  const slopeClimb = slope > 0.75; // MB per cycle
  const deltaClimb = delta > Math.max(50, 0.15 * firstMed);
  const isClimb = slopeClimb && deltaClimb;

  console.log('\n==================== FTS evict→reload RSS verdict ====================');
  console.log(`samples (MB): ${series.join(' ')}`);
  console.log(
    `baseline=${baseline}  firstThirdMed=${firstMed}  lastThirdMed=${lastMed}  ` +
      `delta=${delta}MB  peak=${peak}  slope=${slope.toFixed(2)}MB/cycle  cycles=${series.length}`,
  );
  if (isClimb) {
    console.log(
      'VERDICT: CLIMB — RSS rises monotonically across evict→reload cycles. The native FTS\n' +
        '         arena is NOT reclaimed by db.close(); the leak is real and unbounded over a\n' +
        '         long-lived session. → plan U4 (worker/process isolation of the FTS read path)\n' +
        '         is JUSTIFIED.',
    );
  } else {
    console.log(
      'VERDICT: PLATEAU — RSS is bounded across cycles (db.close() reclaims the FTS arena).\n' +
        '         No unbounded leak in the OSS pool; footprint is capped by MAX_POOL_SIZE. → plan\n' +
        '         U4 is NOT justified by this run. U1 (query batching) + U2 (Docker FTS bake)\n' +
        '         remain the only OSS-shared changes.',
    );
  }
  console.log(
    `MACHINE: ${JSON.stringify({ mode: VIA_POOL ? 'via-pool' : 'native', baseline, firstMed, lastMed, delta, slope: Number(slope.toFixed(3)), peak, cycles: series.length, verdict: isClimb ? 'CLIMB' : 'PLATEAU' })}`,
  );
  console.log('=====================================================================\n');
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const result = VIA_POOL ? await runViaPool(VIA_POOL) : await runNative();
  verdict(result);
  process.exit(0);
})().catch((e) => {
  console.error('[fts-rss] fatal:', e?.stack || e);
  process.exit(1);
});
