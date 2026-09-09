#!/usr/bin/env node
/**
 * Build-free scaling and correctness guard for callable-value reference
 * resolution (#3399).
 *
 * WHAT IS GUARDED. `resolveValueRefTarget` is the per-site half of
 * `emitPropertyDispatchCalls`: for every `value-ref` reference site it names the
 * callable the source handed over as a value. #3399 replaced a single lexical
 * walk with four channels, and each one reaches for a wider index than the last:
 *
 *   1. BARE           `register(onTick)`            — `findCallableBindingInScope`
 *   2. NAMESPACE      `bridge.accessor(utils.compare, …)` — the file's own
 *                     namespace `@import` edges, then the target's module scope
 *   3. HUB            `bridge.accessor(hub.compare, …)`  — the same, through the
 *                     finalized/augmented channel a re-export publishes into
 *   4. CONTAINER      `bridge.accessor(Element.getNamespaceUri, …)` —
 *                     `findClassBindingInScope`, whose miss path falls back to
 *                     `scopes.qualifiedNames`, a WORKSPACE-WIDE index
 *
 * Channel 4 is why this bench exists. A workspace-wide index consulted per site
 * is linear only while the lookup is keyed; make it a scan — or make any of the
 * three guards around it (`isOwnerNameShadowedBySomethingElse`,
 * `isNamespaceNameShadowed`, `findOwnedMember`) walk a collection that grows
 * with the repo — and a registration table that costs O(sites) today costs
 * O(sites x files) tomorrow. That regression is invisible on a fixture and
 * expensive on lightpanda-io/browser, where `bridge.{accessor,function,…}`
 * appears 2,047 times across 257 files.
 *
 * HOW. Two corpora of identical shape, 4x apart in file count, and the per-site
 * resolution loop is the ONLY thing timed — extraction, ownership reconciliation
 * and finalize are setup. `linear_factor` is `(t_large/t_small) / (N_large/N_small)`:
 * ~1.0 linear, ~4.x quadratic on this 4x step.
 *
 * A timing gate alone would be satisfied by a fast wrong answer, so the
 * correctness half is exact and comes first: the site/resolved/declined counts
 * per arm, plus an order-independent sha256 over every (site -> resolved target)
 * pair. The fingerprint is a CORRECTNESS gate — drift means the resolved target
 * set moved, which is a behaviour change to be explained, never re-baselined to
 * make CI green.
 *
 * WHY A ZIG CORPUS for a language-neutral pass. Zig is the only language whose
 * provider sets `namespaceExportsIncludeImportedNames`, so it is the only one
 * that can exercise channel 3 at all; and the file-as-struct idiom puts channels
 * 2 and 4 in one file, which is the shape #3399 was filed over. The corpus also
 * carries two DECLINE controls — a non-callable namespace member and a
 * non-callable bare argument — so a change that widened the callable gate would
 * move `declined` rather than hiding inside the timing.
 *
 * Container naming is load-bearing in the corpus: a Zig file-as-struct is minted
 * under the FILE STEM, so `ElementN.zig` must write `const ElementN = @This();`
 * and register `ElementN.getJ`. Spelling the alias `Element` instead is the
 * documented `@This()`-alias limitation, every channel-4 site declines, and the
 * bench would time a corpus that resolves nothing.
 *
 * Usage:
 *   node --import tsx bench/value-ref-resolution/measure.mjs
 *   node --import tsx bench/value-ref-resolution/measure.mjs --check
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.ts';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.ts';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.ts';
import { reconcileOwnership } from '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.ts';
import { resolveValueRefTarget } from '../../src/core/ingestion/scope-resolution/passes/property-dispatch.ts';
import { zigScopeResolver } from '../../src/core/ingestion/languages/zig/scope-resolver.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SMALL_MODULES = 80;
const LARGE_MODULES = 320;
/** Registrations per module through the CONTAINER channel. */
const ACCESSORS_PER_MODULE = 12;
const REPS = 7;

/**
 * One module = three files, mirroring `test/fixtures/lang-resolution/zig-idioms/
 * src/webapi/`: a namespace-only helper, a hub that re-exports one of its
 * members and declares nothing, and a file-as-struct carrying the binding table.
 */
function moduleFiles(i) {
  const accessors = Array.from(
    { length: ACCESSORS_PER_MODULE },
    (_, j) => `pub fn get${j}(self: *Element${i}) u8 { return self._n; }`,
  ).join('\n');
  const registrations = Array.from(
    { length: ACCESSORS_PER_MODULE },
    (_, j) => `    pub const a${j} = bridge.accessor(Element${i}.get${j}, null, .{});`,
  ).join('\n');
  return [
    {
      path: `src/dom_utils${i}.zig`,
      content: `pub const DEFAULT_NS: u8 = 7;\npub fn compare(a: u8, b: u8) u8 { return if (a > b) a else b; }\n`,
    },
    {
      path: `src/hub${i}.zig`,
      content: `pub const compare = @import("dom_utils${i}.zig").compare;\n`,
    },
    {
      path: `src/Element${i}.zig`,
      content: `const Element${i} = @This();
const dom_utils = @import("dom_utils${i}.zig");
const hub = @import("hub${i}.zig");

_n: u8 = 0,

${accessors}

fn onTick(self: *Element${i}) u8 { return self._n; }

pub const JsApi = struct {
    pub const bridge = Bridge(Element${i});
${registrations}
    pub const comparator = bridge.accessor(dom_utils.compare, null, .{});
    pub const hubbed = bridge.accessor(hub.compare, null, .{});
    pub const defaultNs = bridge.accessor(dom_utils.DEFAULT_NS, null, .{});
};

pub fn boot() void { register(onTick); }

pub fn register(comptime f: anytype) void { _ = f; }

fn Bridge(comptime T: type) type {
    _ = T;
    return struct {
        pub fn accessor(comptime g: anytype, comptime s: anytype, comptime o: anytype) u8 {
            _ = g;
            _ = s;
            _ = o;
            return 0;
        }
    };
}
`,
    },
  ];
}

/**
 * Everything `resolveValueRefTarget` reads, built the way the pipeline builds it
 * (`runScopeResolution` phases 1-2): real extraction through the Zig provider,
 * `populateOwners`, `reconcileOwnership` into the SemanticModel, then finalize.
 * Hand-assembling the indexes instead would pin this file's idea of their shape
 * rather than the code's.
 */
function buildCorpus(modules) {
  const parsedFiles = [];
  for (let i = 0; i < modules; i++) {
    for (const file of moduleFiles(i)) {
      const parsed = extractParsedFile(zigScopeResolver.languageProvider, file.content, file.path);
      if (parsed === undefined) {
        throw new Error(
          `scope extraction failed for ${file.path} — the vendored tree-sitter-zig ` +
            `grammar is unavailable on this host, so this bench cannot run`,
        );
      }
      zigScopeResolver.populateOwners(parsed);
      parsedFiles.push(parsed);
    }
  }
  const model = createSemanticModel();
  reconcileOwnership(parsedFiles, model);
  const allFilePaths = new Set(parsedFiles.map((p) => p.filePath));
  const scopes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (raw, from) =>
        zigScopeResolver.resolveImportTarget(raw, from, allFilePaths),
      mergeBindings: (existing, incoming, scopeId) =>
        zigScopeResolver.mergeBindings(existing, incoming, scopeId),
      expandsWildcardTo: (scope, files) => zigScopeResolver.expandsWildcardTo(scope, files),
    },
  });
  return { parsedFiles, scopes, model };
}

/** The timed loop: every `value-ref` site, resolved exactly as the pass does. */
function resolveAll({ parsedFiles, scopes, model }, pairs) {
  let sites = 0;
  let resolved = 0;
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'value-ref') continue;
      sites++;
      const def = resolveValueRefTarget(
        site,
        parsed.filePath,
        scopes,
        model,
        // The provider hook the pass is handed in `run.ts`; Zig sets it.
        zigScopeResolver.namespaceExportsIncludeImportedNames === true,
      );
      if (def === undefined) continue;
      resolved++;
      pairs?.push(
        `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}->${def.nodeId}`,
      );
    }
  }
  return { sites, resolved };
}

function measure(modules) {
  const corpus = buildCorpus(modules);
  const pairs = [];
  const counts = resolveAll(corpus, pairs);
  let bestMs = Infinity;
  for (let i = 0; i < REPS; i++) {
    const start = performance.now();
    resolveAll(corpus, undefined);
    bestMs = Math.min(bestMs, performance.now() - start);
  }
  // Order-independent: the walk order is an implementation detail, the resolved
  // SET is the behaviour.
  pairs.sort();
  return {
    modules,
    files: corpus.parsedFiles.length,
    value_ref_sites: counts.sites,
    resolved: counts.resolved,
    declined: counts.sites - counts.resolved,
    fingerprint: createHash('sha256').update(pairs.join('\n')).digest('hex'),
    min_ms: Number(bestMs.toFixed(3)),
    us_per_site: Number(((bestMs * 1000) / Math.max(counts.sites, 1)).toFixed(3)),
  };
}

const report = { small: measure(SMALL_MODULES), large: measure(LARGE_MODULES) };
report.workload_ratio = LARGE_MODULES / SMALL_MODULES;
report.scaling_ratio = Number(
  (report.large.min_ms / Math.max(report.small.min_ms, 0.001)).toFixed(3),
);
report.linear_factor = Number((report.scaling_ratio / report.workload_ratio).toFixed(3));

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8'));
const failures = [];
const requirePositiveNumber = (path, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    failures.push(`${path}: expected a finite positive number, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
};
for (const arm of ['small', 'large']) {
  // Correctness first: counts AND the resolved-target set.
  for (const key of [
    'modules',
    'files',
    'value_ref_sites',
    'resolved',
    'declined',
    'fingerprint',
  ]) {
    if (report[arm][key] !== baseline[arm][key]) {
      failures.push(
        `${arm}.${key}: expected ${JSON.stringify(baseline[arm][key])}, got ${JSON.stringify(report[arm][key])}`,
      );
    }
  }
  if (
    requirePositiveNumber(`${arm}.ms_budget`, baseline[arm].ms_budget) &&
    report[arm].min_ms > baseline[arm].ms_budget
  ) {
    failures.push(`${arm}.min_ms ${report[arm].min_ms} exceeds budget ${baseline[arm].ms_budget}`);
  }
}
if (
  requirePositiveNumber('linear_scaling_slack', baseline.linear_scaling_slack) &&
  report.linear_factor > baseline.linear_scaling_slack
) {
  failures.push(
    `linear_factor ${report.linear_factor} exceeds slack ${baseline.linear_scaling_slack} ` +
      `(runtime ${report.scaling_ratio}x for ${report.workload_ratio}x work)`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error('[value-ref-resolution --check] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('[value-ref-resolution --check] PASS');
