#!/usr/bin/env node
/**
 * Go route-fact collection and replay, using the production provider hooks.
 * Run: node --expose-gc --import tsx bench/go-route-facts/measure.js --check
 * Record a reviewed baseline: same command with --record instead of --check.
 *
 * Parsing, serialization and fingerprints are outside timing. Each invocation
 * collects fresh facts or replays serialized facts with a fresh resolution
 * context. Parameters AND registrations grow in the manyParameters workload.
 * Adaptive batches avoid sub-millisecond timing ratios; sample order rotates
 * across three 4x sizes. Check adjacent sizes and the full 16x range.
 * Serialized bytes cover collected routes/facts, not worker envelopes or heap.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { goProvider } from '../../src/core/ingestion/languages/go.ts';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean' },
    record: { type: 'boolean' },
    baseline: { type: 'string' },
    output: { type: 'string' },
  },
});
assert(!(values.check && values.record), 'Choose --check or --record');
const baselinePath = values.baseline ?? new URL('./baseline.json', import.meta.url);
const shapes = ['noRoutes', 'direct', 'wrapped', 'mixed', 'manyParameters'];
const sizes = [128, 512, 2048];
const metrics = ['collect_ms', 'replay_ms', 'serialized_bytes'];
const budgets = { collect_ms: 1.5, replay_ms: 1.5, serialized_bytes: 1.15 };
const warmups = 8;
const samples = 7;
const batchMs = 40;
const filePath = 'routes.go';
const alias = { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' };
const routeHookConfig = {
  routeFrameworkAliases: [alias],
  routeHandlerWrappers: ['common.Wrapper'],
};
const parsedFile = {
  filePath,
  moduleScope: 'bench',
  scopes: [],
  parsedImports: [],
  localDefs: [],
  referenceSites: [],
};
const expectedCount = (shape, size) => (shape === 'noRoutes' ? 0 : size);
const id = (i) => String(i).padStart(8, '0');
const lines = (size, line) => Array.from({ length: size }, (_, i) => line(i)).join('\n');
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

function source(shape, size) {
  if (shape === 'noRoutes') {
    return `package routes\nimport "fmt"\n${lines(
      size,
      (i) => `func F${id(i)}(x int) int { fmt.Println(x); return x + 1 }`,
    )}`;
  }
  const imports =
    shape === 'direct'
      ? 'import "github.com/gin-gonic/gin"'
      : shape === 'mixed'
        ? 'import "github.com/gin-gonic/gin"\nimport core "example.com/infra/pkg"'
        : 'import core "example.com/infra/pkg"\nimport "example.com/app/common"';
  const parameters =
    shape === 'direct'
      ? 'r *gin.Engine'
      : shape === 'mixed'
        ? 'r *gin.Engine, s *core.Engine'
        : `r *core.Engine${
            shape === 'manyParameters'
              ? `, ${Array.from({ length: size }, (_, i) => `x${id(i)} *core.T${id(i)}`).join(', ')}`
              : ''
          }`;
  return `package routes\n${imports}\nfunc Register(${parameters}) {
g := r.Group("/api")
${shape === 'mixed' ? 'a := s.Group("/api")' : ''}
${lines(
  size,
  (i) =>
    `${shape === 'mixed' && i % 2 ? 'a' : 'g'}.GET("/${id(i)}", Middleware, ${
      shape === 'wrapped' ? `common.Wrapper(Handler${id(i)})` : `Handler${id(i)}`
    })`,
)}
}`;
}

function collect(tree) {
  return {
    direct: goProvider.extractDecoratorRoutes?.(tree, filePath, 0) ?? [],
    facts: goProvider.extractRouteFacts(tree, parsedFile, 0) ?? null,
  };
}

function replay(collected) {
  return [
    ...goProvider.resolveRouteFacts([{ filePath, facts: collected.facts }], {
      resolveImportTargets: () => [],
      routeHookConfig,
    }),
    ...collected.direct,
  ];
}

function identity(shape, size, collected) {
  const routes = replay(collected);
  const count = expectedCount(shape, size);
  assert.equal(routes.length, count, `${shape}/${size}: route count`);
  assert.deepEqual(
    routes.map((r) => r.routePath).sort(),
    Array.from({ length: count }, (_, i) => `/api/${id(i)}`),
    `${shape}/${size}: route paths`,
  );
  for (const route of routes) {
    const handler = `Handler${route.routePath.slice(-8)}`;
    assert.equal(route.httpMethod, 'GET');
    assert.equal(route.source, 'gin-route');
    assert.equal(route.filePath, filePath);
    if (shape === 'wrapped') {
      assert.deepEqual(route.handlerWrapper, { callee: 'common.Wrapper', handlerName: handler });
    } else {
      assert.equal(route.handlerName, handler);
    }
  }
  const candidates = (collected.facts?.roots ?? []).reduce((n, root) => n + root.routes.length, 0);
  assert.equal(candidates, count, `${shape}/${size}: candidate count`);
  return {
    size,
    routes: routes.length,
    candidates,
    fingerprint: createHash('sha256').update(JSON.stringify({ collected, routes })).digest('hex'),
  };
}

function validateBaseline(baseline) {
  assert(baseline && typeof baseline === 'object' && !Array.isArray(baseline), 'Invalid baseline');
  assert.equal(baseline.version, 1, 'Unknown baseline version');
  assert.deepEqual(baseline.sizes, sizes, 'Baseline must retain all three sizes');
  assert.deepEqual(baseline.budgets, budgets, 'Baseline must retain the reviewed scaling budgets');
  assert.deepEqual(Object.keys(baseline.workloads).sort(), [...shapes].sort(), 'Missing workload');
  for (const shape of shapes) {
    const rows = baseline.workloads[shape];
    assert(Array.isArray(rows) && rows.length === sizes.length, `${shape}: missing sizes`);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(Object.keys(row).sort(), ['candidates', 'fingerprint', 'routes', 'size']);
      assert.equal(row.size, sizes[index]);
      assert.equal(row.routes, expectedCount(shape, row.size));
      assert.equal(row.candidates, row.routes);
      assert.match(row.fingerprint, /^[a-f0-9]{64}$/);
    }
  }
}

function batch(action, iterations) {
  let result;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) result = action();
  const elapsed = performance.now() - start;
  assert(result !== undefined, 'Benchmark action returned no result');
  return elapsed;
}

function calibrate(action) {
  let iterations = 1;
  while (iterations < 65536 && batch(action, iterations) < batchMs) iterations *= 2;
  return iterations;
}

function scaling(rows) {
  const pairs = [
    [rows[0], rows[1]],
    [rows[1], rows[2]],
    [rows[0], rows[2]],
  ];
  return pairs.map(([small, large]) => {
    const inputRatio = large.size / small.size;
    const factors = Object.fromEntries(
      metrics.map((metric) => {
        assert(Number.isFinite(small[metric]) && small[metric] > 0, `Invalid ${metric}`);
        assert(Number.isFinite(large[metric]) && large[metric] > 0, `Invalid ${metric}`);
        return [metric, large[metric] / small[metric] / inputRatio];
      }),
    );
    return {
      from: small.size,
      to: large.size,
      input_ratio: inputRatio,
      factors,
      passed: metrics.every((metric) => factors[metric] <= budgets[metric]),
    };
  });
}

const baseline = values.check ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;
if (values.check) validateBaseline(baseline);
assert.equal(typeof goProvider.extractRouteFacts, 'function');
assert.equal(typeof goProvider.resolveRouteFacts, 'function');
const parser = new Parser();
parser.setLanguage(Go);
const report = {
  node: process.version,
  warmups,
  samples,
  batch_ms: batchMs,
  workloads: {},
  errors: [],
};
const recorded = {};
for (const shape of shapes) {
  const states = sizes.map((size) => {
    const tree = parser.parse(source(shape, size));
    assert(!tree.rootNode.hasError, `${shape}/${size}: invalid Go fixture`);
    // The replay input survives JSON serialization, just like cached worker facts.
    const collected = JSON.parse(JSON.stringify(collect(tree)));
    const actual = identity(shape, size, collected);
    if (values.check)
      assert.deepEqual(
        actual,
        baseline.workloads[shape][sizes.indexOf(size)],
        `${shape}/${size}: identity drift`,
      );
    const actions = { collect_ms: () => collect(tree), replay_ms: () => replay(collected) };
    for (let i = 0; i < warmups; i++) for (const action of Object.values(actions)) action();
    return {
      size,
      actual,
      actions,
      collected,
      timings: { collect_ms: [], replay_ms: [] },
      iterations: Object.fromEntries(
        Object.entries(actions).map(([key, action]) => [key, calibrate(action)]),
      ),
    };
  });
  for (let round = 0; round < samples; round++) {
    for (let offset = 0; offset < states.length; offset++) {
      const state = states[(round + offset) % states.length];
      for (const [metric, action] of Object.entries(state.actions)) {
        global.gc?.();
        state.timings[metric].push(
          batch(action, state.iterations[metric]) / state.iterations[metric],
        );
      }
    }
  }
  const rows = states.map((state) => ({
    ...state.actual,
    collect_ms: median(state.timings.collect_ms),
    replay_ms: median(state.timings.replay_ms),
    serialized_bytes: Buffer.byteLength(JSON.stringify(state.collected)),
    iterations: state.iterations,
    samples_ms: state.timings,
  }));
  const comparisons = scaling(rows);
  for (const comparison of comparisons) {
    for (const metric of metrics)
      if (comparison.factors[metric] > budgets[metric]) {
        report.errors.push(
          `${shape} ${comparison.from}->${comparison.to}: ${metric} linear factor ${comparison.factors[metric].toFixed(3)} exceeds ${budgets[metric]}`,
        );
      }
  }
  report.workloads[shape] = { rows, comparisons };
  recorded[shape] = states.map((state) => state.actual);
}
report.passed = report.errors.length === 0;
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) writeFileSync(values.output, json);
console.log(json);
if (values.record) {
  assert(report.passed, 'Refusing to record a baseline that fails scaling');
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        _what:
          'Go route-fact collection and serialized replay (#3750). Run node --expose-gc --import tsx bench/go-route-facts/measure.js --check.',
        _method:
          'Three 4x sizes; eight warmups, seven interleaved adaptive batches per size, median per-call time. Parsing, serialization and identity checks are untimed. manyParameters grows parameters and routes together. Serialized bytes exclude worker envelopes and heap.',
        _triage:
          'Check identities before timing. A normalized factor near 1 is linear; quadratic growth produces factors near 4 per adjacent size and 16 across the full range. Re-run timing failures on an idle machine; do not raise budgets or regenerate fingerprints to conceal regressions.',
        version: 1,
        sizes,
        budgets,
        workloads: recorded,
      },
      null,
      2,
    )}\n`,
  );
}
if (values.check && !report.passed) process.exitCode = 1;
