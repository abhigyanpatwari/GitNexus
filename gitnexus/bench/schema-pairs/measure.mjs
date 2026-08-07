/**
 * What a bigger `CodeRelation` FROM/TO pair set costs at query time (#2793).
 *
 * `src/core/lbug/schema.ts` declares its relation pairs from two cross products
 * plus a small hand-written remainder, and it justifies NOT adding a third cross
 * product with a number: anchored queries cost ~1.04× near production's pair
 * count but 1.6× at 786 and 2.1× at 1024. That measurement previously lived in
 * a scratch directory, so the claim could not be re-checked when someone
 * proposed widening a rule. This is it, committed.
 *
 * WHAT IT MEASURES. Against a real `@ladybugdb/core` database, with byte-identical
 * DATA at every size, it times the query shape whose plan actually depends on the
 * declared pair set:
 *
 *   MATCH (a {id: $id})-[r:CodeRelation]->(b) RETURN b.id
 *
 * Neither endpoint is labelled, so LadybugDB must consider every declared
 * FROM/TO pair as a candidate — this is the shape `impact`, `context` and
 * `detect_changes` all issue when they walk out from one node id.
 *
 * A LABEL-typed query (`MATCH (a:Function)-[r]->(b:Function)`) is measured
 * alongside it as the LOWER BOUND. Its plan prunes to a single pair, so it was
 * expected to be flat in the pair count — it is NOT. Measured here it reaches
 * 1.17× at 450 and 1.57× at 1024 against the same 332-pair reference, i.e. a
 * declared-but-unused pair costs something even when the planner never
 * considers it (per-pair catalog/storage overhead the query pays regardless).
 * So `typed_ratio_*` is not a noise control: it is the floor, and the true cost
 * of a wider pair set lies between it and `ratio_*`. Treat any run where
 * `typed_ratio` moves MORE than `ratio` as noise-dominated.
 *
 * SIZES. The pair set is a prefix of a fixed 32×32 (`NODE_TABLES`²) enumeration
 * so every size is a strict SUPERSET of the smaller ones, and the four pairs the
 * data actually uses are pinned first — so the same rows are reachable by the
 * same query at every size, and the only variable is how many UNUSED pairs the
 * table declares:
 *   -  332 — the pre-#2792 hand-written list (the historical baseline);
 *   -  450 — production before Record became linkable (#2801);
 *   -  461 — production today (two cross products + 69 hand-declared);
 *   -  641 — the third cross product schema.ts defers
 *            (`DEFINITION_ANCHOR_LABELS × {CodeElement, Section, Typedef, Union,
 *            Namespace, Impl, TypeAlias, Static, Template}`), which would leave
 *            only ~29 hand-declared lines;
 *   -  786 — the size an earlier revision of that comment attributed to the
 *            third rule (it is 641; 786 is kept as a measured waypoint);
 *   - 1024 — the full cross product, the ceiling.
 *
 * Ratios are reported against 332, the smallest size — the production-size
 * ratio is the number schema.ts quotes.
 *
 * CORRECTNESS GATE. Before timing anything it round-trips the REAL
 * `SCHEMA_QUERIES` through a real database and asserts that
 * `CALL SHOW_CONNECTION('CodeRelation')` reports exactly the pairs
 * `parseRelationSchemaPairs` finds in `RELATION_SCHEMA`. That is the invariant
 * that matters and it needs no magic number: it proves the DDL LadybugDB
 * ACCEPTED carries the pair set our own parser believes it declares. (A
 * duplicated FROM/TO would not even get this far — LadybugDB rejects the
 * `CREATE REL TABLE` outright, which is why that failure kills every `analyze`.)
 * The absolute count is reported as `declared_pairs` for the record.
 *
 * Build-free: imports the `.ts` sources through tsx.
 *
 *   node --import tsx bench/schema-pairs/measure.mjs           # print JSON lines
 *   node --import tsx bench/schema-pairs/measure.mjs --check    # gate vs baselines.json
 *
 * `--check` fails if the correctness gate breaks, or if the production-size
 * ratio exceeds its budget — i.e. if production's own pair count starts
 * costing materially more than the hand-written list it replaced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_TABLES } from 'gitnexus-shared';
import {
  NODE_SCHEMA_QUERIES,
  RELATION_SCHEMA,
  REL_TABLE_NAME,
} from '../../src/core/lbug/schema.ts';
import { parseRelationSchemaPairs } from '../../src/core/lbug/rel-pair-routing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const lbug = (await import('@ladybugdb/core')).default;

// ---- sizes + the pair enumeration every size is a prefix of ----

const REFERENCE_SIZE = 332; // ratios are relative to this
// Derive production from the same executable DDL the correctness gate
// round-trips. A LINKABLE_LABELS widening must not require a second copied
// count here — and cannot silently select a stale/missing budget key.
const PRODUCTION_SIZE = parseRelationSchemaPairs(RELATION_SCHEMA).size;
const SIZES = [...new Set([REFERENCE_SIZE, 450, PRODUCTION_SIZE, 641, 786, 1024])].sort(
  (a, b) => a - b,
);

// The four pairs the synthetic data uses. Pinned to the FRONT of the
// enumeration so they are declared at every size — otherwise a smaller pair set
// would simply carry fewer rows and the comparison would measure data volume,
// not pair-set size.
const DATA_PAIRS = [
  ['File', 'Function'],
  ['Function', 'Function'],
  ['Function', 'Class'],
  ['Class', 'Method'],
];

const pairKey = ([from, to]) => `${from}|${to}`;

// NODE_TABLES² in declaration order, data pairs first, deduped. 32² = 1024.
const PAIR_UNIVERSE = (() => {
  const seen = new Set(DATA_PAIRS.map(pairKey));
  const all = [...DATA_PAIRS];
  for (const from of NODE_TABLES) {
    for (const to of NODE_TABLES) {
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push([from, to]);
    }
  }
  return all;
})();

if (PAIR_UNIVERSE.length !== NODE_TABLES.length ** 2) {
  throw new Error(
    `bench: pair universe is ${PAIR_UNIVERSE.length}, expected ${NODE_TABLES.length ** 2} ` +
      `(NODE_TABLES changed — update SIZES, the 1024 ceiling is no longer the ceiling)`,
  );
}
for (const size of SIZES) {
  if (size > PAIR_UNIVERSE.length) {
    throw new Error(`bench: size ${size} exceeds the ${PAIR_UNIVERSE.length}-pair universe`);
  }
}

const relTableDdlFor = (size) => {
  const pairs = PAIR_UNIVERSE.slice(0, size).map(([from, to]) => `  FROM \`${from}\` TO \`${to}\``);
  return `CREATE REL TABLE ${REL_TABLE_NAME} (\n${pairs.join(',\n')},\n  type STRING,\n  confidence DOUBLE,\n  reason STRING,\n  step INT32\n)`;
};

// ---- synthetic data (identical at every size) ----

const FILES = 20;
const FNS_PER_FILE = 8;
const CLASSES = 40;
const METHODS_PER_CLASS = 4;
const CALLS_PER_FN = 3;
const REPS = 15; // median over reps
const ANCHORS = 40; // distinct anchor ids queried per rep

// Batched with UNWIND rather than one statement per row: per-statement overhead
// dwarfs the insert itself here, and load time is not what this bench measures.
function dataStatements() {
  const stmts = [];
  const fnIds = [];
  const classIds = [];
  const methodIds = [];
  const fileIds = [];
  for (let f = 0; f < FILES; f++) fileIds.push(`file-${f}`);
  for (let f = 0; f < FILES; f++) {
    for (let i = 0; i < FNS_PER_FILE; i++) fnIds.push(`fn-${f}-${i}`);
  }
  for (let c = 0; c < CLASSES; c++) {
    classIds.push(`cls-${c}`);
    for (let m = 0; m < METHODS_PER_CLASS; m++) methodIds.push(`m-${c}-${m}`);
  }

  const nodeBatch = (label, ids) =>
    `UNWIND [${ids.map((id) => `{id: '${id}'}`).join(', ')}] AS r ` +
    `CREATE (:\`${label}\` {id: r.id, name: r.id, filePath: 'bench.ts'})`;
  stmts.push(nodeBatch('File', fileIds));
  stmts.push(nodeBatch('Function', fnIds));
  stmts.push(nodeBatch('Class', classIds));
  stmts.push(nodeBatch('Method', methodIds));

  const relBatch = (fromLabel, toLabel, type, edges) =>
    `UNWIND [${edges.map(([f, t]) => `{f: '${f}', t: '${t}'}`).join(', ')}] AS e ` +
    `MATCH (a:\`${fromLabel}\` {id: e.f}), (b:\`${toLabel}\` {id: e.t}) ` +
    `CREATE (a)-[:${REL_TABLE_NAME} {type: '${type}', confidence: 1.0, reason: 'bench', step: 0}]->(b)`;

  const contains = [];
  for (let f = 0; f < FILES; f++) {
    for (let i = 0; i < FNS_PER_FILE; i++) contains.push([`file-${f}`, `fn-${f}-${i}`]);
  }
  stmts.push(relBatch('File', 'Function', 'CONTAINS', contains));

  // Function→Function calls: each fn calls the next CALLS_PER_FN, wrapping.
  const calls = [];
  for (let i = 0; i < fnIds.length; i++) {
    for (let k = 1; k <= CALLS_PER_FN; k++) calls.push([fnIds[i], fnIds[(i + k) % fnIds.length]]);
  }
  stmts.push(relBatch('Function', 'Function', 'CALLS', calls));

  const uses = fnIds.map((id, i) => [id, classIds[i % classIds.length]]);
  stmts.push(relBatch('Function', 'Class', 'USES', uses));

  const hasMethod = [];
  for (let c = 0; c < CLASSES; c++) {
    for (let m = 0; m < METHODS_PER_CLASS; m++) hasMethod.push([`cls-${c}`, `m-${c}-${m}`]);
  }
  stmts.push(relBatch('Class', 'Method', 'HAS_METHOD', hasMethod));

  // Anchors: functions, which have out-edges on two distinct declared pairs.
  return { stmts, anchors: fnIds.slice(0, ANCHORS) };
}

const { stmts: DATA_STATEMENTS, anchors: ANCHOR_IDS } = dataStatements();

// ---- timing ----

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const withDb = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-bench-pairs-'));
  const db = new lbug.Database(path.join(dir, 'db'));
  const conn = new lbug.Connection(db);
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

async function runAll(conn, statements) {
  for (const s of statements) await conn.query(s);
}

// The measured shape: BOTH endpoints untyped, anchored by id. LadybugDB must
// consider every declared FROM/TO pair as a candidate.
const UNTYPED_QUERY = (id) =>
  `MATCH (a {id: '${id}'})-[r:${REL_TABLE_NAME}]->(b) RETURN b.id AS id, r.type AS type`;
// The lower bound: both endpoints labelled, so the planner prunes to one pair.
// Still not flat in the pair count (see the header) — an unused declared pair
// costs something even when the plan never touches it.
const TYPED_QUERY = (id) =>
  `MATCH (a:Function {id: '${id}'})-[r:${REL_TABLE_NAME}]->(b:Function) RETURN b.id AS id`;

async function timeQueries(conn, build) {
  // Warm: run the whole anchor sweep once uncounted (plan cache + page cache).
  for (const id of ANCHOR_IDS) await (await conn.query(build(id))).getAll();
  const samples = [];
  let rows = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint();
    let n = 0;
    for (const id of ANCHOR_IDS) n += (await (await conn.query(build(id))).getAll()).length;
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    rows = n;
  }
  return { ms: median(samples), rows };
}

async function measureSize(size) {
  return withDb(async (conn) => {
    for (const q of NODE_SCHEMA_QUERIES) await conn.query(q);
    await conn.query(relTableDdlFor(size));
    await runAll(conn, DATA_STATEMENTS);
    const untyped = await timeQueries(conn, UNTYPED_QUERY);
    const typed = await timeQueries(conn, TYPED_QUERY);
    return {
      pairs: size,
      untyped_ms: Number(untyped.ms.toFixed(3)),
      untyped_rows: untyped.rows,
      typed_ms: Number(typed.ms.toFixed(3)),
      typed_rows: typed.rows,
    };
  });
}

// ---- correctness gate: the REAL schema, round-tripped ----

async function verifyRealSchema() {
  return withDb(async (conn) => {
    for (const q of NODE_SCHEMA_QUERIES) await conn.query(q);
    // If RELATION_SCHEMA declared a pair twice, LadybugDB rejects this outright
    // — the failure mode that kills every `analyze`, not just one repo's.
    await conn.query(RELATION_SCHEMA);
    const res = await conn.query(`CALL SHOW_CONNECTION('${REL_TABLE_NAME}') RETURN *`);
    const rows = await res.getAll();
    const actual = new Set(
      rows.map(
        (r) =>
          `${r['source table name'] ?? r.source}|${r['destination table name'] ?? r.destination}`,
      ),
    );
    const expected = parseRelationSchemaPairs(RELATION_SCHEMA);
    const missing = [...expected].filter((p) => !actual.has(p)).sort();
    const extra = [...actual].filter((p) => !expected.has(p)).sort();
    return { declared_pairs: expected.size, db_pairs: actual.size, missing, extra };
  });
}

// ---- run ----

const CHECK = process.argv.includes('--check');
const failures = [];

const verified = await verifyRealSchema();
if (verified.missing.length > 0 || verified.extra.length > 0) {
  failures.push(
    `RELATION_SCHEMA round-trip mismatch: ${verified.missing.length} pair(s) parsed but absent ` +
      `from SHOW_CONNECTION (${verified.missing.slice(0, 5).join(', ')}), ${verified.extra.length} ` +
      `present in the DB but unparsed (${verified.extra.slice(0, 5).join(', ')})`,
  );
}

const results = [];
for (const size of SIZES) results.push(await measureSize(size));

const reference = results.find((r) => r.pairs === REFERENCE_SIZE);
const summary = {
  ...verified,
  missing: undefined,
  extra: undefined,
  reference_pairs: REFERENCE_SIZE,
};
for (const r of results) {
  summary[`untyped_ms_${r.pairs}`] = r.untyped_ms;
  summary[`typed_ms_${r.pairs}`] = r.typed_ms;
  summary[`ratio_${r.pairs}`] = Number((r.untyped_ms / reference.untyped_ms).toFixed(3));
  summary[`typed_ratio_${r.pairs}`] = Number((r.typed_ms / reference.typed_ms).toFixed(3));
}

// Row counts must be identical at every size — otherwise the sizes are not
// carrying the same data and the ratios mean nothing.
const rowShapes = new Set(results.map((r) => `${r.untyped_rows}/${r.typed_rows}`));
if (rowShapes.size !== 1) {
  failures.push(
    `row counts differ across pair-set sizes (${[...rowShapes].join(' vs ')}) — the data pins ` +
      `in DATA_PAIRS are not holding, so the ratios compare different graphs`,
  );
}

if (!CHECK) {
  for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');
  process.stdout.write(JSON.stringify(summary) + '\n');
} else {
  const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const budgetKey = `ratio_${PRODUCTION_SIZE}_budget`;
  const budget = baselines[budgetKey];
  if (budget === undefined) {
    failures.push(`no ${budgetKey} in baselines.json — the production gate is disarmed`);
  } else if (typeof budget !== 'number' || !Number.isFinite(budget)) {
    failures.push(`${budgetKey} must be a finite number (got ${JSON.stringify(budget)})`);
  } else if (summary[`ratio_${PRODUCTION_SIZE}`] >= budget) {
    failures.push(
      `production pair set (${PRODUCTION_SIZE}) costs ${summary[`ratio_${PRODUCTION_SIZE}`]}× vs ` +
        `${REFERENCE_SIZE} pairs, >= budget ${budget} (untyped ${reference.untyped_ms}ms -> ` +
        `${summary[`untyped_ms_${PRODUCTION_SIZE}`]}ms; typed control ` +
        `${summary[`typed_ratio_${PRODUCTION_SIZE}`]}×)`,
    );
  }
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`[schema-pairs] FAIL: ${f}\n`);
  process.exit(1);
}
if (CHECK) process.stderr.write(`[schema-pairs --check] PASS (${results.length} sizes)\n`);
