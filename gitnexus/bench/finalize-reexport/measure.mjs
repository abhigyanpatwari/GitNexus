/**
 * Build-free scaling bench for `buildReexportClosures`, the re-export closure
 * pass inside `finalize`.
 *
 * WHY THIS EXISTS. Until #2864 the closure sub-graph admitted only `reexport`
 * and `wildcard` drafts, so its input was TypeScript barrel files: a handful
 * of edges, shallow chains. #2864 admits `named`/`alias` drafts flagged
 * `reexportsName`, which for Python is every module-level `from m import x` —
 * measured ~20x more edges on the CPython stdlib, and cyclic SCCs where there
 * were none. The pass went from "rarely runs" to "runs over the whole named
 * import graph", and nothing measured it.
 *
 * The specific regression this guards is a QUADRATIC, and it has already
 * happened once. `populateFileClosure` copies the inherited `via` array at
 * every hop, so an unbounded chain is Theta(depth^2) in time AND retained
 * memory. `MAX_REEXPORT_DEPTH = 100` bounded it until commit `fc919ad6`
 * removed it — a correct call for shallow TS barrels, invisible for years,
 * and wrong the moment the input class changed. `MAX_VIA_LENGTH` restores the
 * bound; this bench is what notices if it goes away again. Measured at
 * depth 400: 67 ms / 145 MB uncapped vs 25 ms / 40 MB capped.
 *
 * TWO ARMS, deliberately not one, and only one of them is a timing arm:
 *
 *   - `max_via_len` — EXACT and deterministic. Builds a chain far deeper than
 *     the cap and asserts the longest emitted `transitiveVia` is exactly
 *     `MAX_VIA_LENGTH`. Removing the cap is directly observable as a longer
 *     array, so this catches it with zero flake.
 *
 *     This started life as a `depth_ratio` timing arm and that was a BAD GATE.
 *     Sampled five times capped it scored 2.71-3.52, and three times uncapped
 *     it scored 5.87-7.65 — the ranges nearly touch, and one uncapped run came
 *     in UNDER the budget. A gate that passes a third of the time on a broken
 *     build is worse than no gate, because it is read as evidence. The
 *     quadratic is real, but at these depths the pass's linear work dilutes it
 *     enough that wall-clock cannot separate the two cleanly. The structural
 *     assertion can, so it is the one that gates.
 *
 *   - `width_ms` — an absolute ceiling on a wide, shallow, realistic package
 *     corpus (the shape a real Python repo actually has). Structural checks
 *     cannot see a constant factor: reintroducing a per-lookup linear scan of
 *     a target's `localDefs` leaves every array length untouched while making
 *     every real analyze slower. This arm IS timing-sensitive — re-run on an
 *     idle machine before investigating. Its budget is deliberately loose; it
 *     is here to catch a doubling, not to police drift.
 *
 * Both arms feed `finalize` through INDEXED hooks. The obvious mistake is to
 * reuse the unit tests' `defaultHooks`, whose `resolveImportTarget` does
 * `files.some(...)` per import — that is O(imports x files) in the FIXTURE,
 * and it swamps the pass under test so completely that removing the cap
 * measures as no change at all.
 *
 * Usage:
 *   node --import tsx bench/finalize-reexport/measure.mjs           # report
 *   node --import tsx bench/finalize-reexport/measure.mjs --check   # CI gate
 */
import { performance } from 'node:perf_hooks';
import { finalize } from 'gitnexus-shared';

/** Must equal `MAX_VIA_LENGTH` in `gitnexus-shared`'s finalize-algorithm.ts. */
const EXPECTED_MAX_VIA = 32;
// Generous absolute ceiling — this arm exists to catch a restored O(n^2)
// scan (which more than doubles it), not to police small drift.
const WIDTH_MS_BUDGET = 1200;

const PROBE_DEPTH = 400;

const deriveSimple = (d) => {
  const q = d.qualifiedName;
  if (q === undefined || q.length === 0) return null;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
};

function hooksFor(files) {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  const byScope = new Map(files.map((f) => [f.moduleScope, f]));
  return {
    resolveImportTarget: (raw) => (raw !== null && byPath.has(raw) ? raw : null),
    expandsWildcardTo: (scope) => {
      const t = byScope.get(scope);
      return t === undefined ? [] : t.localDefs.map(deriveSimple).filter((n) => n !== null);
    },
    mergeBindings: (existing, incoming) => [...existing, ...incoming],
  };
}

const mkFile = (filePath, localDefs, parsedImports) => ({
  filePath,
  moduleScope: `scope:${filePath}#1:0-9999:0:Module`,
  localDefs,
  parsedImports,
});
const mkDef = (qn) => ({ nodeId: `def:${qn}`, filePath: 'x', type: 'Function', qualifiedName: qn });
const reexporting = (name, targetRaw) => ({
  kind: 'named',
  localName: name,
  importedName: name,
  targetRaw,
  reexportsName: true,
});

/** A `__init__.py` chain N deep, each hop republishing the same names. */
function chainCorpus(depth, names = 20) {
  const files = [
    mkFile(
      'leaf.py',
      Array.from({ length: names }, (_, j) => mkDef(`leaf.fn${j}`)),
      [],
    ),
  ];
  let prev = 'leaf.py';
  for (let d = 0; d < depth; d++) {
    const p = `hop${d}.py`;
    files.push(
      mkFile(
        p,
        [],
        Array.from({ length: names }, (_, j) => reexporting(`fn${j}`, prev)),
      ),
    );
    prev = p;
  }
  files.push(
    mkFile(
      'app.py',
      [],
      Array.from({ length: names }, (_, j) => ({
        kind: 'named',
        localName: `fn${j}`,
        importedName: `fn${j}`,
        targetRaw: prev,
      })),
    ),
  );
  return files;
}

/** Wide and shallow: the layout a real Python repo has. */
function packageCorpus({ leaves, defsPerLeaf, pkgSize, consumers, importsPerConsumer }) {
  const files = [];
  const leafPaths = [];
  for (let i = 0; i < leaves; i++) {
    const p = `pkg${Math.floor(i / pkgSize)}/mod${i}.py`;
    leafPaths.push(p);
    files.push(
      mkFile(
        p,
        Array.from({ length: defsPerLeaf }, (_, j) => mkDef(`mod${i}.fn${j}`)),
        [],
      ),
    );
  }
  const initPaths = [];
  for (let g = 0; g < Math.ceil(leaves / pkgSize); g++) {
    const p = `pkg${g}/__init__.py`;
    initPaths.push(p);
    const imports = [];
    for (let i = g * pkgSize; i < Math.min((g + 1) * pkgSize, leaves); i++) {
      for (let j = 0; j < defsPerLeaf; j++) imports.push(reexporting(`fn${j}_${i}`, leafPaths[i]));
    }
    files.push(mkFile(p, [], imports));
  }
  for (let c = 0; c < consumers; c++) {
    const imports = [];
    for (let k = 0; k < importsPerConsumer; k++) {
      const g = (c * 7 + k) % initPaths.length;
      imports.push({
        kind: 'named',
        localName: `fn0_${g * pkgSize}`,
        importedName: `fn0_${g * pkgSize}`,
        targetRaw: initPaths[g],
      });
    }
    files.push(mkFile(`app/consumer${c}.py`, [], imports));
  }
  return files;
}

function timeMedian(files, reps = 5) {
  const hooks = hooksFor(files);
  finalize({ files, workspaceIndex: undefined }, hooks); // warm
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    finalize({ files, workspaceIndex: undefined }, hooks);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/** Longest `transitiveVia` any edge in this graph carries. */
function maxViaLength(files) {
  const out = finalize({ files, workspaceIndex: undefined }, hooksFor(files));
  let max = 0;
  for (const edges of out.imports.values()) {
    for (const e of edges) {
      if (e.transitiveVia !== undefined) max = Math.max(max, e.transitiveVia.length);
    }
  }
  return max;
}

const deepChain = chainCorpus(PROBE_DEPTH);
const maxVia = maxViaLength(deepChain);
const chainMs = timeMedian(deepChain);
const widthMs = timeMedian(
  packageCorpus({
    leaves: 6000,
    defsPerLeaf: 8,
    pkgSize: 12,
    consumers: 3000,
    importsPerConsumer: 15,
  }),
  3,
);

console.log(`chain depth ${PROBE_DEPTH}      : ${chainMs.toFixed(1)} ms`);
console.log(`max_via_len            : ${maxVia}  (must equal ${EXPECTED_MAX_VIA})`);
console.log(`width_ms               : ${widthMs.toFixed(1)}  (budget <= ${WIDTH_MS_BUDGET})`);

if (process.argv.includes('--check')) {
  let failed = false;
  if (maxVia !== EXPECTED_MAX_VIA) {
    failed = true;
    console.error(
      `\nFAIL max_via_len: ${maxVia}, expected exactly ${EXPECTED_MAX_VIA}.\n` +
        `A LARGER value means the \`via\` chain copy lost its bound — see ` +
        `MAX_VIA_LENGTH in gitnexus-shared/src/scope-resolution/finalize-algorithm.ts. ` +
        `Each hop copies the inherited path, so an unbounded chain is O(depth^2) ` +
        `in time and retained memory (measured 67 ms / 145 MB vs 25 ms / 40 MB at ` +
        `depth ${PROBE_DEPTH}).\nA SMALLER value means the cap moved; update ` +
        `EXPECTED_MAX_VIA here and the two finalize-algorithm tests that pin it.`,
    );
  }
  if (widthMs > WIDTH_MS_BUDGET) {
    failed = true;
    console.error(
      `\nFAIL width_ms: ${widthMs.toFixed(1)} exceeds budget ${WIDTH_MS_BUDGET}. ` +
        `With max_via_len healthy this points at a per-lookup linear scan coming ` +
        `back (see indexExportsByName). Re-run on an idle machine first.`,
    );
  }
  if (failed) process.exit(1);
  console.log('\nOK — within budget.');
}
