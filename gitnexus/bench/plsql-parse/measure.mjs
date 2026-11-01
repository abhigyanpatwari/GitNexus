/**
 * Build-free PL/SQL parse-throughput harness (#3771 acceptance criterion).
 *
 * Times `extractPlSqlFacts` — pre-pass, segment split, ANTLR SLL/LL parse and
 * fact extraction — on a synthetic package body at two sizes, after one
 * warm-up pass so the ANTLR DFA cache is populated (each analyze pays the
 * cold cost once per process; see README.md for corpus numbers). It reports
 * ms/kLOC for each size and a scaling ratio `(t_large/t_small)/(lines ratio)`:
 * ~1.0 is linear, ~4.0 is quadratic at these sizes.
 *
 * The correctness gate is an order-independent sha256 fingerprint over the
 * facts of every `lang-resolution/plsql-*` fixture file plus a fixed
 * 20-subprogram synthetic body.
 *
 * Run: `node --import tsx bench/plsql-parse/measure.mjs` (prints JSON).
 * `--check` asserts the fingerprint equals baselines.json, the synthetic
 * bodies parse without syntax errors or timeouts, and the scaling ratio stays
 * under budget; exits non-zero otherwise. Absolute timings are reported, not
 * gated: they depend on the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { extractPlSqlFacts } from '../../src/core/ingestion/plsql/extract.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'lang-resolution');
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');
const PLSQL_EXTENSIONS = ['.sql', '.pks', '.pkb', '.pck', '.pls', '.plb', '.prc', '.fnc', '.trg'];

/**
 * The production, size-scaled segment deadline: a parse that stalls ends as a
 * timed-out segment, which `--check` rejects, instead of hanging the job.
 */
const OPTIONS = {};

const SMALL = 60;
const LARGE = 240;
const REPEATS = 3;

/** One package body with `n` subprograms that call, branch, read and write. */
function syntheticBody(n) {
  const units = [];
  for (let i = 0; i < n; i++) {
    const callee = i === 0 ? 'NULL' : `p${i - 1}(p_id => p_id, p_amount => v_total)`;
    units.push(
      [
        `  PROCEDURE p${i}(p_id IN NUMBER, p_amount IN NUMBER DEFAULT 0) IS`,
        `    v_total t_orders.amount%TYPE;`,
        `  BEGIN`,
        `    SELECT NVL(SUM(amount), 0) INTO v_total FROM t_orders WHERE customer_id = p_id;`,
        `    IF v_total > p_amount THEN`,
        `      UPDATE t_orders SET status = 'HELD' WHERE customer_id = p_id;`,
        `    ELSIF v_total = 0 THEN`,
        `      INSERT INTO t_audit (customer_id, note) VALUES (p_id, 'empty ${i}');`,
        `    END IF;`,
        `    ${callee};`,
        `    pkg_log.info('p${i} done');`,
        `  END p${i};`,
      ].join('\n'),
    );
  }
  return `CREATE OR REPLACE PACKAGE BODY pkg_bench AS\n${units.join('\n\n')}\nEND pkg_bench;\n/\n`;
}

function lineCount(text) {
  return text.split('\n').length;
}

function digest(facts) {
  const { firstError: _firstError, ...stable } = facts;
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function collectFixtures() {
  const out = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('plsql-')) continue;
    const stack = [path.join(FIXTURE_ROOT, entry.name)];
    while (stack.length) {
      const dir = stack.pop();
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, c.name);
        if (c.isDirectory()) stack.push(p);
        else if (PLSQL_EXTENSIONS.some((e) => c.name.toLowerCase().endsWith(e)))
          out.push({ key: path.relative(FIXTURE_ROOT, p).split(path.sep).join('/'), absPath: p });
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function fingerprint() {
  const parts = collectFixtures().map(
    (f) => `${f.key}|${digest(extractPlSqlFacts(fs.readFileSync(f.absPath, 'utf8'), OPTIONS))}`,
  );
  parts.push(`synthetic-20|${digest(extractPlSqlFacts(syntheticBody(20), OPTIONS))}`);
  return crypto.createHash('sha256').update(parts.sort().join('\n')).digest('hex');
}

function timeExtract(source) {
  let best = Number.POSITIVE_INFINITY;
  let facts;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    facts = extractPlSqlFacts(source, OPTIONS);
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, facts };
}

function measure() {
  const small = syntheticBody(SMALL);
  const large = syntheticBody(LARGE);
  const coldStart = performance.now();
  extractPlSqlFacts(small, OPTIONS);
  const coldMs = performance.now() - coldStart;
  const s = timeExtract(small);
  const l = timeExtract(large);
  const smallLines = lineCount(small);
  const largeLines = lineCount(large);
  const perKloc = (ms, lines) => +((ms * 1000) / lines).toFixed(1);
  return {
    fingerprint: fingerprint(),
    cold_ms_small: +coldMs.toFixed(1),
    small: {
      subprograms: SMALL,
      lines: smallLines,
      ms: +s.ms.toFixed(1),
      ms_per_kloc: perKloc(s.ms, smallLines),
    },
    large: {
      subprograms: LARGE,
      lines: largeLines,
      ms: +l.ms.toFixed(1),
      ms_per_kloc: perKloc(l.ms, largeLines),
    },
    scaling_ratio: +(l.ms / s.ms / (largeLines / smallLines)).toFixed(3),
    synthetic_errors: s.facts.segmentsWithErrors + l.facts.segmentsWithErrors,
    synthetic_timeouts: s.facts.segmentsTimedOut + l.facts.segmentsTimedOut,
    synthetic_calls: l.facts.calls.length,
    synthetic_accesses: l.facts.accesses.length,
  };
}

const result = measure();
console.log(JSON.stringify(result, null, 2));

if (process.argv.includes('--check')) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  if (result.fingerprint !== baseline.fingerprint)
    failures.push(
      `fingerprint drift: ${result.fingerprint} != baseline ${baseline.fingerprint} (re-baseline only for an intended facts change)`,
    );
  if (result.synthetic_timeouts !== 0)
    failures.push(
      `synthetic bodies hit the parse deadline in ${result.synthetic_timeouts} segments`,
    );
  if (result.synthetic_errors !== 0)
    failures.push(`synthetic bodies parsed with ${result.synthetic_errors} erroneous segments`);
  if (result.scaling_ratio >= baseline.scaling_budget)
    failures.push(
      `scaling ratio ${result.scaling_ratio} >= budget ${baseline.scaling_budget} (super-linear parse)`,
    );
  if (failures.length > 0) {
    for (const f of failures) console.error(`plsql-parse: ${f}`);
    process.exit(1);
  }
  console.error('plsql-parse: fingerprint and scaling within baseline');
}
