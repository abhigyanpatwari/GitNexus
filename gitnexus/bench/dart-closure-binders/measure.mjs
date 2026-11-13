/**
 * Dart closure-binder correctness and scaling gate (#3903, DART-11).
 *
 * A closure or local function that binds a name now owns it: the receiver
 * type walk stops at the nearest scope that binds the receiver name, typed or
 * not. Dart closures that bind something get a Function scope of their own
 * with `@scope.lexical-names`, and the walk climbs those scopes. This gate
 * pins what that produces and checks that its cost grows linearly in the
 * input and the emitted output as the number of functions, the number of
 * closures per function, or the nesting depth of closures grows 16x. Resolution
 * over nesting depth is reported, not gated (baseline.json
 * `_resolve_depth_note`): the shared lexical lookup still climbs per reference.
 *
 * Workload: `lib/types.dart` declares `Address` and `Other`, each with
 * `save()` and `run()`, so a name-only guess cannot pick the owner. Each
 * function `f<i>(Address cs, List<int> items)` in `lib/main.dart` holds K
 * closures that rotate three kinds:
 *   `(cs) { cs.save(); }`        rebinds `cs` untyped: declines, no edge
 *   `(Other cs) { cs.save(); }`  rebinds `cs` typed: Other.save
 *   `(x) { cs.run(); }`          binds another name: the nearest `cs`
 * `sibling` puts the K closures side by side (the `x` closure reaches the
 * `Address` parameter); `nested` nests them K deep (it reaches the `Other cs`
 * one level up). Each function's CALLS edges must equal the expected
 * multiset exactly: no missing edge, no extra one. Nested closures are indented
 * by a fixed width, so the input grows linearly with depth.
 *
 * Shapes: small = 32 functions x 3 closures; large = 512 x 3 (functions 16x);
 * dense = 32 x 48 (closures per function 16x; for `nested`, depth 16x). Each
 * scaling ratio divides the time growth by the larger of the input-byte,
 * capture-group and relationship growth, so about 1 is linear in input plus
 * output. Under --check each cell also counts the ancestors the enclosing-type
 * search stepped onto during capture: at most one per Function scope (#3912
 * review). Timing ratios at these sizes move by about +-0.25 between runs on a
 * busy host, so the count, not a ratio, is what catches a climb per closure.
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
 * `--shape <form> <functions> <closures> --reps R --warmup W` also times that
 * one workload in its own process, for size sweeps.
 *
 * node --import tsx bench/dart-closure-binders/measure.mjs [--check] [--full]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDartScopeCaptures } from '../../src/core/ingestion/languages/dart/index.ts';
import * as dartReceiverBinding from '../../src/core/ingestion/languages/dart/receiver-binding.ts';
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
const MARKER = 'DART_CLOSURE_RESULT ';
const FORMS = ['sibling', 'nested'];
const SHAPES = { small: [32, 3], large: [512, 3], dense: [32, 48] };
const MAIN = 'lib/main.dart';
const TYPES = 'lib/types.dart';
const roots = [];
// The enclosing-type operation counter (#3917). Without it the count is
// unavailable, which --check reports as a failure rather than a pass.
const enclosingTypeStats = dartReceiverBinding.getDartEnclosingTypeStats;
const resetEnclosingTypeStats = dartReceiverBinding.resetDartEnclosingTypeStats;
/** One parse worker for every workload in this process. */
let pool;

const KINDS = [
  { params: '(cs)', body: 'cs.save();', binds: 'untyped' },
  { params: '(Other cs)', body: 'cs.save();', binds: 'Other' },
  { params: '(x)', body: 'cs.run();', binds: null },
];

function corpus(form, functions, closures) {
  const types =
    'class Address {\n  void save() {}\n  void run() {}\n}\n\n' +
    'class Other {\n  void save() {}\n  void run() {}\n}\n';
  let main = "import 'types.dart';\n";
  for (let i = 0; i < functions; i++) {
    main += `\nvoid f${i}(Address cs, List<int> items) {\n`;
    if (form === 'sibling') {
      for (let j = 0; j < closures; j++) {
        const kind = KINDS[j % KINDS.length];
        main += `  items.forEach(${kind.params} { ${kind.body} });\n`;
      }
    } else {
      // Fixed-width indentation: input bytes grow linearly with depth, so a
      // super-linear depth term is the code's, not the corpus's.
      for (let j = 0; j < closures; j++) {
        const kind = KINDS[j % KINDS.length];
        main += `  items.forEach(${kind.params} { ${kind.body}\n`;
      }
      for (let j = 0; j < closures; j++) main += '  });\n';
    }
    main += '}\n';
  }
  return [
    { path: TYPES, content: types },
    { path: MAIN, content: main },
  ];
}

/** The CALLS targets one function must produce, one per resolved call site. */
function expectedTargets(form, closures) {
  const targets = [];
  let nearest = 'Address'; // the parameter
  for (let j = 0; j < closures; j++) {
    const kind = KINDS[j % KINDS.length];
    const binder = kind.binds ?? (form === 'nested' ? nearest : 'Address');
    if (form === 'nested' && kind.binds !== null) nearest = kind.binds;
    if (binder === 'untyped') continue; // declines: the closure's own `cs` has no type
    targets.push(`Method:${TYPES}:${binder}.${kind.body.slice(3, -3)}#0`);
  }
  return targets.sort();
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

function correctness(form, functions, closures, files, graph, stats, captured) {
  const edges = [];
  const callsBySource = new Map();
  let calls = 0;
  for (const edge of graph.iterRelationships()) {
    edges.push(
      JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
    );
    if (edge.type !== 'CALLS' || !edge.sourceId.startsWith(`Function:${MAIN}:`)) continue;
    calls++;
    const list = callsBySource.get(edge.sourceId) ?? [];
    list.push(edge.targetId);
    callsBySource.set(edge.sourceId, list);
  }
  const expected = expectedTargets(form, closures);
  let missing = 0;
  let unexpected = 0;
  for (let i = 0; i < functions; i++) {
    const got = [...(callsBySource.get(`Function:${MAIN}:f${i}`) ?? [])].sort();
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
    functions,
    closures_per_function: closures,
    input_bytes: inputBytes(files),
    capture_groups: captured.groups,
    function_scopes: captured.scopes,
    relationships: graph.relationshipCount,
    calls,
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
async function prepare(form, functions, closures) {
  const files = corpus(form, functions, closures);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-closure-bench-'));
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

function inputBytes(files) {
  let bytes = 0;
  for (const file of files) bytes += Buffer.byteLength(file.content, 'utf8');
  return bytes;
}

/**
 * One capture pass over every file: only emitDartScopeCaptures is timed. Also
 * the emitted output (capture groups, Function scopes) and how many ancestors
 * the enclosing-type search stepped onto during the pass.
 */
function capture(files) {
  resetEnclosingTypeStats?.();
  const start = performance.now();
  const outputs = files.map((file) => emitDartScopeCaptures(file.content, file.path));
  const ms = performance.now() - start;
  const ancestorVisits = enclosingTypeStats?.().ancestorVisits ?? null;
  let groups = 0;
  let scopes = 0;
  for (const matches of outputs) {
    groups += matches.length;
    for (const match of matches) if (match['@scope.function'] !== undefined) scopes++;
  }
  return { ms, work: { groups, scopes, ancestorVisits } };
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
      const { ms: captureMs, work } = capture(input.files);
      input.captured ??= work;
      assert.deepEqual(work, input.captured, 'capture pass must be the same work');
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
async function measureShape(form, functions, closures, reps, warmup) {
  const input = await prepare(form, functions, closures);
  // Through one worker parse (thread included) and one resolution.
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const { work: captured } = capture(input.files);
  const shape = correctness(
    form,
    functions,
    closures,
    input.files,
    input.parsed.graph,
    input.first.stats,
    captured,
  );
  const result = { shape, captured, peak_rss_mib: peakRssMiB };
  if (reps > 0) {
    const timing = timeInputs(
      {
        one: {
          ...input,
          captured,
          relationships: input.parsed.graph.relationshipCount,
        },
      },
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
    for (const [name, [functions, closures]] of Object.entries(SHAPES)) {
      const { files, config, raw, parsed } = await prepare(form, functions, closures);
      inputs[`${form}_${name}`] = {
        files,
        config,
        raw,
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
    const [form, functions, closures] = process.argv.slice(shapeArg + 1, shapeArg + 4);
    assert.ok(FORMS.includes(form), `unknown form ${form}`);
    const result = await measureShape(
      form,
      Number(functions),
      Number(closures),
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
  // Each workload's capture output and operation counts.
  const captured = {};
  let timings;
  if (FULL) {
    timings = child(['--timings', '--full']);
    for (const form of FORMS) {
      for (const [name, [functions, closures]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const result = child(['--shape', form, String(functions), String(closures)]);
        shapes[key] = result.shape;
        captured[key] = result.captured;
        timings[key].peak_rss_mib = result.peak_rss_mib;
      }
    }
  } else {
    const inputs = {};
    const prepared = {};
    for (const form of FORMS) {
      for (const [name, [functions, closures]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = await prepare(form, functions, closures);
        prepared[key] = input;
        inputs[key] = {
          files: input.files,
          config: input.config,
          raw: input.raw,
          relationships: input.parsed.graph.relationshipCount,
        };
      }
    }
    // Capture output and operation counts come from the first timed pass, not
    // an extra one.
    timings = timeInputs(inputs, WARMUP, REPS);
    for (const form of FORMS) {
      for (const [name, [functions, closures]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = prepared[key];
        captured[key] = inputs[key].captured;
        shapes[key] = correctness(
          form,
          functions,
          closures,
          input.files,
          input.parsed.graph,
          input.first.stats,
          inputs[key].captured,
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
  // What the work may grow by: the larger of the input and emitted-output
  // growth. Fixed-width indentation keeps the nested input linear in depth.
  const sizeGrowth = (big, small) =>
    Math.max(
      big.input_bytes / small.input_bytes,
      big.capture_groups / small.capture_groups,
      big.relationships / small.relationships,
    );
  const metrics = {};
  const growth = {};
  for (const form of FORMS) {
    const at = (name) => timings[`${form}_${name}`];
    const shape = (name) => shapes[`${form}_${name}`];
    growth[`${form}_function`] = sizeGrowth(shape('large'), shape('small'));
    growth[`${form}_closure`] = sizeGrowth(shape('dense'), shape('small'));
    for (const phase of ['capture', 'resolve']) {
      const key = `${phase}_ms`;
      metrics[`${form}_${phase}_function_scaling_ratio`] =
        at('large')[key] / at('small')[key] / growth[`${form}_function`];
      metrics[`${form}_${phase}_closure_scaling_ratio`] =
        at('dense')[key] / at('small')[key] / growth[`${form}_closure`];
    }
  }
  // How many ancestors the enclosing-type search stepped onto in one capture
  // pass of each workload (null: this tree has no counter).
  const operations = {};
  for (const form of FORMS) {
    for (const name of Object.keys(SHAPES)) {
      const key = `${form}_${name}`;
      const visits = captured[key].ancestorVisits;
      operations[key] = {
        enclosing_type_ancestor_visits: visits,
        enclosing_type_ancestor_visits_per_function_scope:
          visits === null ? null : visits / shapes[key].function_scopes,
      };
    }
  }
  const out = {
    shapes,
    timings,
    growth,
    metrics,
    operations,
    estimator: {
      profile: FULL ? 'full' : 'ci',
      warmup: WARMUP,
      samples: REPS,
      statistic: 'minimum',
      interleaved: true,
    },
  };
  console.log(JSON.stringify(out, null, 2));
  // Correctness holds on every run, not only under --check: each function's
  // CALLS edges are exactly the expected multiset.
  for (const [name, shape] of Object.entries(shapes)) {
    assert.equal(shape.expected_missing, 0, `${name}: expected edges missing`);
    assert.equal(shape.unexpected_edges, 0, `${name}: edges the source never makes`);
  }
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'Dart closure-binder workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    // A closure reads its enclosing type from the capture walk and a member's
    // lookup is memoised, so the search steps onto at most one ancestor per
    // Function scope however deep closures nest. A climb to the root per
    // closure is O(depth) each and fails here, whatever the timings say.
    for (const [name, budget] of Object.entries(baseline.operation_budgets)) {
      for (const [key, counts] of Object.entries(operations)) {
        const value = counts[name];
        if (value === null) {
          failures.push(`${key}: ${name} unavailable (getDartEnclosingTypeStats lands with #3917)`);
        } else if (value > budget) {
          failures.push(`${key}: ${name} ${value} > ${budget}`);
        }
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[dart-closure-binders --check] PASS');
  }
}
