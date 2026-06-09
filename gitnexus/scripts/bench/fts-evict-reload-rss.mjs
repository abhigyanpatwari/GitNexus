#!/usr/bin/env node
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
// SCOPE OF THE VERDICT (read before citing it). A per-reload FTS-arena leak
// would be PROPORTIONAL to the index size. A small fixture therefore produces a
// small per-cycle increment that an absolute threshold can read as PLATEAU even
// when a production-scale graph would leak visibly. So:
//   - `--rows` controls fixture size; run it LARGE (tens of thousands) before
//     concluding "no leak". The default is deliberately not tiny.
//   - The verdict (in fts-rss-verdict.mjs) keys on slope DECELERATION, not total
//     delta, with a noise floor that scales with the working-set growth
//     (peak−baseline) so sensitivity tracks fixture/arena size — NOT the pre-DB
//     baseline RSS. A sustained sub-floor positive slope is INCONCLUSIVE (a slow
//     creep RSS can't distinguish from noise), never a clean PLATEAU.
//   - The PLATEAU verdict is only valid for the corpus size it was run at; the
//     output states that size. The production-faithful confirmation is a
//     `--via-pool` run against a real large analyzed repo over a long session.
//
// Two modes:
//   (default) NATIVE — reproduces the native sequence doInitLbug()+closeOne()
//     perform (open Database → new Connection → LOAD EXTENSION fts →
//     QUERY_FTS_INDEX → close), against K self-built FTS fixtures, with no
//     gitnexus build required. `--no-await-close` mirrors the pool's
//     fire-and-forget close instead of awaiting (the production close shape).
//   --via-pool <lbugPath> — drives the REAL gitnexus pool from compiled dist
//     (initLbug → executeParameterized → closeLbug) against an existing analyzed
//     repo, exercising the production path + the GITNEXUS_POOL_RSS_TRACE
//     instrumentation. Probes ALL FTS indexes the repo has. Forces an explicit
//     close+reinit each cycle. Run `node scripts/build.js` first so the dist
//     reflects the current pool-adapter (incl. the RSS trace).
//
// Run with --expose-gc so RSS excludes V8-heap noise:
//   node --expose-gc gitnexus/scripts/bench/fts-evict-reload-rss.mjs
//   node --expose-gc gitnexus/scripts/bench/fts-evict-reload-rss.mjs --rows 40000 --cycles 30
//   GITNEXUS_POOL_RSS_TRACE=1 node --expose-gc \
//     gitnexus/scripts/bench/fts-evict-reload-rss.mjs --via-pool /path/to/repo/.gitnexus/lbug
//
// Flags by mode: --rows/--repos/--read-write/--no-await-close apply to NATIVE
// only; --cycles applies to both. VIA-POOL warns when a NATIVE-only flag is set.
//
// Memory benches are noisy. Default is 24 cycles; trust the TREND (slope /
// first-third vs last-third), never a single delta. A flat trend at a LARGE
// fixture is a real NEGATIVE result (no unbounded leak), not a failed run.

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// Pure verdict classifier (median, slopeMbPerCycle, classifyVerdict) lives in a
// side-effect-free sibling module so it is unit-testable without loading the
// native addon or running this bench. See fts-rss-verdict.mjs.
import { classifyVerdict, median, slopeMbPerCycle } from './fts-rss-verdict.mjs';

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
// Fixture size. Default is large enough that a size-proportional leak would be
// visible across cycles; raise it further before trusting a PLATEAU verdict.
const ROWS = Math.max(100, parseInt(argVal('--rows', '8000'), 10) || 8000);
const VIA_POOL = argVal('--via-pool', null);
const READONLY = !process.argv.includes('--read-write');
const AWAIT_CLOSE = !process.argv.includes('--no-await-close');

if (VIA_POOL) {
  // These flags are consumed only by NATIVE mode; warn rather than ignore
  // silently so a VIA-POOL run is not misread as honoring them.
  const ignored = ['--rows', '--repos', '--read-write', '--no-await-close'].filter((f) =>
    process.argv.includes(f),
  );
  if (ignored.length) {
    console.error(
      `[fts-rss] NOTE: ${ignored.join(', ')} apply to NATIVE mode only; ignored in --via-pool.`,
    );
  }
}

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
    // Batch-insert via UNWIND so large fixtures (`--rows`) build in seconds
    // instead of one round-trip per row. The fixture size drives the per-arena
    // FTS allocation, which is what makes a size-proportional leak observable.
    const rows = [];
    for (let i = 0; i < ROWS; i++) {
      const w = WORDS[i % WORDS.length];
      const name = `sym_${i}`;
      const content = `${w} ${name} block number ${i} ${WORDS[(i + 3) % WORDS.length]}`;
      rows.push({ id: `doc:${i}`, name, content });
    }
    const INSERT_CHUNK = 2000;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const stmt = await conn.prepare(
        'UNWIND $rows AS r CREATE (:Doc {id: r.id, name: r.name, content: r.content})',
      );
      await conn.execute(stmt, { rows: chunk });
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
    `[fts-rss] NATIVE: ${REPOS} fixtures × ${ROWS} rows × ${CYCLES} cycles ` +
      `(readOnly=${READONLY}, awaitClose=${AWAIT_CLOSE})`,
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
        // AWAIT_CLOSE (default) is the best case for reclamation. --no-await-close
        // mirrors the pool's fire-and-forget close (closeOne: db.close().catch())
        // so a leak that only manifests without awaiting is not hidden.
        if (AWAIT_CLOSE) {
          try {
            await conn.close();
            await db.close();
          } catch {
            /* ignore */
          }
        } else {
          conn.close().catch(() => {});
          db.close().catch(() => {});
        }
      }
    }
    gc();
    // Longer settle when not awaiting close, so fire-and-forget native teardown
    // has a chance to complete before the RSS sample (avoids a false PLATEAU).
    await sleep(AWAIT_CLOSE ? 20 : 200);
    const rss = rssMb();
    series.push(rss);
    console.error(`[fts-rss] cycle ${String(cycle + 1).padStart(3)}/${CYCLES}  rssMB=${rss}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  return { baseline, series, corpus: `${REPOS}×${ROWS} rows, native, awaitClose=${AWAIT_CLOSE}` };
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
    `[fts-rss] VIA-POOL on ${lbugPath} × ${CYCLES} cycles ` +
      `(explicit closeLbug+initLbug per cycle = forced evict→reload)`,
  );

  // Probe ALL FTS indexes the analyzed graph carries (mirrors fts-schema.ts
  // FTS_INDEXES) so the per-cycle FTS arena load matches production, not a
  // 2-of-5 subset that would understate it.
  const FTS_INDEXES = [
    { table: 'File', indexName: 'file_fts' },
    { table: 'Function', indexName: 'function_fts' },
    { table: 'Class', indexName: 'class_fts' },
    { table: 'Method', indexName: 'method_fts' },
    { table: 'Interface', indexName: 'interface_fts' },
  ];

  const series = [];
  gc();
  const baseline = rssMb();
  console.error(`[fts-rss] baseline RSS=${baseline}MB`);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    try {
      await initLbug(lbugPath, lbugPath);
      const q = QUERIES[cycle % QUERIES.length];
      for (const { table, indexName } of FTS_INDEXES) {
        await executeParameterized(
          lbugPath,
          `CALL QUERY_FTS_INDEX('${table}', '${indexName}', $q) RETURN node.id AS id, score ORDER BY score DESC LIMIT 20`,
          { q },
        ).catch(() => []); // index may not exist for this graph — that's fine
      }
      await closeLbug(lbugPath); // force eviction → next cycle reopens + re-LOADs fts
    } catch (e) {
      console.error(`[fts-rss] pool cycle ${cycle} error: ${e?.message || e}`);
    }
    gc();
    // closeLbug fires a fire-and-forget native close (pool closeOne:
    // db.close().catch()), so settle longer than NATIVE's awaited close to let
    // native teardown finish before sampling — else a real leak reads PLATEAU.
    await sleep(200);
    const rss = rssMb();
    series.push(rss);
    console.error(`[fts-rss] cycle ${String(cycle + 1).padStart(3)}/${CYCLES}  rssMB=${rss}`);
  }
  await closeLbug().catch(() => {});
  return { baseline, series, corpus: `via-pool ${path.basename(path.dirname(lbugPath))}` };
}

// ── verdict ─────────────────────────────────────────────────────────────────
function verdict({ baseline, series, corpus }) {
  const third = Math.max(1, Math.floor(series.length / 3));
  const firstMed = median(series.slice(0, third));
  const lastMed = median(series.slice(-third));
  const delta = lastMed - firstMed;
  const slope = slopeMbPerCycle(series);

  // All label logic lives in the pure, unit-tested classifier (fts-rss-verdict.mjs):
  // epsilon-first flat→PLATEAU, decelerated→PLATEAU, sustained-sub-floor→INCONCLUSIVE,
  // ≥floor sustained→CLIMB, step→INCONCLUSIVE; floor scales with the working-set
  // growth (peak−baseline), not the pre-DB baseline RSS.
  const {
    verdict: label,
    firstHalfSlope,
    secondHalfSlope,
    decelRatio,
    floor,
    stepDiscontinuity,
    maxJump,
    peak,
  } = classifyVerdict(series, baseline);

  console.log('\n==================== FTS evict→reload RSS verdict ====================');
  console.log(`corpus: ${corpus}`);
  console.log(`samples (MB): ${series.join(' ')}`);
  console.log(
    `baseline=${baseline}  firstThirdMed=${firstMed}  lastThirdMed=${lastMed}  delta=${delta}MB  ` +
      `peak=${peak}  overallSlope=${slope.toFixed(2)}  firstHalfSlope=${firstHalfSlope.toFixed(2)}  ` +
      `secondHalfSlope=${secondHalfSlope.toFixed(2)}MB/cycle  floor=${floor.toFixed(2)}  decelRatio=${decelRatio.toFixed(2)}  ` +
      `maxJump=${maxJump}MB  step=${stepDiscontinuity}  cycles=${series.length}`,
  );
  if (label === 'CLIMB') {
    console.log(
      'VERDICT: CLIMB — the per-cycle increment is SUSTAINED (second-half slope ≈ first-half),\n' +
        '         i.e. RSS rises ~linearly with no decay. The native FTS arena is NOT reclaimed\n' +
        '         by db.close(); the leak is real over a long-lived session.\n' +
        '         → plan U4 (worker/process isolation of the FTS read path) is JUSTIFIED.',
    );
  } else if (label === 'PLATEAU') {
    console.log(
      `VERDICT: PLATEAU at this corpus (${corpus}) — the per-cycle increment DECAYS to flat\n` +
        '         (second-half slope below the noise floor). db.close() reclaims the FTS arena;\n' +
        '         footprint is bounded (and the pool further caps it at MAX_POOL_SIZE). No\n' +
        '         unbounded leak. Caveat: synthetic fixture — confirm with a --via-pool run\n' +
        '         against a real large analyzed repo before fully closing plan U4.',
    );
  } else {
    console.log(
      `VERDICT: INCONCLUSIVE at this corpus (${corpus}) — the run is noisy (step discontinuity)\n` +
        '         or still decelerating without reaching flat, so neither a clean PLATEAU nor a\n' +
        '         sustained linear CLIMB can be asserted. NATIVE synthetic runs do not resolve\n' +
        '         this reliably at scale. The definitive test is a --via-pool run against a real\n' +
        '         large analyzed repo over many cycles (with GITNEXUS_POOL_RSS_TRACE=1). Plan U4\n' +
        '         stays GATED — neither closed nor built on this evidence.',
    );
  }
  console.log(
    `MACHINE: ${JSON.stringify({ mode: VIA_POOL ? 'via-pool' : 'native', corpus, baseline, firstMed, lastMed, delta, overallSlope: Number(slope.toFixed(3)), firstHalfSlope: Number(firstHalfSlope.toFixed(3)), secondHalfSlope: Number(secondHalfSlope.toFixed(3)), floor: Number(floor.toFixed(3)), decelRatio: Number(decelRatio.toFixed(3)), maxJump, stepDiscontinuity, peak, cycles: series.length, verdict: label })}`,
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
