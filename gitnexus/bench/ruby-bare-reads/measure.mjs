/**
 * Ruby bare-read correctness and scaling gate (#3880, RUBY-04).
 *
 * A bare identifier that names a parameter or a local in scope is a read, not
 * a call. The capture pass climbs from each bare identifier through the
 * enclosing block / lambda scopes to the method, asking each scope's cached
 * binding index whether the name is bound before the read; a heredoc body is
 * read at its opener, so a read inside one also looks at the opener line
 * (`rubyHeredocOpenerTail`). This gate pins what that produces and checks that
 * its cost grows linearly in methods, block depth, heredocs per opener line
 * and reads per heredoc body.
 *
 * Workload: N files `lib/host<i>.rb`, each holding class `Host<i>` that
 * declares `target`, `helper` and `other(*args)` plus the method under test.
 * One class per file: on main, Ruby resolution is already super-linear in the
 * number of classes or methods in ONE file, which would mask this change.
 * `--shape crowded <methods> <depth>` (sweeps only, not gated) is the `blocks`
 * form with every class in one file, to measure that term. Two forms:
 *  - `blocks`: `m(target)` calls `helper`, then nests K
 *    `[1].each do |x<j>|` blocks, each reading `target` bare. Every read sees
 *    the parameter: no edge. `helper` binds nothing and stays a call.
 *  - `heredocs`: `h(target)` opens H heredocs on one line,
 *    `other(<<~A0, <<~A1, …)`, each body holding R `#{[1].map do target end}`
 *    reads that see the parameter: no edge. A second method `e(x)` keeps the
 *    exact opener rule: `other(<<~EOS, target = 1)` binds `target` after the
 *    body, so the body's bare `target` is still a call.
 * Each method's CALLS edges must equal the expected multiset exactly.
 *
 * Shapes, with the dimension each one grows 4x over `small`:
 *  - blocks: small 128 methods x depth 4; methods 512 x 4; depth 128 x 16.
 *  - heredocs: small 64 methods x 2 heredocs x 2 reads; methods 256 x 2 x 2;
 *    per_line 64 x 8 x 2; size 64 x 2 x 8.
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
 * `--shape <form> <methods> <k> [<r>] --reps R --warmup W` also times that one
 * workload in its own process, for size sweeps.
 *
 * node --import tsx bench/ruby-bare-reads/measure.mjs [--check] [--full]
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
const MARKER = 'RUBY_BARE_READ_RESULT ';
const FORMS = ['blocks', 'heredocs'];
/** Per form: shape name -> size parameters; every non-small shape grows one 4x. */
const SHAPES = {
  blocks: { small: [128, 4], methods: [512, 4], depth: [128, 16] },
  heredocs: { small: [64, 2, 2], methods: [256, 2, 2], per_line: [64, 8, 2], size: [64, 2, 8] },
};
const SCALE = 4;
const roots = [];
/** One parse worker for every workload in this process. */
let pool;

/** Where class `Host<i>` lives: its own file, or one shared file (`crowded`). */
const hostFile = (form, i) => (form === 'crowded' ? 'lib/host.rb' : `lib/host${i}.rb`);

function corpus(form, methods, k, r = 0) {
  const helpers = '  def target; end\n  def helper; end\n  def other(*args); end\n';
  const files = new Map();
  for (let i = 0; i < methods; i++) {
    let source = `class Host${i}\n${helpers}`;
    if (form !== 'heredocs') {
      source += '\n  def m(target)\n    helper\n';
      for (let j = 0; j < k; j++) {
        const indent = '  '.repeat(j + 2);
        source += `${indent}[1].each do |x${j}|\n${indent}  target\n`;
      }
      for (let j = k - 1; j >= 0; j--) source += `${'  '.repeat(j + 2)}end\n`;
      source += '  end\n';
    } else {
      const read = '      #{[1].map do\n        target\n      end}\n';
      const openers = Array.from({ length: k }, (_, j) => `<<~A${j}`).join(', ');
      source += `\n  def h(target)\n    other(${openers})\n`;
      for (let j = 0; j < k; j++) source += read.repeat(r) + `    A${j}\n`;
      source += '  end\n';
      source += `\n  def e(x)\n    other(<<~EOS, target = 1)\n${read}    EOS\n  end\n`;
    }
    source += 'end\n';
    const file = hostFile(form, i);
    files.set(file, files.has(file) ? `${files.get(file)}\n${source}` : source);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

/** The CALLS targets each tested method of class `Host<i>` must produce. */
function expectedTargets(form, i) {
  // Arity suffixes (`#0`) are dropped: `other(*args)` carries none.
  const at = (name) => `Method:${hostFile(form, i)}:Host${i}.${name}`;
  if (form !== 'heredocs') return { m: [at('helper')] };
  return { h: [at('other')], e: [at('other'), at('target')].sort() };
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

function correctness(form, methods, sizes, graph, stats, captureGroups) {
  const edges = [];
  const callsBySource = new Map();
  let calls = 0;
  for (const edge of graph.iterRelationships()) {
    edges.push(
      JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
    );
    const method = /^Method:lib\/host\d*\.rb:Host(\d+)\.([meh])#/.exec(edge.sourceId);
    if (edge.type !== 'CALLS' || method === null) continue;
    calls++;
    const key = `${method[2]}${method[1]}`;
    const list = callsBySource.get(key) ?? [];
    list.push(edge.targetId.replace(/#\d+$/, ''));
    callsBySource.set(key, list);
  }
  let missing = 0;
  let unexpected = 0;
  for (let i = 0; i < methods; i++) {
    for (const [prefix, expected] of Object.entries(expectedTargets(form, i))) {
      const got = [...(callsBySource.get(`${prefix}${i}`) ?? [])].sort();
      const want = [...expected];
      for (const target of got) {
        const at = want.indexOf(target);
        if (at < 0) unexpected++;
        else want.splice(at, 1);
      }
      missing += want.length;
    }
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
    sizes,
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
async function prepare(form, sizes) {
  const files = corpus(form, ...sizes);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ruby-bare-read-bench-'));
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
async function measureShape(form, sizes, reps, warmup) {
  const input = await prepare(form, sizes);
  // Through one worker parse (thread included) and one resolution.
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const groups = captureGroups(input.files);
  const shape = correctness(form, sizes[0], sizes, input.parsed.graph, input.first.stats, groups);
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
    for (const [name, sizes] of Object.entries(SHAPES[form])) {
      const { files, config, raw, parsed } = await prepare(form, sizes);
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
    const form = process.argv[shapeArg + 1];
    assert.ok([...FORMS, 'crowded'].includes(form), `unknown form ${form}`);
    const sizes = [];
    for (const arg of process.argv.slice(shapeArg + 2)) {
      if (!/^\d+$/.test(arg)) break;
      sizes.push(Number(arg));
    }
    const result = await measureShape(form, sizes, option('--reps', 0), option('--warmup', 0));
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
      for (const [name, sizes] of Object.entries(SHAPES[form])) {
        const key = `${form}_${name}`;
        const result = child(['--shape', form, ...sizes.map(String)]);
        shapes[key] = result.shape;
        timings[key].peak_rss_mib = result.peak_rss_mib;
      }
    }
  } else {
    const inputs = {};
    const prepared = {};
    for (const form of FORMS) {
      for (const [name, sizes] of Object.entries(SHAPES[form])) {
        const key = `${form}_${name}`;
        const input = await prepare(form, sizes);
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
      for (const [name, sizes] of Object.entries(SHAPES[form])) {
        const key = `${form}_${name}`;
        const input = prepared[key];
        shapes[key] = correctness(
          form,
          sizes[0],
          sizes,
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
  const metrics = {};
  for (const form of FORMS) {
    const small = SHAPES[form].small;
    for (const [name, sizes] of Object.entries(SHAPES[form])) {
      if (name === 'small') continue;
      const grown = sizes.filter((n, i) => n !== small[i]);
      assert.ok(
        grown.length === 1 && sizes.some((n, i) => n === small[i] * SCALE),
        `${form}_${name} must grow exactly one dimension ${SCALE}x`,
      );
      for (const phase of ['capture', 'resolve']) {
        const key = `${phase}_ms`;
        metrics[`${form}_${phase}_${name}_scaling_ratio`] =
          timings[`${form}_${name}`][key] / timings[`${form}_small`][key] / SCALE;
      }
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
    assert.deepEqual(shapes, baseline.shapes, 'Ruby bare-read workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[ruby-bare-reads --check] PASS');
  }
}
