/**
 * Ownership-reconciliation correctness and scaling gate.
 *
 * `reconcileOwnership` mirrors every Property/Variable/Const/Static def and
 * every class-like def into the SemanticModel's owner-keyed registries, and
 * skips a def whose node id is already registered under its `(owner, name)`.
 * Module-level values and top-level types carry no owner, so every file's
 * `logger` shares ONE registry bucket per name across the whole repository.
 * Answering "already registered?" by scanning that bucket for every def is
 * quadratic in the number of files that declare the name. This gate pins what
 * the pass registers and checks that its cost grows linearly as the number of
 * files declaring the same names grows 4x.
 *
 * Workload: N TypeScript files, each declaring the same three module-level
 * values (`logger`, `router`, `config`) and a top-level `interface Options`
 * with one member. Every value and every `Options` is ownerless, so the four
 * shared buckets each end up holding N defs; `Options.level` is owned, one def
 * per owner. The file index is zero-padded to a fixed width, so input bytes
 * grow exactly with N. Defs come from the real TypeScript scope extractor and
 * `populateOwners`, the same two steps runScopeResolution runs before it
 * reconciles.
 *
 * Shapes: small = 250 files, large = 1000 files (files 4x). The timed
 * workload is two passes over a fresh model: the first registers every def,
 * the second finds every def already present (the shared model a later
 * language pass reconciles into). The scaling ratio divides the time growth
 * by the larger of the input-byte, def and registry-entry growth, so about 1
 * is linear. Under --check each cell also counts the registry entries the pass
 * read through `lookupAllByOwner` (a counting wrapper, outside the timed
 * passes): the count must grow no faster than the defs do.
 *
 * The shapes are small on purpose. A pass costs well under a microsecond per
 * def, mostly hash probes into tables that grow with the file count, so once
 * the large shape's tables leave a cache level the small shape still sits in,
 * per-def time rises with no change in the work done: a plain loop doing the
 * same probes read 1.5-1.8 at 1000 vs 4000 files on a loaded host. At 250 vs
 * 1000 both shapes sit in the same regime, and a bucket scan still reads about
 * 4 there.
 *
 * Two profiles. Default (CI, also with --check): every workload timed in this
 * process, interleaved (each round times each workload once, in rotating
 * order), min of 25 after 3 warmups. `--full`: min of 75 after 5 warmups. A
 * sample takes milliseconds rather than the seconds of the parse-worker gates,
 * so more of them cost nothing and keep the minimum stable on a busy host.
 * Build-free: no parse worker, no dist/.
 *
 * `--shape <files> --reps R --warmup W` measures one workload, for size sweeps.
 *
 * node --import tsx bench/ownership-reconcile/measure.mjs [--check] [--full]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.ts';
import { typescriptScopeResolver } from '../../src/core/ingestion/languages/typescript/scope-resolver.ts';
import { reconcileOwnership } from '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.ts';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.ts';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CHECK = process.argv.includes('--check');
const FULL = process.argv.includes('--full');
const WARMUP = FULL ? 5 : 3;
const REPS = FULL ? 75 : 25;
const MARKER = 'OWNERSHIP_RECONCILE_RESULT ';
const SHAPES = { small: 250, large: 1000 };
const VALUES = ['logger', 'router', 'config'];
const TYPE = 'Options';
const INDEX_WIDTH = 5;
// Registries whose buckets the pass reads. `methods` is listed so a future
// read there is counted too; this workload declares no callables.
const REGISTRIES = ['fields', 'types', 'methods'];
const FIELD_KINDS = new Set(['Property', 'Variable', 'Const', 'Static']);

function corpus(files) {
  const out = [];
  for (let i = 0; i < files; i++) {
    const tag = `f${String(i).padStart(INDEX_WIDTH, '0')}`;
    let content = '';
    for (const name of VALUES) content += `export const ${name} = make('${name}', '${tag}');\n`;
    content += `export interface ${TYPE} {\n  level: number;\n}\n`;
    out.push({ path: `src/${tag}.ts`, content });
  }
  return out;
}

function inputBytes(files) {
  let bytes = 0;
  for (const file of files) bytes += Buffer.byteLength(file.content, 'utf8');
  return bytes;
}

/** Extract every file the way runScopeResolution's first phase does. */
function extract(files) {
  const provider = typescriptScopeResolver;
  return files.map((file) => {
    const parsed = extractParsedFile(provider.languageProvider, file.content, file.path, (w) => {
      throw new Error(`${file.path}: ${w}`);
    });
    assert.ok(parsed !== undefined, `${file.path}: extraction failed`);
    provider.populateOwners(parsed);
    return parsed;
  });
}

/** The timed workload: register into a fresh model, then reconcile again. */
function reconcileTwice(parsedFiles, model = createSemanticModel()) {
  const start = performance.now();
  const first = reconcileOwnership(parsedFiles, model);
  const second = reconcileOwnership(parsedFiles, model);
  return { ms: performance.now() - start, first, second, model };
}

/**
 * Wrap each registry's `lookupAllByOwner` to count the reads and the entries
 * each read hands back. A registry returns its live bucket, so the length is
 * taken at the moment of the read. Returns the counters and a restore hook.
 */
function countRegistryReads(model) {
  const reads = { calls: 0, entries: 0 };
  const originals = [];
  for (const name of REGISTRIES) {
    const registry = model[name];
    const original = registry.lookupAllByOwner;
    originals.push([registry, original]);
    registry.lookupAllByOwner = (owner, key) => {
      const bucket = original(owner, key);
      reads.calls++;
      reads.entries += bucket.length;
      return bucket;
    };
  }
  const restore = () => {
    for (const [registry, original] of originals) registry.lookupAllByOwner = original;
  };
  return { reads, restore };
}

/** Exact cells: what the passes registered, in registry order. */
function correctness(files, parsedFiles, run) {
  const keys = new Map();
  let defs = 0;
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      defs++;
      const registry = FIELD_KINDS.has(def.type)
        ? 'fields'
        : def.type === 'Interface' || def.type === 'Class'
          ? 'types'
          : null;
      if (registry === null) continue;
      const name = def.qualifiedName.slice(def.qualifiedName.lastIndexOf('.') + 1);
      const owner = def.ownerId;
      keys.set(JSON.stringify([registry, owner ?? null, name]), [registry, owner, name]);
    }
  }
  const lines = [];
  let registryEntries = 0;
  const sharedBuckets = {};
  for (const [key, [registry, owner, name]] of [...keys].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bucket = run.model[registry].lookupAllByOwner(owner, name);
    registryEntries += bucket.length;
    if (owner === undefined) sharedBuckets[`${registry}:${name}`] = bucket.length;
    lines.push(`${key}\t${bucket.map((def) => def.nodeId).join(',')}`);
  }
  return {
    files: files.length,
    input_bytes: inputBytes(files),
    defs,
    first_pass: { ...run.first },
    second_pass: { ...run.second },
    shared_buckets: sharedBuckets,
    registry_entries: registryEntries,
    fingerprint: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

/**
 * Extract once, then one counted (untimed) workload: the exact cells, and the
 * registry reads it took. The reads are kept out of the cells, which pin only
 * what the passes produce.
 */
function prepare(files) {
  const corpusFiles = corpus(files);
  const parsedFiles = extract(corpusFiles);
  const model = createSemanticModel();
  const { reads, restore } = countRegistryReads(model);
  const run = reconcileTwice(parsedFiles, model);
  restore();
  const shape = correctness(corpusFiles, parsedFiles, run);
  const work = {
    registry_reads: reads.calls,
    registry_entries_read: reads.entries,
    registry_entries_read_per_def: reads.entries / shape.defs,
  };
  return { parsedFiles, shape, work };
}

/** Times each input's workload, interleaved; min of `reps`. */
function timeInputs(inputs, warmup, reps) {
  const names = Object.keys(inputs);
  for (const input of Object.values(inputs)) input.samples = [];
  for (let run = 0; run < warmup + reps; run++) {
    for (let k = 0; k < names.length; k++) {
      const input = inputs[names[(k + run) % names.length]];
      const { ms, first, second } = reconcileTwice(input.parsedFiles);
      assert.deepEqual(
        [first, second],
        [input.shape.first_pass, input.shape.second_pass],
        'timed pass must do the validated work',
      );
      if (run >= warmup) input.samples.push(ms);
    }
  }
  const timings = {};
  // Like the neighbouring resolver gates: min-of-N limits scheduler/GC noise.
  for (const name of names) timings[name] = { reconcile_ms: Math.min(...inputs[name].samples) };
  return timings;
}

function option(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
}

const shapeArg = process.argv.indexOf('--shape');
if (shapeArg >= 0) {
  const files = Number(process.argv[shapeArg + 1]);
  assert.ok(Number.isInteger(files) && files > 0, 'usage: --shape <files>');
  const input = prepare(files);
  const timing = timeInputs({ one: input }, option('--warmup', 0), option('--reps', 1)).one;
  console.log(MARKER + JSON.stringify({ shape: input.shape, work: input.work, timing }));
} else {
  report();
}

function report() {
  const inputs = {};
  const shapes = {};
  // The registry entries each workload's two passes read (outside the timer).
  const operations = {};
  for (const [name, files] of Object.entries(SHAPES)) {
    inputs[name] = prepare(files);
    shapes[name] = inputs[name].shape;
    operations[name] = inputs[name].work;
  }
  const timings = timeInputs(inputs, WARMUP, REPS);
  const big = shapes.large;
  const small = shapes.small;
  // What the work may grow by: the larger of the input and output growth.
  const growth = Math.max(
    big.input_bytes / small.input_bytes,
    big.defs / small.defs,
    big.registry_entries / small.registry_entries,
  );
  const metrics = {
    reconcile_files_scaling_ratio: timings.large.reconcile_ms / timings.small.reconcile_ms / growth,
  };
  const operationMetrics = {
    registry_entries_read_files_scaling_ratio:
      operations.large.registry_entries_read / operations.small.registry_entries_read / growth,
  };
  const out = {
    shapes,
    timings,
    growth,
    metrics,
    operations,
    operation_metrics: operationMetrics,
    estimator: {
      profile: FULL ? 'full' : 'ci',
      warmup: WARMUP,
      samples: REPS,
      statistic: 'minimum',
      interleaved: true,
    },
  };
  console.log(JSON.stringify(out, null, 2));
  // Correctness holds on every run, not only under --check: every value and
  // every `Options` lands in its shared bucket once, and the second pass
  // registers nothing.
  for (const [name, shape] of Object.entries(shapes)) {
    for (const bucket of [...VALUES.map((v) => `fields:${v}`), `types:${TYPE}`]) {
      assert.equal(shape.shared_buckets[bucket], shape.files, `${name}: ${bucket} bucket size`);
    }
    assert.equal(shape.second_pass.fieldsRegistered, 0, `${name}: second pass registered fields`);
    assert.equal(
      shape.second_pass.nestedTypesRegistered,
      0,
      `${name}: second pass registered types`,
    );
  }
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'ownership-reconcile workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    // The registry entries the pass reads must grow with the defs, not with
    // defs x bucket size. Deterministic, so it fails whatever the timings say.
    for (const [name, budget] of Object.entries(baseline.operation_budgets)) {
      const value = operationMetrics[name];
      if (!Number.isFinite(value) || value > budget) {
        failures.push(`${name}: ${value} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[ownership-reconcile --check] PASS');
  }
}
