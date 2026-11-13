/**
 * Dart accessor-scope and parameter-redeclaration correctness and scaling gate
 * (#3904, DART-10; stacked on #3903, DART-11).
 *
 * Getters and setters now open a Function scope of their own (their locals and
 * parameters bind inside it, their names still bind on the class), and a typed
 * parameter's annotation is withheld only when its own scope redeclares the
 * name, which needs a per-scope declaration count. This gate pins what both
 * produce and checks that their cost grows linearly in the number of classes
 * or functions, in accessors per class and in parameters per function.
 *
 * Workload: `lib/types.dart` declares `Address` and `Other`, each with
 * `save()` and `run()`, so a name-only guess cannot pick the owner. Two forms:
 *  - `accessors`: N classes, each with an untyped field `v`, K accessors that
 *    alternate `Address get g<j> { final v = Address(); v.save(); return v; }`
 *    and `set s<j>(Other value) { value.run(); }`, and `void reader() {
 *    v.save(); }`. Each getter's local and each setter's parameter type its own
 *    body only; `reader` reads the untyped field and gets no edge.
 *  - `params`: N functions with K typed parameters `Address a<j>`, each
 *    redeclared by a closure (`items.forEach((a<j>) { a<j>.save(); })`) and
 *    then used (`a<j>.run()`). The closure's own `a<j>` declines; the
 *    parameter keeps its annotation, so every `a<j>.run()` reaches Address.run.
 * Each class's or function's CALLS edges to methods must equal the expected
 * multiset exactly: no missing edge, no extra one.
 *
 * Shapes: small = 64 units x 4; large = 256 x 4 (classes or functions 4x);
 * dense = 64 x 16 (accessors per class or parameters per function 4x).
 * Two profiles. Default (CI, also with --check): one process prepares every
 * workload, runs every accuracy gate, and times every workload interleaved
 * (each round times each workload once, in rotating order), min of 5 after 1
 * warmup. `--full`: one child times every workload, min of 15 after 2 warmups
 * (the estimator of bench/ruby-gem-resolution), and each shape's accuracy
 * cells and peak RSS come from a fresh child process (`--shape`). Phases:
 *  - capture_ms: emitDartScopeCaptures over every file. Build-free.
 *  - resolve_ms: runScopeResolution over worker-extracted files. The corpus is
 *    parsed once through the real parse worker, so this needs dist/. Each
 *    timed pass replays a structured clone of the worker output through
 *    mergeChunkResults into a fresh graph and model, outside the timer.
 *
 * `--shape <form> <units> <per-unit> --reps R --warmup W` also times that one
 * workload in its own process, for size sweeps.
 *
 * node --import tsx bench/dart-accessor-scopes/measure.mjs [--check] [--full]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDartScopeCaptures } from '../../src/core/ingestion/languages/dart/index.ts';
import { dartScopeResolver } from '../../src/core/ingestion/languages/dart/scope-resolver.ts';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.ts';
import { mergeChunkResults, processParsing } from '../../src/core/ingestion/parsing-processor.ts';
import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.ts';
import { generateId } from '../../src/lib/utils.ts';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.ts';
import { DIST_WORKER_URL } from '../../test/helpers/worker-parse.ts';

const script = fileURLToPath(import.meta.url);
const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CHECK = process.argv.includes('--check');
// Two profiles. The default (CI, also under --check) prepares every workload,
// runs every accuracy gate and times every workload, min of 5 after 1 warmup,
// in this one process. `--full` times them in one child, min of 15 after 2
// warmups, and takes each shape's accuracy cells and peak RSS from a fresh
// process per shape.
const FULL = process.argv.includes('--full');
const WARMUP = FULL ? 2 : 1;
const REPS = FULL ? 15 : 5;
const MARKER = 'DART_ACCESSOR_RESULT ';
const FORMS = ['accessors', 'params'];
const SHAPES = { small: [64, 4], large: [256, 4], dense: [64, 16] };
const MAIN = 'lib/main.dart';
const TYPES = 'lib/types.dart';
const roots = [];
/** One parse worker for every workload in this process. */
let pool;

const TYPES_SOURCE =
  'class Address {\n  void save() {}\n  void run() {}\n}\n\n' +
  'class Other {\n  void save() {}\n  void run() {}\n}\n';

function corpus(form, units, perUnit) {
  let main = "import 'types.dart';\n";
  for (let i = 0; i < units; i++) {
    if (form === 'accessors') {
      main += `\nclass C${i} {\n  var v;\n`;
      for (let j = 0; j < perUnit; j++) {
        main +=
          j % 2 === 0
            ? `  Address get g${j} {\n    final v = Address();\n    v.save();\n    return v;\n  }\n`
            : `  set s${j}(Other value) {\n    value.run();\n  }\n`;
      }
      main += '  void reader() {\n    v.save();\n  }\n}\n';
    } else {
      const params = Array.from({ length: perUnit }, (_, j) => `Address a${j}`).join(', ');
      main += `\nvoid f${i}(${params}, List<int> items) {\n`;
      for (let j = 0; j < perUnit; j++) {
        main += `  items.forEach((a${j}) { a${j}.save(); });\n  a${j}.run();\n`;
      }
      main += '}\n';
    }
  }
  return [
    { path: TYPES, content: TYPES_SOURCE },
    { path: MAIN, content: main },
  ];
}

/** The method CALLS targets one class or function must produce, one per site. */
function expectedTargets(form, perUnit) {
  const targets = [];
  for (let j = 0; j < perUnit; j++) {
    if (form === 'params') targets.push(`Method:${TYPES}:Address.run#0`);
    else targets.push(`Method:${TYPES}:${j % 2 === 0 ? 'Address.save' : 'Other.run'}#0`);
  }
  return targets.sort();
}

/** The unit (class or function) a CALLS source belongs to, or null. */
function unitOf(sourceId) {
  const match = /^(?:Class|Method|Function|Property):lib\/main\.dart:([Cf]\d+)(?:[.#]|$)/.exec(
    sourceId,
  );
  return match === null ? null : match[1];
}

function addFileNodes(graph, files) {
  // Structure processing creates these before parsing in the real pipeline.
  for (const file of files) {
    graph.addNode({
      id: generateId('File', file.path),
      label: 'File',
      properties: { name: path.basename(file.path), filePath: file.path },
    });
  }
}

function resolve(files, config, parsed) {
  const preExtractedParsedFiles = new Map(parsed.data.parsedFiles.map((f) => [f.filePath, f]));
  const start = performance.now();
  const stats = runScopeResolution(
    {
      graph: parsed.graph,
      model: parsed.model,
      files,
      resolutionConfig: config,
      preExtractedParsedFiles,
    },
    dartScopeResolver,
  );
  return { ms: performance.now() - start, stats };
}

function replay(files, raw) {
  const graph = createKnowledgeGraph();
  const model = createSemanticModel();
  const data = mergeChunkResults(graph, model.symbols, structuredClone(raw));
  addFileNodes(graph, files);
  return { graph, model, data };
}

function correctness(form, units, perUnit, graph, stats, captureGroups) {
  const edges = [];
  const callsByUnit = new Map();
  let methodCalls = 0;
  let constructorCalls = 0;
  for (const edge of graph.iterRelationships()) {
    edges.push(
      JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
    );
    if (edge.type !== 'CALLS') continue;
    const unit = unitOf(edge.sourceId);
    if (unit === null) continue;
    if (!edge.targetId.startsWith('Method:')) {
      constructorCalls++;
      continue;
    }
    methodCalls++;
    const list = callsByUnit.get(unit) ?? [];
    list.push(edge.targetId);
    callsByUnit.set(unit, list);
  }
  const expected = expectedTargets(form, perUnit);
  let missing = 0;
  let unexpected = 0;
  for (let i = 0; i < units; i++) {
    const got = [...(callsByUnit.get(`${form === 'params' ? 'f' : 'C'}${i}`) ?? [])].sort();
    const want = [...expected];
    for (const target of got) {
      const at = want.indexOf(target);
      if (at < 0) unexpected++;
      else want.splice(at, 1);
    }
    missing += want.length;
  }
  const declines = {};
  const outcomes = [];
  for (const outcome of stats.resolutionOutcomes) {
    if (outcome.kind === 'resolved') continue;
    const key = outcome.declineDetail
      ? `${outcome.reason}/${outcome.declineDetail}`
      : outcome.reason;
    declines[key] = (declines[key] ?? 0) + 1;
    const r = outcome.range;
    outcomes.push(`${key}|${outcome.filePath}|${outcome.name}|${r.startLine}:${r.startCol}`);
  }
  return {
    units,
    per_unit: perUnit,
    capture_groups: captureGroups,
    relationships: graph.relationshipCount,
    method_calls: methodCalls,
    constructor_calls: constructorCalls,
    declines,
    expected_missing: missing,
    unexpected_edges: unexpected,
    fingerprint: crypto
      .createHash('sha256')
      .update([...edges.sort(), ...outcomes.sort()].join('\n'))
      .digest('hex'),
  };
}

/** Write, parse once through the worker, and resolve once. */
async function prepare(form, units, perUnit) {
  const files = corpus(form, units, perUnit);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-accessor-bench-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: bench\n');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), file.content);
  }
  // The real pubspec/package-config loader, once; it is not what is timed.
  const config = await dartScopeResolver.loadResolutionConfig(root);
  const raw = [];
  const parsed = await parse(files, raw);
  addFileNodes(parsed.graph, files);
  const first = resolve(files, config, parsed);
  return { files, config, raw, parsed, first };
}

/** Worker parse through the process's one pool (the real parse worker, dist/). */
async function parse(files, raw) {
  pool ??= createWorkerPool(DIST_WORKER_URL, 1);
  const graph = createKnowledgeGraph();
  const model = createSemanticModel();
  const data = await processParsing(graph, files, model.symbols, pool, undefined, raw);
  return { graph, model, data };
}

function captureGroups(files) {
  let groups = 0;
  for (const file of files) groups += emitDartScopeCaptures(file.content, file.path).length;
  return groups;
}

/** Times capture and resolution of each input, interleaved; min of `reps`. */
function timeInputs(inputs, warmup, reps) {
  const names = Object.keys(inputs);
  for (const input of Object.values(inputs)) {
    input.capture = [];
    input.resolution = [];
  }
  for (let run = 0; run < warmup + reps; run++) {
    for (let k = 0; k < names.length; k++) {
      const input = inputs[names[(k + run) % names.length]];
      const start = performance.now();
      const groups = captureGroups(input.files);
      const captureMs = performance.now() - start;
      input.groups ??= groups;
      assert.equal(groups, input.groups, 'capture pass must be the same work');
      const pass = replay(input.files, input.raw);
      const { ms } = resolve(input.files, input.config, pass);
      assert.equal(
        pass.graph.relationshipCount,
        input.relationships,
        'timed pass must do the validated work',
      );
      if (run >= warmup) {
        input.capture.push(captureMs);
        input.resolution.push(ms);
      }
    }
  }
  const timings = {};
  for (const name of names) {
    // Like the neighbouring resolver gates: min-of-N limits scheduler/GC noise.
    timings[name] = {
      capture_ms: Math.min(...inputs[name].capture),
      resolve_ms: Math.min(...inputs[name].resolution),
      relationships: inputs[name].relationships,
    };
  }
  return timings;
}

/** One workload in a fresh process: the accuracy cells and its own peak RSS. */
async function measureShape(form, units, perUnit, reps, warmup) {
  const input = await prepare(form, units, perUnit);
  // Through one worker parse (thread included) and one resolution.
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const groups = captureGroups(input.files);
  const shape = correctness(form, units, perUnit, input.parsed.graph, input.first.stats, groups);
  const result = { shape, peak_rss_mib: peakRssMiB };
  if (reps > 0) {
    const timing = timeInputs(
      { one: { ...input, groups, relationships: input.parsed.graph.relationshipCount } },
      warmup,
      reps,
    ).one;
    delete timing.relationships;
    result.timing = { ...timing, peak_rss_mib: peakRssMiB };
  }
  return result;
}

/** Every workload in ONE process, interleaved in rotating order. */
async function measureTimings() {
  const inputs = {};
  for (const form of FORMS) {
    for (const [name, [units, perUnit]] of Object.entries(SHAPES)) {
      const { files, config, raw, parsed } = await prepare(form, units, perUnit);
      inputs[`${form}_${name}`] = {
        files,
        config,
        raw,
        groups: captureGroups(files),
        relationships: parsed.graph.relationshipCount,
      };
    }
  }
  return timeInputs(inputs, WARMUP, REPS);
}

function child(args) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GITNEXUS_LOG_LEVEL: 'error' },
  });
  const line = run.stdout?.split('\n').find((l) => l.startsWith(MARKER));
  assert.ok(
    run.status === 0 && line !== undefined,
    `${args.join(' ')}: ${run.error?.message || run.stderr || `exit ${run.status}`}`,
  );
  return JSON.parse(line.slice(MARKER.length));
}

function option(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
}

const shapeArg = process.argv.indexOf('--shape');
try {
  if (shapeArg >= 0) {
    const [form, units, perUnit] = process.argv.slice(shapeArg + 1, shapeArg + 4);
    assert.ok(FORMS.includes(form), `unknown form ${form}`);
    const result = await measureShape(
      form,
      Number(units),
      Number(perUnit),
      option('--reps', 0),
      option('--warmup', 0),
    );
    console.log(MARKER + JSON.stringify(result));
  } else if (process.argv.includes('--timings')) {
    console.log(MARKER + JSON.stringify(await measureTimings()));
  } else {
    await report();
  }
} finally {
  await pool?.terminate();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

async function report() {
  const shapes = {};
  let timings;
  if (FULL) {
    timings = child(['--timings', '--full']);
    for (const form of FORMS) {
      for (const [name, [units, perUnit]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const result = child(['--shape', form, String(units), String(perUnit)]);
        shapes[key] = result.shape;
        timings[key].peak_rss_mib = result.peak_rss_mib;
      }
    }
  } else {
    const inputs = {};
    const prepared = {};
    for (const form of FORMS) {
      for (const [name, [units, perUnit]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = await prepare(form, units, perUnit);
        prepared[key] = input;
        inputs[key] = {
          files: input.files,
          config: input.config,
          raw: input.raw,
          relationships: input.parsed.graph.relationshipCount,
        };
      }
    }
    // Capture-group counts come from the first timed pass, not an extra one.
    timings = timeInputs(inputs, WARMUP, REPS);
    for (const form of FORMS) {
      for (const [name, [units, perUnit]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = prepared[key];
        shapes[key] = correctness(
          form,
          units,
          perUnit,
          input.parsed.graph,
          input.first.stats,
          inputs[key].groups,
        );
      }
    }
  }
  for (const [key, timing] of Object.entries(timings)) {
    assert.equal(
      timing.relationships,
      shapes[key].relationships,
      `${key}: the timed workload is not the validated one`,
    );
    delete timing.relationships;
  }
  const scale = SHAPES.large[0] / SHAPES.small[0];
  assert.equal(SHAPES.dense[1] / SHAPES.small[1], scale, 'both growth axes use the same factor');
  const metrics = {};
  for (const form of FORMS) {
    const at = (name) => timings[`${form}_${name}`];
    for (const phase of ['capture', 'resolve']) {
      const key = `${phase}_ms`;
      metrics[`${form}_${phase}_unit_scaling_ratio`] = at('large')[key] / at('small')[key] / scale;
      metrics[`${form}_${phase}_per_unit_scaling_ratio`] =
        at('dense')[key] / at('small')[key] / scale;
    }
  }
  const out = {
    shapes,
    timings,
    metrics,
    estimator: {
      profile: FULL ? 'full' : 'ci',
      warmup: WARMUP,
      samples: REPS,
      statistic: 'minimum',
      interleaved: true,
    },
  };
  console.log(JSON.stringify(out, null, 2));
  // Correctness holds on every run, not only under --check: each class's or
  // function's method CALLS are exactly the expected multiset.
  for (const [name, shape] of Object.entries(shapes)) {
    assert.equal(shape.expected_missing, 0, `${name}: expected edges missing`);
    assert.equal(shape.unexpected_edges, 0, `${name}: edges the source never makes`);
  }
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'Dart accessor-scope workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[dart-accessor-scopes --check] PASS');
  }
}
