/**
 * Build-free scaling + identity bench for `resolveCppQualifiedNamespaceMember`,
 * the C++ qualified `ns::member()` receiver resolver (issue #2788).
 *
 * Before #2788 this function re-scanned EVERY parsed file — rebuilding a
 * per-file `scopesById` map each time — once per qualified call site, so the
 * scope-resolution emit phase cost O(callsites × scopes). On a 1,473-file C++
 * repo that was 25.3 min of a 33-min analyze, with 75% of total self-time in
 * this one function. It is the same bug #1990 had already fixed in the sibling
 * ADL path (`pickCppAdlCandidates` → `AdlCandidateIndex`) — the sibling shipped
 * without a scaling gate, and the bug class came straight back here. Hence this
 * bench: a per-call-site workspace scan must not be reintroduced silently.
 *
 * For a synthetic corpus at two scales it reports:
 *   - `elapsed_ms` per scale (fastest of REPS, see `fastest`) for resolving
 *     every call site once, INCLUDING the one-time index build — that build is
 *     the work the per-site scan was traded for, so hiding it would let an
 *     index that is itself quadratic pass;
 *   - a scaling ratio `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear,
 *     ~4.x quadratic at this scale gap;
 *   - a sha256 fingerprint over every `receiver::member → outcome` the corpus
 *     resolves, as the correctness gate. A fingerprint change means qualified
 *     lookup started resolving different symbols — a behaviour change, never a
 *     performance one.
 *
 * Build-free: imports the `.ts` hotpath through tsx
 * (`node --import tsx bench/cpp-qualified-ns/measure.mjs`).
 *
 * Without args: prints the JSON report.
 * With `--check`: asserts the fingerprint == the committed baseline AND the
 * scaling ratio is within budget; exits non-zero on drift/regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  clearCppInlineNamespaces,
  markCppInlineNamespaceRange,
  populateCppInlineNamespaceScopes,
  resolveCppQualifiedNamespaceMember,
} from '../../src/core/ingestion/languages/cpp/inline-namespaces.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 400;
const LARGE = 1600;
const CALLS_PER_FILE = 20;
const REPS = 7;
const WARMUP = 3;

const NO_SCOPES = {};

/**
 * Deterministic synthetic corpus — no randomness, so the fingerprint is stable.
 *
 * Per file, one `ns_f` namespace shaped like the ABI-versioning idiom the
 * reporter's repo uses (`namespace x { inline namespace v { … } }`):
 *
 *   namespace ns_f {
 *     void own0(); void own1();          // direct members
 *     inline namespace v1 { void inl0(); void dup(); }   // transitively visible
 *     inline namespace v2 { void dup(); }                // → dup is ambiguous
 *     namespace detail { void hidden0(); }               // NOT inline → invisible
 *   }
 *
 * The three outcome classes all appear, because each takes a different exit
 * from the resolver and only exercising the hit path would let a regression in
 * the miss path (the most common outcome in real source) go unmeasured:
 * resolved hit, `'ambiguous'` (#1564), and `undefined` (miss — both a wrong
 * member name and a non-inline nested member).
 */
function buildCorpus(fileCount) {
  const parsedFiles = [];
  for (let f = 0; f < fileCount; f++) {
    const filePath = `src/file${f}.cpp`;
    const scopes = [];
    let line = 1;
    const scope = (id, kind, parent, defs) => {
      const entry = {
        id,
        kind,
        parent,
        ownedDefs: defs,
        range: { startLine: line, startCol: 0, endLine: line + 1, endCol: 0 },
      };
      line += 2;
      scopes.push(entry);
      return entry;
    };
    const def = (type, qualifiedName) => ({
      nodeId: `def:${filePath}#${qualifiedName}`,
      type,
      qualifiedName,
    });

    const nsId = `sc:${f}:ns`;
    scope(nsId, 'Namespace', null, [
      def('Namespace', `ns_${f}`),
      def('Function', `ns_${f}.own0`),
      def('Function', `ns_${f}.own1`),
    ]);
    const v1 = scope(`sc:${f}:v1`, 'Namespace', nsId, [
      def('Namespace', `ns_${f}.v1`),
      def('Function', `ns_${f}.v1.inl0`),
      def('Function', `ns_${f}.v1.dup`),
    ]);
    const v2 = scope(`sc:${f}:v2`, 'Namespace', nsId, [
      def('Namespace', `ns_${f}.v2`),
      def('Function', `ns_${f}.v2.dup`),
    ]);
    scope(`sc:${f}:detail`, 'Namespace', nsId, [
      def('Namespace', `ns_${f}.detail`),
      def('Function', `ns_${f}.detail.hidden0`),
    ]);

    parsedFiles.push({ filePath, scopes, inlineRanges: [v1.range, v2.range] });
  }
  return parsedFiles;
}

/** Capture-time inline marking + `populateOwners`-time scope-id resolution, in
 *  the same order the pipeline runs them. Must re-run after every
 *  `clearCppInlineNamespaces`, which drops both the marks and the index. */
function populateInlineState(parsedFiles) {
  clearCppInlineNamespaces();
  for (const parsed of parsedFiles) {
    for (const range of parsed.inlineRanges) markCppInlineNamespaceRange(parsed.filePath, range);
    populateCppInlineNamespaceScopes(parsed);
  }
}

/** The call sites: a deterministic spread over receivers and member names so
 *  each rep resolves the same set, with hits, misses and ambiguities mixed. */
const MEMBERS = ['own0', 'inl0', 'dup', 'hidden0', 'nosuch'];
function callSites(fileCount) {
  const sites = [];
  for (let f = 0; f < fileCount; f++) {
    for (let c = 0; c < CALLS_PER_FILE; c++) {
      sites.push([`ns_${(f * 7 + c * 13) % fileCount}`, MEMBERS[c % MEMBERS.length]]);
    }
  }
  return sites;
}

/** The timed loop: resolution only. The outcome strings the fingerprint needs
 *  are built in a separate untimed pass (`outcomesOf`), so their allocation
 *  cost — which grows with the corpus and would inflate the scaling ratio on
 *  its own — never lands in the measurement. `sink` keeps the calls live. */
function resolveAll(parsedFiles, sites) {
  let sink = 0;
  for (const [receiver, member] of sites) {
    const hit = resolveCppQualifiedNamespaceMember(receiver, member, parsedFiles, NO_SCOPES);
    if (hit !== undefined) sink++;
  }
  return sink;
}

function outcomesOf(parsedFiles, sites) {
  const outcomes = [];
  for (const [receiver, member] of sites) {
    const hit = resolveCppQualifiedNamespaceMember(receiver, member, parsedFiles, NO_SCOPES);
    outcomes.push(
      `${receiver}::${member}\u0000${hit === undefined ? '<none>' : hit === 'ambiguous' ? '<ambiguous>' : hit.nodeId}`,
    );
  }
  return outcomes;
}

/**
 * MIN, not median — same rationale as bench/callable-value-flow: both scales
 * are timed in one process and every error source (scheduler preemption, GC, a
 * noisy neighbour on a shared CI runner) is additive, so the fastest observed
 * run is the closest estimate of the uncontended cost and keeps the derived
 * ratio comparable across machines.
 */
function fastest(values) {
  return Math.min(...values);
}

/** Time one full pass: index build (lazy, on the first call) + every call
 *  site. The corpus state is reset OUTSIDE the timer so the reset's own
 *  O(files) cost never lands in the measurement. */
function timeResolution(parsedFiles, sites) {
  for (let w = 0; w < WARMUP; w++) {
    populateInlineState(parsedFiles);
    resolveAll(parsedFiles, sites);
  }
  const samples = [];
  for (let r = 0; r < REPS; r++) {
    populateInlineState(parsedFiles);
    const t0 = performance.now();
    resolveAll(parsedFiles, sites);
    samples.push(performance.now() - t0);
  }
  return { ms: fastest(samples), outcomes: outcomesOf(parsedFiles, sites) };
}

function fingerprint(outcomes) {
  return crypto
    .createHash('sha256')
    .update([...outcomes].sort().join('\n'))
    .digest('hex');
}

const scales = {};
for (const [name, fileCount] of [
  ['small', SMALL],
  ['large', LARGE],
]) {
  const parsedFiles = buildCorpus(fileCount);
  const sites = callSites(fileCount);
  const { ms, outcomes } = timeResolution(parsedFiles, sites);
  scales[name] = {
    files: fileCount,
    call_sites: sites.length,
    ms: Number(ms.toFixed(3)),
    fingerprint: fingerprint(outcomes),
  };
}

const scalingRatio = scales.large.ms / scales.small.ms / (LARGE / SMALL);

const report = {
  small: scales.small,
  large: scales.large,
  scaling_ratio: Number(scalingRatio.toFixed(3)),
  fingerprint: scales.large.fingerprint,
};

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];
if (report.fingerprint !== baseline.fingerprint) {
  failures.push(
    `fingerprint drift: ${report.fingerprint} != ${baseline.fingerprint} — qualified ` +
      `namespace lookup resolved a DIFFERENT symbol set. This is a behaviour change, not a perf one.`,
  );
}
if (report.scaling_ratio > baseline.scaling_budget) {
  failures.push(
    `scaling ${report.scaling_ratio} > budget ${baseline.scaling_budget} — per-call-site cost ` +
      `now grows with corpus size again (#2788).`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[cpp-qualified-ns --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[cpp-qualified-ns --check] PASS');
