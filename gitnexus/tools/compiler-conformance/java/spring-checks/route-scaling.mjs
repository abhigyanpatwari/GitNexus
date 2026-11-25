import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringTypes } from '../../../../dist/core/ingestion/route-extractors/spring.js';
import { resolveInheritedSpringRoutes } from '../../../../dist/core/ingestion/route-extractors/spring-shared.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';

function parse(src) {
  const p = new Parser();
  p.setLanguage(Java);
  return p.parse(src);
}

function scalingLabel(ratio) {
  if (ratio < 1.5) return 'linear';
  return ratio < 3 ? 'superlinear' : 'WARNING: quadratic';
}

export async function verifyInheritanceBenchmark() {
  /**
   * Spring interface-inheritance benchmark (#2288 / PR #2290 review).
   *
   * Measures the cost of the cross-file interface-inheritance path this PR adds:
   * parse → `extractSpringTypes` (per file) → `resolveInheritedSpringRoutes`
   * (project-wide). The fixture is a *realistic* Spring shape — N route-defining
   * interfaces, each implemented by exactly one `@RestController` (1:1), the
   * dominant `interface + @RestController impl` pattern. (An every-controller-
   * implements-every-interface shape is not a real Spring idiom, so it is not
   * modelled.)
   *
   * The default run exercises the resolver work bound. Set GITNEXUS_BENCH=1
   * to measure resolver and full-pipeline scaling.
   */

  const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
  const DIST_WORKER_URL = new URL(
    '../../../../dist/core/ingestion/workers/parse-worker.js',
    import.meta.url,
  );

  /** Methods declared per interface (each becomes one inherited route). */
  const METHODS_PER_INTERFACE = 4;

  /**
   * Generate `pairCount` interface+controller pairs and return the project-wide
   * `SharedSpringType[]` (the shape `resolveInheritedSpringRoutes` consumes),
   * built through the real `extractSpringTypes` collector so the benchmark
   * exercises both halves of the pass.
   */
  function buildSpringTypes(pairCount) {
    const types = [];
    for (let i = 0; i < pairCount; i++) {
      const methods = Array.from(
        {
          length: METHODS_PER_INTERFACE,
        },
        (_, m) => `  @GetMapping("/m${m}") Object op${m}();`,
      ).join('\n');
      const iface = `package com.example.api;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api/r${i}")
public interface Api${i} {
${methods}
}
`;
      const impls = Array.from(
        {
          length: METHODS_PER_INTERFACE,
        },
        (_, m) => `  public Object op${m}() { return null; }`,
      ).join('\n');
      const controller = `package com.example.web;
import com.example.api.Api${i};
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/v1")
public class Controller${i} implements Api${i} {
${impls}
}
`;
      types.push(
        ...extractSpringTypes(parse(iface), `Api${i}.java`),
        ...extractSpringTypes(parse(controller), `Controller${i}.java`),
      );
    }
    return types;
  }
  /**
   * Write the same interface and controller pairs as `buildSpringTypes` under
   * `dir` so the benchmark exercises file discovery, parsing and route resolution.
   */
  function writeSpringRepo(dir, pairCount) {
    const apiDir = path.join(dir, 'api');
    const webDir = path.join(dir, 'web');
    fs.mkdirSync(apiDir, {
      recursive: true,
    });
    fs.mkdirSync(webDir, {
      recursive: true,
    });
    for (let i = 0; i < pairCount; i++) {
      const methods = Array.from(
        {
          length: METHODS_PER_INTERFACE,
        },
        (_, m) => `  @GetMapping("/m${m}") Object op${m}();`,
      ).join('\n');
      fs.writeFileSync(
        path.join(apiDir, `Api${i}.java`),
        `package com.example.api;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api/r${i}")
public interface Api${i} {
${methods}
}
`,
      );
      const impls = Array.from(
        {
          length: METHODS_PER_INTERFACE,
        },
        (_, m) => `  public Object op${m}() { return null; }`,
      ).join('\n');
      fs.writeFileSync(
        path.join(webDir, `Controller${i}.java`),
        `package com.example.web;
import com.example.api.Api${i};
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/v1")
public class Controller${i} implements Api${i} {
${impls}
}
`,
      );
    }
  }

  /**
   * End-to-end pipeline scaling: runs the WHOLE `runPipelineFromRepo` on synthetic
   * Spring repos of growing size and asserts the total analyze time stays linear
   * in the number of interface→controller pairs. This is the "end-to-end" measure
   * (read → parse → worker → cross-file inheritance pass → graph), complementing
   * the isolated-resolver tripwire above.
   *
   * Needs the compiled worker (extractSpringTypes runs inside it):
   *   (cd gitnexus && npm run build)
   *   GITNEXUS_BENCH=1 node tools/compiler-conformance/java/spring-check.mjs route-scaling
   */
  // Spring inheritance O(n²) regression tripwire (#2288)

  // resolves N=400 interface→controller pairs within the coarse budget
  const PAIRS = 400;
  const BUDGET_MS = 5_000; // coarse tripwire: a quadratic re-regression blows this
  const types = buildSpringTypes(PAIRS);

  // warm up the JIT
  resolveInheritedSpringRoutes(buildSpringTypes(5));
  const start = Date.now();
  const routes = resolveInheritedSpringRoutes(types);
  const elapsedMs = Date.now() - start;

  // Non-vacuous: every pair contributes METHODS_PER_INTERFACE inherited routes.
  assert.equal(routes.length, PAIRS * METHODS_PER_INTERFACE);
  assert.ok(elapsedMs < BUDGET_MS);
  console.log(
    `  spring-inheritance tripwire: ${PAIRS} pairs → ${routes.length} inherited routes, ${elapsedMs}ms`,
  );
  // is a no-op (and instant) when there are no Spring types

  // Non-Java / no-interface repos pay ~0 — the Java provider hook is the only
  // populator of springTypes, so the pass receives an empty list elsewhere.
  assert.deepStrictEqual(resolveInheritedSpringRoutes([]), []);
  // Spring inheritance scaling benchmark (#2288)
  function measureInheritanceScaling() {
    // scales linearly with interface×controller pair count

    const scales = [250, 500, 1000];
    // The resolve is microseconds-per-pair, far below Date.now()'s 1ms floor, so
    // we sum many repetitions with performance.now() (sub-ms) to get a stable,
    // noise-free signal — otherwise the ratio is pure timer quantisation.
    const REPS = 200;
    const results = [];
    for (const pairs of scales) {
      const types = buildSpringTypes(pairs);
      for (let w = 0; w < 5; w++) resolveInheritedSpringRoutes(types); // warm up

      let routeCount = 0;
      const start = performance.now();
      for (let r = 0; r < REPS; r++) {
        routeCount = resolveInheritedSpringRoutes(types).length;
      }
      const totalMs = performance.now() - start;
      results.push({
        pairs,
        routes: routeCount,
        totalMs,
      });
      console.log(
        `  ${pairs} pairs ×${REPS}: ${totalMs.toFixed(1)}ms total (${routeCount} routes/run)`,
      );
    }
    console.log('\nSpring Inheritance — Scaling');
    console.log('┌──────────┬───────────────┬───────────┐');
    console.log('│ Pairs    │ Time ×REPS ms │ Routes    │');
    console.log('├──────────┼───────────────┼───────────┤');
    for (const r of results) {
      console.log(
        `│ ${String(r.pairs).padStart(8)} │ ${r.totalMs.toFixed(1).padStart(13)} │ ${String(r.routes).padStart(9)} │`,
      );
    }
    console.log('└──────────┴───────────────┴───────────┘');
    console.log('\nScaling ratios (time_ratio / size_ratio):');
    for (let i = 1; i < results.length; i++) {
      const sizeRatio = results[i].pairs / results[i - 1].pairs;
      const timeRatio = results[i].totalMs / results[i - 1].totalMs;
      const scaling = timeRatio / sizeRatio;
      console.log(
        `  ${results[i - 1].pairs} → ${results[i].pairs}: ${scaling.toFixed(2)}x (${scalingLabel(scaling)})`,
      );
      assert.ok(scaling < 1.5);
    }
  }
  // Spring inheritance pipeline benchmark — end-to-end (#2288)
  async function measureInheritancePipeline() {
    // full analyze scales linearly with interface→controller pair count

    const scales = [100, 250, 500];
    const results = [];
    await runInSequence(scales, async (pairs) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-inherit-bench-${pairs}-`));
      try {
        writeSpringRepo(dir, pairs);
        const start = Date.now();
        const result = await runPipelineFromRepo(dir, () => {}, {
          workerUrlForTest: DIST_WORKER_URL,
        });
        const elapsedMs = Date.now() - start;
        let routeNodes = 0;
        result.graph.forEachNode((n) => {
          if (n.label === 'Route') routeNodes++;
        });
        results.push({
          pairs,
          elapsedMs,
          routeNodes,
        });
        console.log(`  ${pairs} pairs: ${elapsedMs}ms (${routeNodes} Route nodes)`);
      } finally {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
        });
      }
    });
    console.log('\nSpring Inheritance — End-to-End Pipeline');
    console.log('┌──────────┬───────────┬────────────┐');
    console.log('│ Pairs    │ Time (ms) │ Route nodes│');
    console.log('├──────────┼───────────┼────────────┤');
    for (const r of results) {
      console.log(
        `│ ${String(r.pairs).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.routeNodes).padStart(10)} │`,
      );
    }
    console.log('└──────────┴───────────┴────────────┘');

    // Sanity: each pair yields METHODS_PER_INTERFACE inherited Route nodes.
    for (const r of results) {
      assert.equal(r.routeNodes, r.pairs * METHODS_PER_INTERFACE);
    }
    console.log('\nScaling ratios (time_ratio / size_ratio):');
    for (let i = 1; i < results.length; i++) {
      const sizeRatio = results[i].pairs / results[i - 1].pairs;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / sizeRatio;
      console.log(
        `  ${results[i - 1].pairs} → ${results[i].pairs}: ${scaling.toFixed(2)}x (${scalingLabel(scaling)})`,
      );
      // Full-pipeline wall-clock carries fixed startup/teardown overhead that
      // dominates at small N, so the ratio is biased BELOW 1 at these sizes; a
      // quadratic regression in the inheritance pass still pushes it past 1.5.
      assert.ok(scaling < 1.5);
    }
  }
  if (!BENCH_ENABLED) return;
  measureInheritanceScaling();
  await measureInheritancePipeline();
}
