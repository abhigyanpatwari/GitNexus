/**
 * Dart deferred-import correctness and scaling gate (#3882).
 *
 * `import 'm.dart' deferred as p;` is captured as a namespace import, like
 * `import 'm.dart' as p;`, except that `p.loadLibrary` is the loader the
 * language adds to a deferred prefix and is dropped at capture time. This gate
 * pins what that path resolves and checks that its cost grows linearly in the
 * number of deferred prefixes and in the number of uses per prefix.
 *
 * Workload: N libraries `lib/m<i>.dart` that all declare the same names (class
 * `Svc` with `run()` and static `sm()`, top-level `make()`, `helper()` and
 * `loadLibrary()`), so only a prefix-bound lookup can supply an edge. One
 * `lib/main.dart` imports each library through prefix `p<i>` and has M
 * functions per prefix that call through it. Two forms of the same workload:
 * `deferred` (`deferred as p<i> hide loadLibrary`; each use first awaits
 * `p<i>.loadLibrary()`, on the same line so ranges match) and `prefixed`
 * (`as p<i> hide loadLibrary`, the pre-existing form, as the control). The
 * deferred form must produce exactly the prefixed form's graph.
 *
 * Shapes: small = 16 prefixes x 16 uses; large = 64 x 16 (prefixes 4x);
 * dense = 16 x 64 (uses per prefix 4x). Each shape's accuracy cells and peak
 * RSS come from a fresh child process (`--shape`), so the RSS is its own.
 *
 * Timing runs in one more child (`--timings`) that holds all six workloads and
 * interleaves them: each round times every workload once, in rotating order,
 * so a burst of machine load lands on both sides of a ratio. Min of 15 rounds
 * after 2 warmups (the estimator of bench/ruby-gem-resolution). Two phases:
 *  - capture_ms: emitDartScopeCaptures over every file (tree-sitter parse,
 *    scope query and the deferred-prefix filter). Build-free.
 *  - resolve_ms: runScopeResolution over the worker-extracted files. The corpus
 *    is parsed once through the real parse worker, so this needs dist/. Each
 *    timed pass replays a structured clone of the worker output through
 *    mergeChunkResults (the parse-cache replay path) into a fresh graph and
 *    model, outside the timer.
 *
 * node --import tsx bench/dart-deferred-imports/measure.mjs [--check]
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
import { mergeChunkResults } from '../../src/core/ingestion/parsing-processor.ts';
import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.ts';
import { generateId } from '../../src/lib/utils.ts';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.ts';

const script = fileURLToPath(import.meta.url);
const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CHECK = process.argv.includes('--check');
const WARMUP = 2;
const REPS = 15;
const MARKER = 'DART_DEFERRED_RESULT ';
const FORMS = ['deferred', 'prefixed'];
const SHAPES = { small: [16, 16], large: [64, 16], dense: [16, 64] };
const MAIN = 'lib/main.dart';
const roots = [];

function corpus(form, prefixes, uses) {
  const files = [];
  for (let i = 0; i < prefixes; i++) {
    files.push({
      path: `lib/m${i}.dart`,
      content:
        `class Svc {\n  static int sm() => ${i};\n  int run() => ${i};\n}\n\n` +
        `Svc make() => Svc();\n\nint helper() => ${i};\n\nvoid loadLibrary() {}\n`,
    });
  }
  const spelling = form === 'deferred' ? 'deferred as' : 'as';
  let main = '';
  for (let i = 0; i < prefixes; i++) {
    main += `import 'm${i}.dart' ${spelling} p${i} hide loadLibrary;\n`;
  }
  for (let i = 0; i < prefixes; i++) {
    const load = form === 'deferred' ? `await p${i}.loadLibrary(); ` : '';
    for (let j = 0; j < uses; j++) {
      main +=
        `\nFuture<int> use${i}_${j}() async {\n` +
        `  ${load}final s = p${i}.make();\n` +
        `  return s.run() + p${i}.helper() + p${i}.Svc.sm() + p${i}.Svc().run();\n}\n`;
    }
  }
  files.push({ path: MAIN, content: main });
  return files;
}

/** The edges each use must reach, and only through its own prefix. */
function expectedEdges(prefixes, uses) {
  const edges = [];
  for (let i = 0; i < prefixes; i++) {
    edges.push(`IMPORTS|File:${MAIN}|File:lib/m${i}.dart`);
    for (let j = 0; j < uses; j++) {
      const from = `Function:${MAIN}:use${i}_${j}`;
      const lib = `lib/m${i}.dart`;
      edges.push(
        `CALLS|${from}|Function:${lib}:make`,
        `CALLS|${from}|Function:${lib}:helper`,
        `CALLS|${from}|Method:${lib}:Svc.sm#0`,
        `CALLS|${from}|Method:${lib}:Svc.run#0`,
        `CALLS|${from}|Class:${lib}:Svc`,
        `ACCESSES|${from}|Class:${lib}:Svc`,
      );
    }
  }
  return edges;
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

function correctness(prefixes, uses, graph, stats, captureGroups) {
  const edges = [];
  const counts = { imports: 0, calls: 0, accesses: 0 };
  const present = new Set();
  let wrong = 0;
  let loadLibrary = 0;
  for (const edge of graph.iterRelationships()) {
    edges.push(
      JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
    );
    present.add(`${edge.type}|${edge.sourceId}|${edge.targetId}`);
    const reference = edge.type === 'CALLS' || edge.type === 'ACCESSES';
    if (reference && edge.targetId.endsWith(':loadLibrary')) loadLibrary++;
    const use = /^Function:lib\/main\.dart:use(\d+)_\d+$/.exec(edge.sourceId);
    if (edge.type === 'IMPORTS' && edge.sourceId === `File:${MAIN}`) counts.imports++;
    if (use === null) continue;
    if (edge.type === 'CALLS') counts.calls++;
    if (edge.type === 'ACCESSES') counts.accesses++;
    if (!edge.targetId.includes(`:lib/m${use[1]}.dart:`)) wrong++;
  }
  const declines = {};
  const outcomes = [];
  for (const outcome of stats.resolutionOutcomes) {
    if (outcome.kind === 'resolved') continue;
    declines[outcome.reason] = (declines[outcome.reason] ?? 0) + 1;
    const r = outcome.range;
    outcomes.push(
      `${outcome.reason}|${outcome.filePath}|${outcome.name}|${r.startLine}:${r.startCol}`,
    );
  }
  return {
    prefixes,
    uses_per_prefix: uses,
    files: prefixes + 1,
    capture_groups: captureGroups,
    relationships: graph.relationshipCount,
    ...counts,
    declines,
    expected_missing: expectedEdges(prefixes, uses).filter((e) => !present.has(e)).length,
    wrong_prefix_edges: wrong,
    load_library_edges: loadLibrary,
    fingerprint: crypto
      .createHash('sha256')
      .update([...edges.sort(), ...outcomes.sort()].join('\n'))
      .digest('hex'),
  };
}

/** Write, configure, parse once through the worker, and resolve once. */
async function prepare(form, prefixes, uses) {
  const files = corpus(form, prefixes, uses);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-deferred-bench-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: bench\n');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), file.content);
  }
  // The real pubspec/package-config loader, once; it is not what is timed.
  const config = await dartScopeResolver.loadResolutionConfig(root);
  const raw = [];
  const parsed = await parseFilesWithWorkers(files, { poolSize: 1, outRawResults: raw });
  addFileNodes(parsed.graph, files);
  const first = resolve(files, config, parsed);
  return { files, config, raw, parsed, first };
}

function captureGroups(files) {
  let groups = 0;
  for (const file of files) groups += emitDartScopeCaptures(file.content, file.path).length;
  return groups;
}

/** One workload in a fresh process: the accuracy cells and its own peak RSS. */
async function measureShape(form, prefixes, uses) {
  const input = await prepare(form, prefixes, uses);
  // Through one worker parse (thread included) and one resolution.
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const shape = correctness(
    prefixes,
    uses,
    input.parsed.graph,
    input.first.stats,
    captureGroups(input.files),
  );
  return { shape, peak_rss_mib: peakRssMiB };
}

/**
 * Every workload in ONE process, interleaved: each round times one capture
 * pass and one resolution pass per workload, rotating the order, so a burst
 * of machine load lands on numerator and denominator alike.
 */
async function measureTimings() {
  const inputs = {};
  for (const form of FORMS) {
    for (const [name, [prefixes, uses]] of Object.entries(SHAPES)) {
      const { files, config, raw, parsed } = await prepare(form, prefixes, uses);
      inputs[`${form}_${name}`] = {
        files,
        config,
        raw,
        groups: captureGroups(files),
        relationships: parsed.graph.relationshipCount,
        capture: [],
        resolution: [],
      };
    }
  }
  const names = Object.keys(inputs);
  for (let run = 0; run < WARMUP + REPS; run++) {
    for (let k = 0; k < names.length; k++) {
      const input = inputs[names[(k + run) % names.length]];
      const start = performance.now();
      assert.equal(captureGroups(input.files), input.groups, 'capture pass must be the same work');
      const captureMs = performance.now() - start;
      const pass = replay(input.files, input.raw);
      const { ms } = resolve(input.files, input.config, pass);
      assert.equal(
        pass.graph.relationshipCount,
        input.relationships,
        'timed pass must do the validated work',
      );
      if (run >= WARMUP) {
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

const shapeArg = process.argv.indexOf('--shape');
try {
  if (shapeArg >= 0) {
    const [form, prefixes, uses] = process.argv.slice(shapeArg + 1, shapeArg + 4);
    assert.ok(FORMS.includes(form), `unknown form ${form}`);
    console.log(MARKER + JSON.stringify(await measureShape(form, Number(prefixes), Number(uses))));
  } else if (process.argv.includes('--timings')) {
    console.log(MARKER + JSON.stringify(await measureTimings()));
  } else {
    report();
  }
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

function report() {
  const shapes = {};
  const timings = child(['--timings']);
  for (const form of FORMS) {
    for (const [name, [prefixes, uses]] of Object.entries(SHAPES)) {
      const key = `${form}_${name}`;
      const result = child(['--shape', form, String(prefixes), String(uses)]);
      shapes[key] = result.shape;
      assert.equal(
        timings[key].relationships,
        result.shape.relationships,
        `${key}: the timed workload is not the validated one`,
      );
      delete timings[key].relationships;
      timings[key].peak_rss_mib = result.peak_rss_mib;
    }
  }
  const scale = SHAPES.large[0] / SHAPES.small[0];
  assert.equal(SHAPES.dense[1] / SHAPES.small[1], scale, 'both growth axes use the same factor');
  const metrics = {};
  for (const form of FORMS) {
    const at = (name) => timings[`${form}_${name}`];
    for (const phase of ['capture', 'resolve']) {
      const key = `${phase}_ms`;
      metrics[`${form}_${phase}_prefix_scaling_ratio`] =
        at('large')[key] / at('small')[key] / scale;
      metrics[`${form}_${phase}_use_scaling_ratio`] = at('dense')[key] / at('small')[key] / scale;
    }
  }
  // What the deferred form costs over the same workload spelled `as p`.
  for (const phase of ['capture', 'resolve']) {
    metrics[`deferred_to_prefixed_${phase}_ratio`] =
      timings.deferred_large[`${phase}_ms`] / timings.prefixed_large[`${phase}_ms`];
  }
  const out = {
    shapes,
    timings,
    metrics,
    estimator: { warmup: WARMUP, samples: REPS, statistic: 'minimum', interleaved: true },
  };
  console.log(JSON.stringify(out, null, 2));
  // Correctness holds on every run, not only under --check: each use reaches
  // its own library's members, nothing reaches a `loadLibrary`, and the
  // deferred form resolves exactly what the prefixed control resolves.
  for (const [name, shape] of Object.entries(shapes)) {
    assert.equal(shape.expected_missing, 0, `${name}: expected edges missing`);
    assert.equal(shape.wrong_prefix_edges, 0, `${name}: an edge left its own prefix`);
    assert.equal(shape.load_library_edges, 0, `${name}: an edge reached loadLibrary`);
  }
  for (const name of Object.keys(SHAPES)) {
    assert.equal(
      shapes[`deferred_${name}`].fingerprint,
      shapes[`prefixed_${name}`].fingerprint,
      `${name}: the deferred graph differs from the prefixed control`,
    );
  }
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'Dart deferred-import workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[dart-deferred-imports --check] PASS');
  }
}
