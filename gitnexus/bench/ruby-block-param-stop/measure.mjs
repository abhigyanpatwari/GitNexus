/**
 * Ruby block-parameter stop correctness and scaling gate (#3905, RUBY-03).
 *
 * Block, lambda and method parameters are published as `@scope.lexical-names`
 * on the scope that declares them, so the shared receiver walk stops at a
 * block parameter instead of climbing to a same-named outer local and taking
 * its type. This gate pins what that produces and checks that its cost grows
 * linearly in the number of methods, in blocks per method and in block nesting
 * depth.
 *
 * Workload: `lib/models.rb` declares `User` and a decoy `AuditLog`, each with
 * `save` and `run`, so a name-only guess cannot pick the owner. Each of N
 * files `lib/svc<i>.rb` holds class `Svc<i>` with one method `m(items)` that
 * sets `user = User.new`, holds K blocks rotating three kinds, then calls
 * `user.save`. One class per file: on main, Ruby resolution is already
 * super-linear in the number of classes or methods in ONE file, which would
 * mask this change. `--shape crowded <methods> <blocks>` (sweeps only, not
 * gated) puts every class in one file to measure that term.
 *   `items.each do |x| user.run end`          binds another name: the nearest `user`
 *   `items.each do |user| user.save end`      rebinds `user`: no edge
 *   `items.each do |user, i| user.save end`   rebinds it destructured: no edge
 * `sibling` puts the K blocks side by side (the `|x|` block reaches the local
 * `User`); `nested` nests them K deep (only blocks above every rebinding reach
 * it). Each method's CALLS edges must equal the expected multiset exactly: no
 * missing edge, no extra one.
 *
 * Shapes: small = 64 methods x 6 blocks; large = 256 x 6 (methods 4x);
 * dense = 64 x 24 (blocks per method 4x; for `nested`, depth 4x).
 * Two profiles. Default (CI, also with --check): one process prepares every
 * workload, runs every accuracy gate, and times every workload interleaved
 * (each round times each workload once, in rotating order), min of 5 after 1
 * warmup. `--full`: one child times every workload, min of 15 after 2 warmups
 * (the estimator of bench/ruby-gem-resolution), and each shape's accuracy
 * cells and peak RSS come from a fresh child process (`--shape`). Phases:
 *  - capture_ms: emitRubyScopeCaptures over every file. Build-free.
 *  - resolve_ms: runScopeResolution over worker-extracted files. The corpus is
 *    parsed once through the real parse worker, so this needs dist/. Each
 *    timed pass replays a structured clone of the worker output through
 *    mergeChunkResults into a fresh graph and model, outside the timer.
 *
 * `--shape <form> <methods> <blocks> --reps R --warmup W` also times that one
 * workload in its own process, for size sweeps.
 *
 * node --import tsx bench/ruby-block-param-stop/measure.mjs [--check] [--full]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitRubyScopeCaptures } from '../../src/core/ingestion/languages/ruby/index.ts';
import { rubyScopeResolver } from '../../src/core/ingestion/languages/ruby/scope-resolver.ts';
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
const MARKER = 'RUBY_BLOCK_PARAM_RESULT ';
const FORMS = ['sibling', 'nested'];
const SHAPES = { small: [64, 6], large: [256, 6], dense: [64, 24] };
const MODELS = 'lib/models.rb';
const roots = [];
/** One parse worker for every workload in this process. */
let pool;

const KINDS = [
  { params: '|x|', body: 'user.run', binds: false },
  { params: '|user|', body: 'user.save', binds: true },
  { params: '|user, i|', body: 'user.save', binds: true },
];

function corpus(form, methods, blocks) {
  const models =
    'class User\n  def save; end\n  def run; end\nend\n\n' +
    'class AuditLog\n  def save; end\n  def run; end\nend\n';
  const files = [{ path: MODELS, content: models }];
  const shape = form === 'crowded' ? 'sibling' : form;
  let crowded = "require_relative 'models'\n";
  for (let i = 0; i < methods; i++) {
    let source = `class Svc${i}\n  def m(items)\n    user = User.new\n`;
    if (shape === 'sibling') {
      for (let j = 0; j < blocks; j++) {
        const kind = KINDS[j % KINDS.length];
        source += `    items.each do ${kind.params}\n      ${kind.body}\n    end\n`;
      }
    } else {
      for (let j = 0; j < blocks; j++) {
        const kind = KINDS[j % KINDS.length];
        const indent = '  '.repeat(j + 2);
        source += `${indent}items.each do ${kind.params}\n${indent}  ${kind.body}\n`;
      }
      for (let j = blocks - 1; j >= 0; j--) source += `${'  '.repeat(j + 2)}end\n`;
    }
    source += '    user.save\n  end\nend\n';
    if (form === 'crowded') crowded += `\n${source}`;
    else files.push({ path: `lib/svc${i}.rb`, content: `require_relative 'models'\n\n${source}` });
  }
  if (form === 'crowded') files.push({ path: 'lib/main.rb', content: crowded });
  return files;
}

/** The CALLS targets one method must produce, one per resolved call site. */
function expectedTargets(form, blocks) {
  const targets = [`Method:${MODELS}:User.save#0`]; // the closing `user.save`
  let shadowed = false; // an enclosing block rebinds `user` (nested only)
  for (let j = 0; j < blocks; j++) {
    const kind = KINDS[j % KINDS.length];
    if (form === 'nested' && kind.binds) shadowed = true;
    if (kind.binds || shadowed) continue; // the block's own `user` has no type
    targets.push(`Method:${MODELS}:User.${kind.body.slice(5)}#0`);
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
    rubyScopeResolver,
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

function correctness(form, methods, blocks, graph, stats, captureGroups) {
  const edges = [];
  const callsBySource = new Map();
  let calls = 0;
  for (const edge of graph.iterRelationships()) {
    edges.push(
      JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
    );
    const method = /^Method:lib\/(?:svc\d+|main)\.rb:Svc(\d+)\.m#/.exec(edge.sourceId);
    if (edge.type !== 'CALLS' || method === null) continue;
    calls++;
    const list = callsBySource.get(method[1]) ?? [];
    list.push(edge.targetId);
    callsBySource.set(method[1], list);
  }
  const expected = expectedTargets(form === 'crowded' ? 'sibling' : form, blocks);
  let missing = 0;
  let unexpected = 0;
  for (let i = 0; i < methods; i++) {
    const got = [...(callsBySource.get(String(i)) ?? [])].sort();
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
    methods,
    blocks_per_method: blocks,
    capture_groups: captureGroups,
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
async function prepare(form, methods, blocks) {
  const files = corpus(form, methods, blocks);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ruby-block-param-bench-'));
  roots.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), file.content);
  }
  // The real manifest loader, once; it is not what is timed.
  const config = await rubyScopeResolver.loadResolutionConfig(root);
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
  for (const file of files) groups += emitRubyScopeCaptures(file.content, file.path).length;
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
async function measureShape(form, methods, blocks, reps, warmup) {
  const input = await prepare(form, methods, blocks);
  // Through one worker parse (thread included) and one resolution.
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const groups = captureGroups(input.files);
  const shape = correctness(form, methods, blocks, input.parsed.graph, input.first.stats, groups);
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
    for (const [name, [methods, blocks]] of Object.entries(SHAPES)) {
      const { files, config, raw, parsed } = await prepare(form, methods, blocks);
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
    const [form, methods, blocks] = process.argv.slice(shapeArg + 1, shapeArg + 4);
    assert.ok([...FORMS, 'crowded'].includes(form), `unknown form ${form}`);
    const result = await measureShape(
      form,
      Number(methods),
      Number(blocks),
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
      for (const [name, [methods, blocks]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const result = child(['--shape', form, String(methods), String(blocks)]);
        shapes[key] = result.shape;
        timings[key].peak_rss_mib = result.peak_rss_mib;
      }
    }
  } else {
    const inputs = {};
    const prepared = {};
    for (const form of FORMS) {
      for (const [name, [methods, blocks]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = await prepare(form, methods, blocks);
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
      for (const [name, [methods, blocks]] of Object.entries(SHAPES)) {
        const key = `${form}_${name}`;
        const input = prepared[key];
        shapes[key] = correctness(
          form,
          methods,
          blocks,
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
      metrics[`${form}_${phase}_method_scaling_ratio`] =
        at('large')[key] / at('small')[key] / scale;
      metrics[`${form}_${phase}_block_scaling_ratio`] = at('dense')[key] / at('small')[key] / scale;
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
  // Correctness holds on every run, not only under --check: each method's
  // CALLS edges are exactly the expected multiset.
  for (const [name, shape] of Object.entries(shapes)) {
    assert.equal(shape.expected_missing, 0, `${name}: expected edges missing`);
    assert.equal(shape.unexpected_edges, 0, `${name}: edges the source never makes`);
  }
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'Ruby block-parameter workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[ruby-block-param-stop --check] PASS');
  }
}
