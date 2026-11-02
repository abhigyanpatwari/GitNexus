#!/usr/bin/env node
/**
 * Build-free Go route extraction and symbolic-resolution benchmark (#3417).
 *
 *   node --import tsx bench/go-route-resolution/measure.cjs
 *   node --import tsx bench/go-route-resolution/measure.cjs --check
 *
 * Parsing, model construction, fingerprints and counts are outside timing.
 * Resolution creates a fresh pass context inside each timed sample, including
 * lazy index construction rather than measuring only warmed lookups.
 * Each arm grows 4x. Only normalized scaling ratios are timing gates; exact
 * route/target identities and positive counts prevent fast empty answers.
 * BENCH_SOURCE_ROOT selects another repository checkout for comparison.
 */
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = resolve(__dirname, '../..');
const SOURCE_ROOT = process.env.BENCH_SOURCE_ROOT
  ? resolve(process.env.BENCH_SOURCE_ROOT, 'gitnexus')
  : ROOT;
const BASELINE = join(__dirname, 'baseline.json');
const WARMUP = 5;
const REPS = 15;
const SCALES = { extraction: [96, 384], resolution: [256, 1024], imports: [512, 2048] };
const FILE = 'app/routes.go';
const ARM_FIELDS = {
  spread: ['routes', 'named_handlers', 'receiver_hints'],
  concentrated: ['routes', 'named_handlers', 'receiver_hints'],
  lexical: ['routes', 'named_handlers', 'receiver_hints'],
  method_bucket: ['sites', 'resolved', 'declined'],
  import_bindings: ['imports', 'target_lookups', 'source_reads'],
};

const load = (file) => import(pathToFileURL(join(SOURCE_ROOT, 'src', file)).href);

function source(shape, count) {
  const body = ['package app', 'import "github.com/gin-gonic/gin"'];
  if (shape === 'concentrated') {
    body.push('func Register(r *gin.Engine) {', 'h := &Handler{}');
    for (let i = 0; i < count; i++) {
      body.push('h = &Handler{}', `r.GET("/route-${i}", h.Do)`);
    }
    body.push('}');
  } else {
    for (let i = 0; i < count; i++) {
      if (shape === 'spread') {
        body.push(
          `func Register${i}(r *gin.Engine) {`,
          'h := &Handler{}',
          `r.GET("/route-${i}", h.Do)`,
          '}',
        );
      } else {
        body.push(
          `func Register${i}(r *gin.Engine, Handle func(*gin.Context)) {`,
          'h := &A{}',
          'func() { h = &B{} }()',
          `r.GET("/capture-${i}", h.Do)`,
          `r.GET("/bare-${i}", Handle)`,
          `{ var r FakeRouter; r.GET("/fake-${i}", PackageHandler) }`,
          `r.GET("/outer-${i}", PackageHandler)`,
          '}',
        );
      }
    }
  }
  return body.join('\n');
}

function routeIdentity(route) {
  return JSON.stringify([
    route.filePath,
    route.httpMethod,
    route.routePath,
    route.handlerName ?? null,
    route.handlerReceiver ?? null,
    route.lineNumber,
  ]);
}

function pair(small, large) {
  return { small, large, linear_factor: large.min_ms / small.min_ms / (large.units / small.units) };
}

async function main() {
  const checkRequested = process.argv.includes('--check');
  const baseline = checkRequested ? JSON.parse(readFileSync(BASELINE, 'utf8')) : undefined;
  if (checkRequested) {
    assert.ok(
      baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline),
      'baseline must be a non-null object',
    );
    assert.deepEqual(
      Object.keys(baseline.arms).sort(),
      Object.keys(ARM_FIELDS).sort(),
      'baseline must retain exactly all five arms',
    );
    for (const [shape, fields] of Object.entries(ARM_FIELDS)) {
      const arm = baseline.arms[shape];
      assert.ok(
        Number.isFinite(arm.linear_scaling_budget) && arm.linear_scaling_budget > 0,
        `${shape}: missing or invalid scaling budget`,
      );
      for (const scale of ['small', 'large']) {
        const expected = arm[scale];
        assert.deepEqual(
          Object.keys(expected).sort(),
          ['units', ...fields, 'fingerprint'].sort(),
          `${shape}.${scale}: missing or unexpected correctness fields`,
        );
        assert.match(expected.fingerprint, /^[a-f0-9]{64}$/);
        for (const key of ['units', ...fields]) {
          assert.ok(
            Number.isSafeInteger(expected[key]) && expected[key] >= 0,
            `${shape}.${scale}.${key}: invalid count`,
          );
        }
        assert.ok(expected.units > 0, `${shape}.${scale}: empty workload`);
      }
    }
  }
  const [
    { default: Parser },
    { default: Go },
    { extractGoGinEchoRoutes },
    { resolveGoRouteHandler },
    { createSemanticModel },
    { minSample, fingerprintIds },
  ] = await Promise.all([
    import('tree-sitter'),
    import('tree-sitter-go'),
    load('core/ingestion/route-extractors/go-gin-echo.ts'),
    load('core/ingestion/languages/go/route-handler.ts'),
    load('core/ingestion/model/semantic-model.ts'),
    import('../lib/identity-guard.mjs'),
  ]);
  const parser = new Parser();
  parser.setLanguage(Go);

  function extraction(shape, units) {
    const text = source(shape, units);
    const tree = parser.parse(text, null, { bufferSize: Buffer.byteLength(text) + 1 });
    assert.equal(tree.rootNode.hasError, false, `${shape}: invalid Go syntax`);
    const { last, ms } = minSample(() => extractGoGinEchoRoutes(tree, FILE), WARMUP, REPS);
    return {
      units,
      min_ms: ms,
      routes: last.length,
      named_handlers: last.filter((r) => r.handlerName !== undefined).length,
      receiver_hints: last.filter((r) => r.handlerReceiver !== undefined).length,
      fingerprint: fingerprintIds(last.map(routeIdentity)),
    };
  }

  function resolution(units) {
    const model = createSemanticModel();
    const routes = [];
    for (let i = 0; i < units; i++) {
      const dir = `app/pkg${i}`;
      for (const name of ['Handler', 'Empty']) {
        const file = `${dir}/types.go`;
        model.symbols.add(file, name, `Struct:${file}:${name}`, 'Struct');
        routes.push({
          filePath: `${dir}/routes.go`,
          routePath: `/${i}/${name}`,
          httpMethod: 'GET',
          decoratorName: 'GET',
          lineNumber: i + 1,
          source: 'gin-route',
          handlerName: 'h.Do',
          handlerReceiver: { kind: 'type', name },
        });
      }
      // Worker ownership uses the method's file, deliberately different from
      // the struct's file. A canonical-owner-only lookup would lose every hit.
      const file = `${dir}/methods.go`;
      model.symbols.add(file, 'Do', `Method:${file}:Handler.Do`, 'Method', {
        ownerId: `Struct:${file}:Handler`,
      });
      for (const name of ['Handle', 'NewHandler']) {
        model.symbols.add(file, name, `Function:${file}:${name}`, 'Function', {
          returnType: name === 'NewHandler' ? '*Handler' : undefined,
        });
        routes.push({
          filePath: `${dir}/routes.go`,
          routePath: `/${i}/${name}`,
          httpMethod: 'GET',
          decoratorName: 'GET',
          lineNumber: i + 1,
          source: 'gin-route',
          handlerName: name === 'Handle' ? name : 'h.Do',
          ...(name === 'NewHandler' ? { handlerReceiver: { kind: 'constructor', name } } : {}),
        });
      }
    }
    const run = () => {
      const context = { model, importTargetsFor: () => [] };
      return routes.map((r) => resolveGoRouteHandler(r, context));
    };
    const { last, ms } = minSample(run, WARMUP, REPS);
    const resolved = last.filter((id) => id !== undefined).length;
    assert.equal(resolved, units * 3, 'symbol resolution lost its positive control');
    return {
      units,
      min_ms: ms,
      sites: routes.length,
      resolved,
      declined: routes.length - resolved,
      fingerprint: fingerprintIds(
        last.map((id, i) => `${routes[i].routePath} -> ${id ?? '<none>'}`),
      ),
    };
  }

  function imports(resolveGoImportBinding, units) {
    const texts = new Map();
    const inputs = [];
    for (let i = 0; i < units; i++) {
      const files = Array.from({ length: 8 }, (_, j) => `pkg${i}/file${j}.go`);
      files.forEach((file) =>
        texts.set(file, `/* package old is a comment */\npackage declared${i}\n`),
      );
      const targetRaw = `example.com/app/pkg${i}/v2`;
      inputs.push({
        parsed: {
          kind: 'namespace',
          targetRaw,
          localName: `pkg${i}`,
          importedName: `pkg${i}`,
          implicitLocalName: true,
        },
        files,
      });
      inputs.push({
        parsed: { kind: 'namespace', targetRaw, localName: `alias${i}`, importedName: `alias${i}` },
        files,
      });
    }
    let targetLookups = 0;
    let sourceReads = 0;
    const run = () => {
      targetLookups = 0;
      sourceReads = 0;
      return inputs.map(({ parsed, files }) =>
        resolveGoImportBinding(
          parsed,
          () => {
            targetLookups++;
            return files;
          },
          (file) => {
            sourceReads++;
            return texts.get(file);
          },
        ),
      );
    };
    const { last, ms } = minSample(run, WARMUP, REPS);
    assert.equal(targetLookups, units, 'explicit aliases must not resolve targets again');
    assert.equal(sourceReads, units * 8, 'implicit imports must read their package clauses');
    return {
      units,
      min_ms: ms,
      imports: last.length,
      target_lookups: targetLookups,
      source_reads: sourceReads,
      fingerprint: fingerprintIds(last.map((item, i) => `${i}:${item.kind}:${item.localName}`)),
    };
  }

  const report = { reps: REPS, warmup: WARMUP, source_root: SOURCE_ROOT };
  for (const shape of ['spread', 'concentrated', 'lexical']) {
    report[shape] = pair(...SCALES.extraction.map((n) => extraction(shape, n)));
  }
  report.method_bucket = pair(...SCALES.resolution.map(resolution));
  const importPath = join(SOURCE_ROOT, 'src/core/ingestion/languages/go/import-binding.ts');
  if (existsSync(importPath)) {
    const { resolveGoImportBinding } = await import(pathToFileURL(importPath).href);
    report.import_bindings = pair(...SCALES.imports.map((n) => imports(resolveGoImportBinding, n)));
  }

  if (checkRequested) {
    const errors = [];
    for (const [shape, expected] of Object.entries(baseline.arms)) {
      const actual = report[shape];
      if (!actual) {
        errors.push(`${shape}: missing arm`);
        continue;
      }
      for (const scale of ['small', 'large']) {
        for (const [key, value] of Object.entries(expected[scale])) {
          if (actual[scale][key] !== value)
            errors.push(`${shape}.${scale}.${key}: ${actual[scale][key]} != ${value}`);
        }
        if (!Number.isFinite(actual[scale].min_ms) || actual[scale].min_ms <= 0) {
          errors.push(`${shape}.${scale}: invalid timing`);
        }
      }
      const budget = expected.linear_scaling_budget;
      if (
        !Number.isFinite(budget) ||
        budget <= 0 ||
        !Number.isFinite(actual.linear_factor) ||
        actual.linear_factor > budget
      ) {
        errors.push(`${shape}.linear_factor: ${actual.linear_factor} exceeds ${budget}`);
      }
    }
    console.log(JSON.stringify({ ok: errors.length === 0, report, errors }, null, 2));
    if (errors.length) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
