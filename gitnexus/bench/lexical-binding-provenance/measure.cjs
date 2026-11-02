#!/usr/bin/env node
/** Fresh-context extraction and wrapper-propagation scaling benchmark (#3630). */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadBaselineClosure, moduleStem } = require('./baseline-closure.cjs');

const ROOT = resolve(__dirname, '../../..');
const SOURCE = resolve(process.env.BENCH_SOURCE_ROOT ?? ROOT, 'gitnexus');
const SETTINGS = JSON.parse(readFileSync(join(__dirname, 'baseline.json'), 'utf8'));
const FILE = 'bench.ts';
const hash = (identities) =>
  createHash('sha256')
    .update([...identities].sort().join('\n'))
    .digest('hex');
const load = (file) => import(pathToFileURL(join(SOURCE, 'src', file)).href);
const args = process.argv.slice(2);
const check = args.includes('--check');
const verifyOnly = args.includes('--verify');
const armIndex = args.indexOf('--arm');
const selected = armIndex < 0 ? undefined : args[armIndex + 1];

function environmentMetadata() {
  let allowedCpus;
  if (process.platform === 'linux') {
    try {
      allowedCpus = readFileSync('/proc/self/status', 'utf8')
        .match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
        .trim();
    } catch {
      // /proc can be unavailable in otherwise valid Linux environments.
    }
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    ...(allowedCpus === undefined ? {} : { allowedCpus }),
    ...(process.env.BENCH_ENVIRONMENT_NOTE ? { note: process.env.BENCH_ENVIRONMENT_NOTE } : {}),
  };
}

function sourceMetadata() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: SOURCE,
    encoding: 'utf8',
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: SOURCE, encoding: 'utf8' });
  const files = [
    '../gitnexus-shared/src/scope-resolution/position-index.ts',
    '../gitnexus-shared/src/scope-resolution/name-claims.ts',
    'src/core/ingestion/route-extractors/fetch-wrapper.ts',
    'src/core/ingestion/route-extractors/fetch-wrapper-index.ts',
    'src/core/ingestion/route-extractors/framework-route-facts.ts',
    'src/core/ingestion/route-extractors/lexical-bindings.ts',
    'src/core/ingestion/pipeline-phases/routes.ts',
  ];
  return {
    revision,
    dirty: status.trim().length > 0,
    measuredSourceHashes: Object.fromEntries(
      files
        .filter((file) => existsSync(join(SOURCE, file)))
        .map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(SOURCE, file)))
            .digest('hex'),
        ]),
    ),
  };
}

function sample(run, verify, prepare = () => undefined) {
  const initial = run(prepare());
  verify(initial);
  if (verifyOnly) return { last: initial };
  let last;
  const iteration = (invocations) => {
    const wallStart = performance.now();
    let workMs = 0;
    for (let i = 0; i < invocations; i++) {
      // Setup is deliberately outside each operation's timing window. Each run
      // still creates a fresh index/context; batching never reuses that state.
      const input = prepare();
      const start = performance.now();
      last = run(input);
      workMs += performance.now() - start;
    }
    return { invocations, workMs, wallMs: performance.now() - wallStart };
  };
  const pilotIterations = [];
  let invocations = 1;
  let confirmations = 0;
  for (let i = 0; i < SETTINGS.maxPilotIterations; i++) {
    const pilot = iteration(invocations);
    const qualified = pilot.workMs >= SETTINGS.targetIterationMs;
    pilotIterations.push({ ...pilot, qualified });
    if (qualified) {
      confirmations++;
      if (confirmations === SETTINGS.pilotConfirmationBatches) break;
    } else {
      confirmations = 0;
      if (invocations >= SETTINGS.maxInvocationsPerIteration) break;
      invocations *= 2;
    }
  }
  if (confirmations !== SETTINGS.pilotConfirmationBatches) {
    throw Object.assign(new Error('Duration calibration exhausted its bounded pilot budget'), {
      targetIterationMs: SETTINGS.targetIterationMs,
      pilotIterations,
    });
  }
  // The pilot chooses the count once. Warmup and measured iterations retain the
  // same count, and every measurement is kept; there is no retry-until-pass path.
  const warmupIterations = Array.from({ length: SETTINGS.warmup }, () => iteration(invocations));
  const measuredIterations = Array.from({ length: SETTINGS.repetitions }, () =>
    iteration(invocations),
  );
  const samples = measuredIterations.map(({ workMs }) => workMs / invocations);
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const deviation = Math.sqrt(
    samples.reduce((sum, ms) => sum + (ms - mean) ** 2, 0) / (samples.length - 1),
  );
  verify(last);
  return {
    last,
    timing: {
      invocationsPerIteration: invocations,
      pilotIterations,
      warmupIterations,
      measuredIterations,
      minMs: sorted[0],
      meanMs: mean,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      standardDeviationMs: deviation,
      samplesMs: samples,
    },
  };
}

function wrapperSource(shape, units) {
  const lines = [];
  if (shape === 'wrapper-aliases') {
    for (let i = 0; i < units; i++) {
      lines.push(`function wrapper${i}(url) { const send = globalThis.fetch; return send(url); }`);
      lines.push(`wrapper${i}('/route-${i}');`);
    }
  } else if (shape === 'nested-helper-chain') {
    lines.push('function outer(url) {');
    for (let i = 0; i < units; i++) lines.push(`function helper${i}() {`);
    lines.push('return fetch(url);');
    for (let i = units - 1; i >= 0; i--) lines.push('}', `helper${i}();`);
    lines.push('}', "outer('/nested');");
  } else {
    lines.push('function outer(url) {');
    for (let i = 0; i < units; i++) lines.push(`function helper${i}() { return fetch(url); }`);
    for (let i = 0; i < units; i++) lines.push(`helper${i}();`);
    lines.push('}', "outer('/nested');");
  }
  return lines.join('\n');
}

function closureWorkload(shape, units) {
  const defs = [];
  const calls = [];
  const expected = [];
  const addDefinition = (name, filePath, seed, target) => {
    const bindingId = `${filePath}\0${name}`;
    const def = {
      filePath,
      functionName: name,
      definitionId: `definition:${bindingId}`,
      bindingId,
      moduleScope: true,
      exportedNames: [name],
      seed,
      forwardsUrl: seed,
      forwardsTo: target
        ? [{ callee: target.name, target: { kind: 'binding', bindingId: target.bindingId } }]
        : [],
    };
    defs.push(def);
    return def;
  };
  const addCall = (def, matches) => {
    calls.push({
      filePath: def.filePath,
      functionName: def.functionName,
      target: { kind: 'binding', bindingId: def.bindingId },
    });
    expected.push(matches);
  };
  if (shape === 'reverse-chain') {
    // The seed comes last: a repeated forward scan grows by only one node per
    // pass. A reverse-dependency queue touches each edge once.
    for (let i = 0; i < units; i++) {
      const next =
        i + 1 < units
          ? { name: `wrapper${i + 1}`, bindingId: `${FILE}\0wrapper${i + 1}` }
          : undefined;
      const def = addDefinition(`wrapper${i}`, FILE, !next, next);
      addCall(def, true);
    }
  } else {
    for (let i = 0; i < units; i++) {
      const def = addDefinition('request', `modules/module${i}.ts`, i % 2 === 0);
      addCall(def, i % 2 === 0);
    }
    calls.push({ filePath: FILE, functionName: 'request', target: { kind: 'unresolved' } });
    expected.push(false);
    // A distinct positive control guards against a classifier that rejects all
    // names merely because the workload contains ambiguous declarations.
    addCall(addDefinition('uniqueRequest', FILE, true), true);
  }
  const byBinding = new Map(defs.map((def) => [def.bindingId, def]));
  const legacyDefs = defs.map((def) => ({
    ...def,
    forwardsTo: def.forwardsTo.map(({ callee, target }) => ({
      callee,
      module: moduleStem(byBinding.get(target.bindingId).filePath),
    })),
  }));
  const legacyCalls = calls.map((call) => ({
    ...call,
    ...(call.target.kind === 'binding'
      ? { module: moduleStem(byBinding.get(call.target.bindingId).filePath) }
      : {}),
  }));
  const legacyExpected = [...expected];
  if (shape === 'name-collisions') legacyExpected[units] = true;
  return { defs, calls, expected, legacyDefs, legacyCalls, legacyExpected };
}

function frameworkSource(shape, units) {
  const lines = ["import express from 'express';", 'function handler() {}'];
  if (shape === 'completed-scopes') {
    lines.push('const app = express(); const alias = app;');
    for (let i = 0; i < units; i++) lines.push(`function done${i}(value) { return value; }`);
    for (let i = 0; i < units; i++) lines.push(`alias.get('/route-${i}', handler);`);
  } else {
    for (let i = 0; i < units; i++) {
      lines.push(
        `function setup${i}() { const app = express(); const alias = app; alias.get('/route-${i}', handler); }`,
      );
    }
  }
  return lines.join('\n');
}

function ratios(rows) {
  const small = rows[0];
  return rows.slice(1).map((large) => ({
    fromUnits: small.units,
    toUnits: large.units,
    minLinearFactor: large.timing.minMs / small.timing.minMs / (large.units / small.units),
    medianLinearFactor: large.timing.medianMs / small.timing.medianMs / (large.units / small.units),
  }));
}

async function main() {
  assert.equal(SETTINGS.protocol, 'duration-calibrated-v2');
  assert.equal(SETTINGS.targetIterationMs, 500);
  assert.equal(SETTINGS.pilotConfirmationBatches, 3);
  assert.equal(SETTINGS.warmup, 5);
  assert.equal(SETTINGS.repetitions, 15);
  assert.ok(Number.isSafeInteger(SETTINGS.maxPilotIterations) && SETTINGS.maxPilotIterations >= 3);
  assert.ok(
    Number.isSafeInteger(SETTINGS.maxInvocationsPerIteration) &&
      SETTINGS.maxInvocationsPerIteration > 0 &&
      Number.isInteger(Math.log2(SETTINGS.maxInvocationsPerIteration)),
  );
  assert.ok(SETTINGS.sizes.length >= 3 && SETTINGS.sizes[2] / SETTINGS.sizes[0] >= 4);
  assert.equal(SETTINGS.linearScalingBudget, 1.8, 'keep the predeclared scaling ceiling');
  const [
    { default: Parser },
    { default: TypeScript },
    { typescriptProvider },
    { extractParsedFile },
    { extractFrameworkRouteFacts },
    { resolveFrameworkRouteFacts },
    { buildPositionIndex },
    wrappers,
  ] = await Promise.all([
    import('tree-sitter'),
    import('tree-sitter-typescript'),
    load('core/ingestion/languages/typescript.ts'),
    load('core/ingestion/scope-extractor-bridge.ts'),
    load('core/ingestion/route-extractors/framework-route-facts.ts'),
    load('core/ingestion/route-extractors/framework-route-resolver.ts'),
    import(
      pathToFileURL(join(SOURCE, '../gitnexus-shared/src/scope-resolution/position-index.ts')).href
    ),
    load('core/ingestion/route-extractors/fetch-wrapper.ts'),
  ]);
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const arms = {};
  for (const shape of ['position-index', 'position-deep-completed']) {
    if (selected && selected !== shape) continue;
    arms[shape] = SETTINGS.lookupSizes.map((units) => {
      const deep = shape === 'position-deep-completed';
      const queryStart = deep ? units * 2 + 2 : units + 2;
      const scopes = [
        {
          id: 'root',
          filePath: FILE,
          range: { startLine: 1, startCol: 0, endLine: queryStart + units + 1, endCol: 0 },
        },
      ];
      for (let i = 0; i < units; i++) {
        scopes.push({
          id: `scope-${i}`,
          filePath: FILE,
          range: {
            startLine: i + 2,
            startCol: 0,
            endLine: deep ? units * 2 - i + 1 : i + 2,
            endCol: 10,
          },
        });
      }
      const { last, timing } = sample(
        () => {
          const index = buildPositionIndex(scopes);
          return Array.from({ length: units }, (_, i) => index.atPosition(FILE, queryStart + i, 0));
        },
        (result) =>
          assert.deepEqual(
            result,
            Array(units).fill('root'),
            `${shape}: completed scopes must resolve to the outer scope`,
          ),
      );
      return {
        units,
        scopes: scopes.length,
        outerReads: last.length,
        fingerprint: hash(last),
        ...(timing ? { timing } : {}),
      };
    });
  }
  for (const shape of ['spread-aliases', 'completed-scopes']) {
    if (selected && selected !== shape) continue;
    arms[shape] = SETTINGS.sizes.map((units) => {
      const text = frameworkSource(shape, units);
      const tree = parser.parse(text, null, { bufferSize: Buffer.byteLength(text) + 1 });
      assert.equal(tree.rootNode.hasError, false, `${shape}: invalid benchmark source`);
      const parsed = extractParsedFile(typescriptProvider, text, FILE, undefined, tree);
      assert.ok(parsed, `${shape}: missing parsed file`);
      // Parsing/model construction is setup. The extractor builds fresh scope,
      // position and binding indexes on every timed invocation.
      const expected = Array.from({ length: units }, (_, i) => `GET /route-${i}`).sort();
      const verify = (facts) => {
        const resolved = resolveFrameworkRouteFacts([facts], () => []);
        const identities = resolved.registrations.map(
          ({ route }) => `${route.httpMethod} ${route.routePath}`,
        );
        assert.deepEqual(identities.sort(), expected, `${shape}: exact route identities changed`);
        assert.ok(facts.calls.length >= units, `${shape}: missing positive call evidence`);
      };
      const { last, timing } = sample(() => extractFrameworkRouteFacts(tree, parsed), verify);
      const resolved = resolveFrameworkRouteFacts([last], () => []);
      const identities = resolved.registrations.map(
        ({ route }) => `${route.httpMethod} ${route.routePath}`,
      );
      return {
        units,
        bytes: Buffer.byteLength(text),
        routes: identities.length,
        calls: last.calls.length,
        fingerprint: hash(identities),
        ...(timing ? { timing } : {}),
      };
    });
  }
  const contextAvailable = typeof wrappers.createFetchWrapperContext === 'function';
  for (const shape of ['wrapper-aliases', 'nested-helpers', 'nested-helper-chain']) {
    if (selected && selected !== shape) continue;
    const sizes = shape === 'nested-helper-chain' ? SETTINGS.deepHelperSizes : SETTINGS.sizes;
    arms[shape] = sizes.map((units) => {
      const text = wrapperSource(shape, units);
      const prepare = () => {
        const tree = parser.parse(text, null, { bufferSize: Buffer.byteLength(text) + 1 });
        assert.equal(tree.rootNode.hasError, false, `${shape}: invalid benchmark source`);
        const parsed = extractParsedFile(typescriptProvider, text, FILE, undefined, tree);
        assert.ok(parsed, `${shape}: missing parsed file`);
        return {
          tree,
          parsed,
          definitions: tree.rootNode.descendantsOfType('function_declaration'),
        };
      };
      const project = ({ facts, calls, definitions }) => ({
        facts: facts
          .map(
            (fact, i) =>
              `${definitions[i].childForFieldName('name').text}:${fact.seed}:${fact.forwardsUrl}`,
          )
          .sort(),
        calls: calls.map((call) => `${call.functionName}:${call.fetchURL}`).sort(),
      });
      const expected = {
        facts:
          shape === 'wrapper-aliases'
            ? Array.from({ length: units }, (_, i) => `wrapper${i}:true:true`).sort()
            : [
                'outer:true:true',
                ...Array.from({ length: units }, (_, i) => `helper${i}:true:false`),
              ].sort(),
        calls:
          shape === 'wrapper-aliases'
            ? Array.from({ length: units }, (_, i) => `wrapper${i}:/route-${i}`).sort()
            : ['outer:/nested'],
      };
      const run = contextAvailable
        ? ({ tree, parsed, definitions }) => {
            const context = wrappers.createFetchWrapperContext(tree, parsed);
            return {
              definitions,
              facts: definitions.map((definition) =>
                context.facts(definition, definition.childForFieldName('name')),
              ),
              calls: context.calls(),
            };
          }
        : ({ tree, definitions }) => ({
            definitions,
            facts: definitions.map((definition) => wrappers.fetchWrapperFacts(definition, FILE)),
            calls: wrappers.extractFetchWrapperCalls(tree, FILE, 0),
          });
      // A fresh AST per invocation prevents the baseline's module WeakMap cache
      // from turning this into a warm-index comparison. Parsing/capture setup
      // is excluded in both arms; context creation is included.
      const { last, timing } = sample(
        run,
        (result) =>
          assert.deepEqual(project(result), expected, `${shape}: wrapper evidence changed`),
        prepare,
      );
      const identities = project(last);
      return {
        units,
        bytes: Buffer.byteLength(text),
        definitions: last.facts.length,
        seeds: last.facts.filter((fact) => fact.seed).length,
        carriers: last.facts.filter((fact) => fact.forwardsUrl).length,
        calls: last.calls.length,
        fingerprint: hash([...identities.facts, ...identities.calls]),
        ...(timing ? { timing } : {}),
      };
    });
  }
  const classifierPath = 'core/ingestion/route-extractors/fetch-wrapper-index.ts';
  const classifierAvailable = existsSync(join(SOURCE, 'src', classifierPath));
  let classifier;
  if (!selected || ['reverse-chain', 'name-collisions'].includes(selected)) {
    classifier = classifierAvailable
      ? (await load(classifierPath)).buildFetchWrapperIndex
      : loadBaselineClosure(SOURCE);
    assert.equal(typeof classifier, 'function', 'missing wrapper classifier');
  }
  for (const shape of ['reverse-chain', 'name-collisions']) {
    if (selected && selected !== shape) continue;
    arms[shape] = SETTINGS.closureSizes.map((units) => {
      const workload = closureWorkload(shape, units);
      const defs = classifierAvailable ? workload.defs : workload.legacyDefs;
      const calls = classifierAvailable ? workload.calls : workload.legacyCalls;
      const expected = classifierAvailable ? workload.expected : workload.legacyExpected;
      const { last, timing } = sample(
        () => {
          const index = classifier(defs, []);
          return calls.map((call) => index.isWrapperCall(call));
        },
        (result) => assert.deepEqual(result, expected, `${shape}: exact wrapper decisions changed`),
      );
      const divergences = last.flatMap((matches, i) =>
        matches === workload.expected[i]
          ? []
          : [
              {
                index: i,
                functionName: calls[i].functionName,
                expected: workload.expected[i],
                actual: matches,
              },
            ],
      );
      return {
        units,
        definitions: defs.length,
        calls: calls.length,
        matched: last.filter(Boolean).length,
        rejected: last.filter((matched) => !matched).length,
        fingerprint: hash(last.map((matches, i) => `${i}:${matches}`)),
        semanticStatus: divergences.length ? 'known-baseline-failure' : 'correct',
        divergences,
        ...(timing ? { timing } : {}),
      };
    });
  }
  assert.ok(Object.keys(arms).length > 0, `unknown benchmark arm: ${selected}`);
  const scaling = verifyOnly
    ? undefined
    : Object.fromEntries(Object.entries(arms).map(([name, rows]) => [name, ratios(rows)]));
  const output = {
    source: sourceMetadata(),
    harnessFingerprint: hash(
      ['measure.cjs', 'baseline-closure.cjs', 'baseline.json'].map((file) =>
        readFileSync(join(__dirname, file), 'utf8'),
      ),
    ),
    environment: environmentMetadata(),
    settings: SETTINGS,
    adapters: {
      extraction: contextAvailable ? 'fresh-provider-context' : 'baseline-per-definition',
      classification: classifierAvailable ? 'production-index' : 'pinned-baseline-closure',
    },
    arms,
    ...(scaling ? { scaling } : {}),
  };
  const outputIndex = args.indexOf('--output');
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], text);
  else process.stdout.write(text);
  if (check && scaling) {
    for (const [arm, rows] of Object.entries(arms)) {
      assert.ok(
        rows.every((row) => !row.divergences?.length),
        `${arm}: known baseline semantic failure is not a passing candidate`,
      );
    }
    for (const [arm, comparisons] of Object.entries(scaling)) {
      for (const comparison of comparisons) {
        for (const metric of ['minLinearFactor', 'medianLinearFactor']) {
          assert.ok(
            comparison[metric] <= SETTINGS.linearScalingBudget,
            `${arm} ${comparison.fromUnits}->${comparison.toUnits} ` +
              `${metric}=${comparison[metric].toFixed(3)} exceeds ${SETTINGS.linearScalingBudget}`,
          );
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
