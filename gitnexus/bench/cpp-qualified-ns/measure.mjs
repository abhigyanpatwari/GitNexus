/**
 * Build-free scaling + identity bench for `resolveCppQualifiedNamespaceMember`,
 * the C++ qualified `ns::member()` receiver resolver (issue #2788).
 *
 * Before #2788 this function re-scanned EVERY parsed file — rebuilding a
 * per-file `scopesById` map each time — once per qualified call site, so the
 * scope-resolution emit phase cost O(callsites × scopes). On a 1,473-file C++
 * repo that was 25.3 min of a 33-min analyze, with 75% of total self-time in
 * this one function. It is the same bug #1990 had already fixed in the sibling
 * ADL path (`pickCppAdlCandidates` → `AdlCandidateIndex`). #1990 DID ship a
 * scaling gate for that path — `test/integration/cpp-adl-benchmark.test.ts`,
 * which asserts `emitRatio < fileRatio^1.5` — but it could never have caught
 * this one, for two independent reasons: its corpus asserts
 * `callsResolved === 0`, i.e. it generates only UNRESOLVED ADL sites, so it
 * never drives the qualified-receiver path at all; and it is
 * `describe.skipIf(!BENCH_ENABLED)` while the single CI step that sets
 * `GITNEXUS_BENCH=1` names its test files explicitly and, until this PR wired
 * it in, listed neither C++ bench — so it had never executed in CI. Even now
 * that it runs, the `callsResolved === 0` half stands: it still cannot reach
 * this path. Hence this bench, in an always-on step: a per-call-site workspace
 * scan must not be reintroduced silently.
 *
 * For a synthetic corpus at two scales it reports:
 *   - `elapsed_ms` per scale (fastest of REPS, see `fastest`) for resolving
 *     every call site once, INCLUDING the one-time index build — that build is
 *     the work the per-site scan was traded for, so hiding it would let an
 *     index that is itself quadratic pass;
 *   - a scaling ratio `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear,
 *     ~4.x quadratic at this scale gap;
 *   - a sha256 fingerprint over every `receiver::member(callsite) → outcome`
 *     the corpus resolves, as the correctness gate. A fingerprint change means
 *     qualified lookup started resolving different symbols — a behaviour
 *     change, never a performance one.
 *
 * A gate only covers the code path its corpus drives. Two properties below are
 * therefore load-bearing and must not be "simplified" away:
 *
 *   1. **The receiver mix is production-shaped: ~1 in 5 receivers names a
 *      namespace, the other ~4 name nothing.** Case 1.5 in
 *      `scope-resolution/passes/receiver-bound-calls.ts` is reached by EVERY
 *      plain-identifier receiver call — `obj.size()`, `Widget::make()`,
 *      `buf.data()` — so in real source the overwhelming majority of calls into
 *      this resolver are receiver MISSES, not member misses inside a resolved
 *      receiver. An earlier revision of this bench drew every receiver from
 *      `ns_${…}`, i.e. always a namespace the corpus declared, so the receiver
 *      lookup never missed. Measured consequence: a "defensive full rescan when
 *      the receiver bucket is absent" regression — the single most plausible
 *      way this bug returns — scored 1.332 against the 1.8 budget and printed
 *      PASS, while costing 507× on a production-shaped corpus.
 *   2. **The corpus contains every structural shape whose loss the fingerprint
 *      is supposed to catch** (see `buildCorpus`), including a batch of sites
 *      that pass a real `Callsite`. Without those, `narrowOverloadCandidates` /
 *      `cppConversionRank` / `isOverloadAmbiguousAfterNormalization` are not in
 *      the fingerprinted surface at all, and behaviour-only regressions there
 *      re-fingerprint byte-identically.
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
/** Sized so the SMALL arm measures in the tens of ms rather than ~1.7 ms.
 *  Sub-2 ms samples are dominated by timer granularity and scheduler noise on
 *  a shared runner, which is what made the ratio drift out of its documented
 *  band under load; see `_scaling_note` in baselines.json. */
const CALLS_PER_FILE = 480;
const REPS = 7;
const WARMUP = 3;

/** 1 in N receivers names a declared namespace; the rest name nothing. Header
 *  property 1 is why this ratio, and not an always-hits corpus. */
const NS_RECEIVER_IN = 5;

const NO_SCOPES = {};

/**
 * Deterministic 32-bit avalanche (murmur3 finalizer). Stands in for
 * `Math.random()` — the corpus, the receiver mix and therefore the fingerprint
 * must be byte-reproducible across machines and Node versions.
 */
function mix(n) {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Deterministic synthetic corpus — no randomness, so the fingerprint is stable.
 *
 * Per file `f`, three top-level namespaces. Every shape here exists because
 * some behaviour of `resolveCppQualifiedNamespaceMember` is unobservable
 * without it; dropping one silently un-gates that behaviour.
 *
 *   namespace ns_f {                         // ABI-versioning idiom (std::__1)
 *     void own0(); void own1();              // direct members            → hit
 *     void both(int);                        // ALSO declared in v1 below
 *     void over(int);                        // overload set spanning levels
 *     inline namespace v1 {                  // transitively visible
 *       void inl0();                         //                           → hit
 *       void dup();
 *       void both(double);                   // the inline-child twin of `both`
 *       void over(int, int); void over(double);
 *       void same(int);
 *     }
 *     inline namespace v2 {
 *       void dup();                          // two inline children → ambiguous
 *       void same(int);                      // identical signature → ambiguous
 *     }
 *     namespace detail { void hidden0(); }   // NOT inline → invisible    → miss
 *   }
 *
 *   namespace twin_f { inline namespace twin_f { void twinned(); } }
 *   namespace shared_{f>>1} { void part{f&1}(); }
 *
 * What each shape gates:
 *   - `own0` / `inl0` / `hidden0` / `nosuch`: the three outcome classes (hit
 *     from the namespace's own defs, hit through an inline child, miss), each
 *     a different exit from the resolver.
 *   - `dup` across v1 and v2: `'ambiguous'` (#1564).
 *   - `twin_f`: the same-name inline nest — the only shape that observes
 *     `gatherQualifiedNsMember`'s `visited` dedup, without which the one
 *     `twinned` is collected twice and a resolved def flips to `'ambiguous'`
 *     (that function's comment explains why both scopes land on one receiver).
 *   - `shared_g` declared by files 2g and 2g+1: C++ namespaces are open, so one
 *     receiver's members are spread over however many files reopen it. The
 *     legacy per-call-site scan got this for free; the index has to merge
 *     across the whole `parsedFiles` array. `part0` and `part1` are declared in
 *     DIFFERENT files and both must resolve.
 *   - `both` at the namespace level and in the inline child: pins BOTH
 *     collection sources by nodeId, via the two `both` call sites that select
 *     between them on argument type. Drop own-def collection and the `int`
 *     probe moves; drop inline-child descent and the `double` probe moves. A
 *     pure REORDER of the two stays invisible, and correctly so: the return
 *     contract is order-blind — see `QualifiedNsMemberIndex.rootsByReceiver`.
 *   - `over` / `same` with a real `Callsite`: see `NS_PROBES`.
 */
function buildCorpus(fileCount) {
  const parsedFiles = [];
  for (let f = 0; f < fileCount; f++) {
    const filePath = `src/file${f}.cpp`;
    const scopes = [];
    const inlineRanges = [];
    let line = 1;
    /** Push one Namespace scope with a range unique within this file, so
     *  `populateCppInlineNamespaceScopes` marks exactly the intended scopes. */
    const scope = (id, parent, ownedDefs, isInline = false) => {
      const range = { startLine: line, startCol: 0, endLine: line + 1, endCol: 0 };
      line += 2;
      scopes.push({ id, kind: 'Namespace', parent, ownedDefs, range });
      if (isInline) inlineRanges.push(range);
      return id;
    };
    const ns = (qualifiedName) => ({
      nodeId: `def:${filePath}#${qualifiedName}`,
      type: 'Namespace',
      qualifiedName,
    });
    /** A callable def. `parameterTypes` are what makes overloads distinguishable
     *  both to `narrowOverloadCandidates` and — via the nodeId, exactly as the
     *  real C++ node keys do it — to the fingerprint. */
    const fn = (qualifiedName, parameterTypes) =>
      parameterTypes === undefined
        ? { nodeId: `def:${filePath}#${qualifiedName}`, type: 'Function', qualifiedName }
        : {
            nodeId: `def:${filePath}#${qualifiedName}(${parameterTypes.join(',')})`,
            type: 'Function',
            qualifiedName,
            parameterTypes,
            parameterCount: parameterTypes.length,
            requiredParameterCount: parameterTypes.length,
          };

    const nsId = scope(`sc:${f}:ns`, null, [
      ns(`ns_${f}`),
      fn(`ns_${f}.own0`),
      fn(`ns_${f}.own1`),
      fn(`ns_${f}.both`, ['int']),
      fn(`ns_${f}.over`, ['int']),
    ]);
    scope(
      `sc:${f}:v1`,
      nsId,
      [
        ns(`ns_${f}.v1`),
        fn(`ns_${f}.v1.inl0`),
        fn(`ns_${f}.v1.dup`),
        fn(`ns_${f}.v1.both`, ['double']),
        fn(`ns_${f}.v1.over`, ['int', 'int']),
        fn(`ns_${f}.v1.over`, ['double']),
        fn(`ns_${f}.v1.same`, ['int']),
      ],
      true,
    );
    scope(
      `sc:${f}:v2`,
      nsId,
      [ns(`ns_${f}.v2`), fn(`ns_${f}.v2.dup`), fn(`ns_${f}.v2.same`, ['int'])],
      true,
    );
    scope(`sc:${f}:detail`, nsId, [ns(`ns_${f}.detail`), fn(`ns_${f}.detail.hidden0`)]);

    const twinId = scope(`sc:${f}:twin`, null, [ns(`twin_${f}`)]);
    scope(
      `sc:${f}:twin@inner`,
      twinId,
      [ns(`twin_${f}.twin_${f}`), fn(`twin_${f}.twin_${f}.twinned`)],
      true,
    );

    const group = f >> 1;
    scope(`sc:${f}:shared`, null, [ns(`shared_${group}`), fn(`shared_${group}.part${f & 1}`)]);

    parsedFiles.push({ filePath, scopes, inlineRanges });
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

/**
 * Namespace-receiver probes: `[family, member, callsite]`. Drawn for the ~1 in
 * `NS_RECEIVER_IN` call sites whose receiver actually names a namespace.
 *
 * The tail entries pass a real `Callsite`, which is the only way any of
 * `narrowOverloadCandidates`, `cppConversionRank` or
 * `isOverloadAmbiguousAfterNormalization` is reached — the resolver threads
 * `callsite?.arity` / `callsite?.argumentTypes` into narrowing, and with no
 * callsite those filters are pass-throughs. Each one is chosen to land on a
 * DIFFERENT exit, so the fingerprint pins the whole narrowing ladder:
 *   - `over(int)`            → exact-type filter, unique survivor (ns level)
 *   - `over(int,int)`        → arity filter, unique survivor (inline child)
 *   - `over(double)`         → exact-type filter, unique survivor (inline child)
 *   - `over(char)`           → no exact match, `cppConversionRank` dominance
 *                              picks `over(int)` (promotion 1) over
 *                              `over(double)` (standard conversion 2)
 *   - `over(braced-init)`    → conversion ranking rejects every candidate and
 *                              `CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES` turns
 *                              that into an empty set → `undefined`
 *   - `over` with arity 9    → arity filter empties an all-known-bounds set,
 *                              the authoritative-empty branch → `undefined`
 *   - `same(int)`            → two identical signatures survive narrowing →
 *                              `isOverloadAmbiguousAfterNormalization` → `'ambiguous'`
 *   - `both(int)`/`both(double)` → select the namespace-level def and the
 *                              inline-child def respectively, pinning both
 *                              collection sources by nodeId
 */
const NS_PROBES = [
  ['ns', 'own0', undefined],
  ['ns', 'own1', undefined],
  ['ns', 'inl0', undefined],
  ['ns', 'dup', undefined],
  ['ns', 'hidden0', undefined],
  ['ns', 'nosuch', undefined],
  ['ns', 'both', undefined],
  ['twin', 'twinned', undefined],
  ['twin', 'nosuch', undefined],
  ['shared', 'part0', undefined],
  ['shared', 'part1', undefined],
  ['ns', 'over', { arity: 1, argumentTypes: ['int'] }],
  ['ns', 'over', { arity: 2, argumentTypes: ['int', 'int'] }],
  ['ns', 'over', { arity: 1, argumentTypes: ['double'] }],
  ['ns', 'over', { arity: 1, argumentTypes: ['char'] }],
  ['ns', 'over', { arity: 1, argumentTypes: ['braced-init:int:3'] }],
  ['ns', 'over', { arity: 9, argumentTypes: [] }],
  ['ns', 'same', { arity: 1, argumentTypes: ['int'] }],
  ['ns', 'both', { arity: 1, argumentTypes: ['int'] }],
  ['ns', 'both', { arity: 1, argumentTypes: ['double'] }],
];

/** Members asked of the non-namespace receivers. Real-source member names, so
 *  the miss is a receiver miss and not a member miss. */
const MISS_MEMBERS = ['size', 'begin', 'data', 'reset', 'own0', 'dup'];

/** A plain identifier naming NO namespace in the corpus — a local, a type, a
 *  buffer. The ~4-in-5 majority of header property 1. */
function missReceiver(key) {
  const shape = key % 3;
  if (shape === 0) return `obj${key % 97}`;
  if (shape === 1) return `Widget${key % 31}`;
  return `buf${key % 197}`;
}

/**
 * The call sites: `[receiver, member, callsite]`, deterministic, with the
 * production receiver mix (~1 in `NS_RECEIVER_IN` names a namespace).
 *
 * Two independently mixed keys per site so the receiver class (`a`) and the
 * probe choice (`b`) do not correlate — deriving both from one linear key made
 * `key % NS_RECEIVER_IN === 0` imply `key % NS_PROBES.length ∈ {0, 5}`, which
 * silently reduced the probe set to two entries.
 */
function callSites(fileCount) {
  const sharedGroups = Math.ceil(fileCount / 2);
  const sites = [];
  let nsReceiverSites = 0;
  /** The declared-namespace receiver a probe family asks for. */
  const nsReceiver = (family, key) => {
    if (family === 'twin') return `twin_${key % fileCount}`;
    if (family === 'shared') return `shared_${key % sharedGroups}`;
    return `ns_${key % fileCount}`;
  };
  const pushNs = (probe, key) => {
    sites.push([nsReceiver(probe[0], key), probe[1], probe[2]]);
    nsReceiverSites++;
  };
  // Coverage prelude: every probe at least once at BOTH scales, so the
  // fingerprinted outcome set never depends on how the mixer happens to spread.
  for (let p = 0; p < NS_PROBES.length; p++) pushNs(NS_PROBES[p], p);
  for (let f = 0; f < fileCount; f++) {
    for (let c = 0; c < CALLS_PER_FILE; c++) {
      const a = mix(f * 65599 + c);
      const b = mix(a ^ 0x9e3779b9);
      if (a % NS_RECEIVER_IN === 0) pushNs(NS_PROBES[b % NS_PROBES.length], b);
      else sites.push([missReceiver(b), MISS_MEMBERS[a % MISS_MEMBERS.length], undefined]);
    }
  }
  return { sites, nsReceiverSites };
}

/** The timed loop: resolution only. The outcome strings the fingerprint needs
 *  are built in a separate untimed pass (`outcomesOf`), so their allocation
 *  cost — which grows with the corpus and would inflate the scaling ratio on
 *  its own — never lands in the measurement. `sink` keeps the calls live. */
function resolveAll(parsedFiles, sites) {
  let sink = 0;
  for (const [receiver, member, callsite] of sites) {
    const hit = resolveCppQualifiedNamespaceMember(
      receiver,
      member,
      parsedFiles,
      NO_SCOPES,
      callsite,
    );
    if (hit !== undefined) sink++;
  }
  return sink;
}

/** Fingerprint key for one site. The callsite is part of the key: `ns::over`
 *  resolves to a different def per arity/argument-type, and collapsing those
 *  onto one key would drop the whole narrowing ladder from the gate. */
function siteKey(receiver, member, callsite) {
  const args =
    callsite === undefined ? '' : `${callsite.arity}|${callsite.argumentTypes.join(',')}`;
  return `${receiver}::${member}(${args})`;
}

/** Untimed identity pass, one resolve per DISTINCT `siteKey`. On a fixed corpus
 *  the resolver is a pure function of `(receiver, member, callsite)`, so a
 *  repeated site can only re-derive what the first occurrence already put in
 *  the Set — the same argument that makes collecting into a Set correct makes
 *  skipping the repeat correct. That is nearly the whole pass: the 192k/768k
 *  sites carry only 2,330/3,470 distinct outcomes. */
function outcomesOf(parsedFiles, sites) {
  const outcomes = new Set();
  const seen = new Set();
  for (const [receiver, member, callsite] of sites) {
    const key = siteKey(receiver, member, callsite);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = resolveCppQualifiedNamespaceMember(
      receiver,
      member,
      parsedFiles,
      NO_SCOPES,
      callsite,
    );
    outcomes.add(
      `${key}\u0000${hit === undefined ? '<none>' : hit === 'ambiguous' ? '<ambiguous>' : hit.nodeId}`,
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
  const { sites, nsReceiverSites } = callSites(fileCount);
  const { ms, outcomes } = timeResolution(parsedFiles, sites);
  scales[name] = {
    files: fileCount,
    call_sites: sites.length,
    // Reported, not asserted: `ns_receiver_sites` evidences header property 1's
    // mix and `distinct_outcomes` the fingerprinted surface's size — a corpus
    // edit collapsing either still yields a "valid" fingerprint over far less.
    ns_receiver_sites: nsReceiverSites,
    distinct_outcomes: outcomes.size,
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
      `now grows with corpus size again (#2788). Timing arm: re-run on an idle machine before ` +
      `investigating (see _scaling_note in baselines.json); the fingerprint arm never warrants a re-run.`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[cpp-qualified-ns --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[cpp-qualified-ns --check] PASS');
