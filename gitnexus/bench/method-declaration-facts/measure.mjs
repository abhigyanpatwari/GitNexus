#!/usr/bin/env node
// Build both revisions, then pass --baseline-root /path/to/baseline/gitnexus.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const candidate = path.resolve(path.dirname(here), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = path.resolve(option('--root', candidate));
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v,
  );

const providerFixtures = {
  'J.java':
    'record J(int value) { int f(int x) { return x; } String f(String x) { return x; } int call() { return f(1); } int fromValue() { return f(value); } }',
  'T.ts':
    'export class T { f(x: number): number; f(x: string): string; f(x: number | string) { return x; } call() { return this.f(1); } }',
  'K.kt':
    'class K(val value: Int) {\n fun f(x: Int): Int { return x }\n fun call(): Int { return f(value) }\n companion object { fun build(): K { return K(1) } }\n}',
  'C.cs':
    'public class C(int value) { public int f(int x) => x; public string f(string x) => x; public int Call() => f(1); public int FromValue() => f(value); }',
  'P.py':
    'class P:\n @staticmethod\n def f(x: int) -> int:\n  return x\n def call(self) -> int:\n  return P.f(1)\n',
  'Ph.php':
    '<?php class Ph { function f(int $x, string ...$rest): int { return $x; } function call(): int { return $this->f(1, "a"); } }',
  'S.swift':
    'class S { init() {}\n func f(_ x: Int, y: String = "") -> Int { return x }\n func call() -> Int { return f(1) }\n}',
  'D.dart':
    "class D { D(int value) {} int f(int x, [String y = '']) => x; int call() => f(1); int get value => 1; }",
};

async function countFacts() {
  const require = createRequire(path.join(root, 'package.json'));
  const Parser = require('tree-sitter');
  const { getLanguageGrammar } = await load('core/tree-sitter/parser-loader.js');
  const { createMethodExtractor } = await load('core/ingestion/method-extractors/generic.js');
  const specs = [
    [
      'java',
      'jvm',
      'java',
      'method_declaration',
      'class C { int f(int x, String y) { return x; } }',
    ],
    [
      'typescript',
      'typescript-javascript',
      'typescript',
      'method_definition',
      'class C { f(x: number, y: string): number { return x; } }',
    ],
    [
      'kotlin',
      'jvm',
      'kotlin',
      'function_declaration',
      'class C {\n fun f(x: Int, y: String): Int { return x }\n}',
    ],
    [
      'csharp',
      'csharp',
      'csharp',
      'method_declaration',
      'class C { int f(int x, string y) { return x; } }',
    ],
    [
      'python',
      'python',
      'python',
      'function_definition',
      'class C:\n def f(self, x: int, y: str) -> int:\n  return x\n',
    ],
    [
      'php',
      'php',
      'php',
      'method_declaration',
      '<?php class C { function f(int $x, string $y): int { return $x; } }',
    ],
    [
      'swift',
      'swift',
      'swift',
      'function_declaration',
      'class C { func f(_ x: Int, y: String) -> Int { return x } }',
    ],
    [
      'dart',
      'dart',
      'dart',
      'method_signature',
      'class C { int f(int x, String y) { return x; } }',
    ],
  ];
  const result = [];
  for (const [language, module, prefix, nodeType, source] of specs) {
    const grammar = getLanguageGrammar(language);
    if (!grammar) {
      result.push({ language, skipped: 'grammar unavailable' });
      continue;
    }
    const config = (await load(`core/ingestion/method-extractors/configs/${module}.js`))[
      `${prefix}MethodConfig`
    ];
    const arityModule = await load(`core/ingestion/languages/${language}/arity-metadata.js`);
    const arity = Object.values(arityModule).find((value) => typeof value === 'function');
    const parser = new Parser();
    parser.setLanguage(grammar);
    const node = parser.parse(source).rootNode.descendantsOfType(nodeType)[0];
    let nativeReads = 0;
    const counted = new Proxy(node, {
      get(target, property) {
        if (property !== 'tree' && property !== 'id') nativeReads++;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const parameterResults = new Set();
    const original = config.extractParameters;
    config.extractParameters = (...values) => {
      const parameters = original(...values);
      parameterResults.add(parameters);
      return parameters;
    };
    try {
      const scope = arity(counted);
      const method = createMethodExtractor(config).extractFromNode(counted, {
        language,
        filePath: 'fixture',
      });
      result.push({
        language,
        nativeReads,
        parameterArrays: parameterResults.size,
        facts: digest(stable({ scope, method })),
      });
    } finally {
      config.extractParameters = original;
    }
    const timingSource =
      language === 'php'
        ? '<?php\n' + source.replace('<?php', '').repeat(1000)
        : (source + '\n').repeat(1000);
    const timings = [];
    for (let trial = 0; trial < 9; trial++) {
      global.gc();
      const tree = parser.parse(timingSource);
      const declarations = tree.rootNode.descendantsOfType(nodeType);
      assert.equal(declarations.length, 1000);
      let checksum = 0;
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (const declaration of declarations) {
        checksum += original(declaration).length;
        checksum += original(declaration).length;
      }
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      timings.push({
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        declarations: declarations.length,
        checksum,
      });
    }
    result.at(-1).parameterTimings = timings;
  }
  return result;
}

async function retainedTrees() {
  const Parser = createRequire(path.join(root, 'package.json'))('tree-sitter');
  const { getLanguageGrammar } = await load('core/tree-sitter/parser-loader.js');
  const { javaMethodConfig } = await load('core/ingestion/method-extractors/configs/jvm.js');
  const refs = (() => {
    const parser = new Parser();
    parser.setLanguage(getLanguageGrammar('java'));
    return Array.from({ length: 100 }, () => {
      const tree = parser.parse('class C { int f(int x) { return x; } }');
      const node = tree.rootNode.descendantsOfType('method_declaration')[0];
      javaMethodConfig.extractParameters(node);
      javaMethodConfig.extractParameters(node);
      return new WeakRef(tree);
    });
  })();
  // WeakRef targets survive the current job; collect only after yielding it.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  return {
    created: refs.length,
    collected: refs.filter((ref) => ref.deref() === undefined).length,
    heapAfterGcMiB: process.memoryUsage().heapUsed / 1048576,
  };
}

async function makeCorpus(repo, corpus) {
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
  if (corpus === 'providers') {
    for (const [file, source] of Object.entries(providerFixtures)) {
      await writeFile(path.join(repo, file), source + '\n');
    }
  } else if (corpus === 'declarations') {
    for (let file = 0; file < 32; file++) {
      const ts = Array.from(
        { length: 40 },
        (_, i) => `m${i}(a: number, b: string, c: Array<string>, d = 0): number { return a + d; }`,
      ).join('\n');
      const java = Array.from(
        { length: 40 },
        (_, i) => `int m${i}(int a, String b, List<String> c, int d) { return a + d; }`,
      ).join('\n');
      await writeFile(
        path.join(repo, `T${file}.ts`),
        `export class T${file} {\n${ts}\n call() { return this.m0(1, "", [], 0); }\n}\n`,
      );
      await writeFile(
        path.join(repo, `J${file}.java`),
        `class J${file} {\n${java}\n int call() { return m0(1, "", null, 0); }\n}\n`,
      );
    }
  } else {
    // The same tracked source snapshot feeds both revisions.
    const paths = execFileSync(
      'git',
      [
        'ls-files',
        'src/core/ingestion/method-extractors',
        'src/core/ingestion/languages',
        'test/fixtures/lang-resolution',
      ],
      { cwd: candidate, encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    const sources = paths
      .filter((p) => p.startsWith('src/') && /\.ts$/.test(p))
      .sort()
      .slice(0, 96);
    const fixtures = paths.filter((p) =>
      /(?:same-arity|primary-constructor|record-component|variadic)/.test(p),
    );
    for (const file of [...sources, ...fixtures]) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await cp(path.join(candidate, file), path.join(repo, file));
    }
  }
  await writeFile(
    path.join(repo, 'change.ts'),
    'export class Changed { method(value: number): number { return value; } }\n',
  );
  const git = (...values) => execFileSync('git', values, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git(
    '-c',
    'user.name=benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  const files = git('ls-files').toString().trim().split('\n');
  const contents = await Promise.all(
    files.map(async (f) => [f, digest(await readFile(path.join(repo, f)))]),
  );
  return { files: files.length - 1, manifest: digest(stable(contents)) };
}

function graphFacts(graph) {
  const nodes = [];
  graph.forEachNode((node) => {
    if (!['Community', 'Process'].includes(node.label)) nodes.push(stable(node));
  });
  const edges = [...graph.relationships]
    .filter((edge) => !['MEMBER_OF', 'STEP_IN_PROCESS'].includes(edge.type))
    .map(stable);
  return {
    nodes: nodes.length,
    edges: edges.length,
    hash: digest(stable([nodes.sort(), edges.sort()])),
  };
}

async function measureAnalysis(corpus) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-callable-facts-'));
  Object.assign(process.env, {
    GITNEXUS_HOME: path.join(temp, 'home'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_LBUG_BUFFER_POOL_SIZE: '134217728',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    GITNEXUS_MEMORY: 'off',
  });
  const repo = path.join(temp, 'repo');
  try {
    const manifest = await makeCorpus(repo, corpus);
    const { runFullAnalysis } = await load('core/run-analyze.js');
    const runs = [];
    for (const scenario of ['cold', 'warm', 'changed']) {
      if (scenario === 'changed')
        await writeFile(
          path.join(repo, 'change.ts'),
          'export class Changed { method(value: string): string { return value; } }\n',
        );
      global.gc?.();
      let peakRss = process.memoryUsage().rss;
      let gcMs = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) gcMs += entry.duration;
      });
      observer.observe({ entryTypes: ['gc'] });
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 20);
      const phases = {};
      let previousPhase = 'startup',
        previousTime = performance.now();
      const onProgress = (phase) => {
        if (phase !== previousPhase) console.error(`${scenario}: ${phase}`);
        const now = performance.now();
        phases[previousPhase] = (phases[previousPhase] ?? 0) + now - previousTime;
        previousPhase = phase;
        previousTime = now;
      };
      const cpu = process.cpuUsage(),
        start = performance.now();
      let analysis;
      try {
        analysis = await runFullAnalysis(
          repo,
          {
            force: true,
            skipAgentsMd: true,
            skipSkills: true,
            skipFts: true,
            streamGraphEmit: false,
            workerPoolSize: 1,
          },
          { onProgress, onLog: (message) => console.error(message) },
        );
      } finally {
        clearInterval(sampler);
      }
      const wallMs = performance.now() - start,
        used = process.cpuUsage(cpu);
      onProgress('done');
      await new Promise((resolve) => setImmediate(resolve));
      observer.disconnect();
      const pipeline = analysis.pipelineResult;
      assert(pipeline, 'analysis must return its graph');
      if (scenario !== 'warm')
        assert(pipeline.usedWorkerPool, 'cache misses must use real parser workers');
      if (scenario === 'warm') assert.equal(pipeline.reparsedFileCount, 0);
      if (scenario === 'changed') assert(pipeline.reparsedFileCount > 0);
      if (corpus === 'providers') {
        if (scenario === 'cold') {
          assert.equal(pipeline.reparsedFileCount, Object.keys(providerFixtures).length + 1);
        }
        const methods = new Set();
        pipeline.graph.forEachNode((node) => {
          if (['Method', 'Function'].includes(node.label) && node.properties.name === 'f') {
            methods.add(node.properties.filePath);
          }
        });
        assert.deepEqual([...methods].sort(), Object.keys(providerFixtures).sort());
        const calledFiles = new Set();
        for (const edge of pipeline.graph.iterRelationshipsByType('CALLS')) {
          const target = pipeline.graph.getNode(edge.targetId);
          if (target?.properties.name === 'f') calledFiles.add(target.properties.filePath);
        }
        assert.deepEqual([...calledFiles].sort(), Object.keys(providerFixtures).sort());
      }
      const facts = graphFacts(pipeline.graph);
      if (scenario === 'warm')
        assert.equal(facts.hash, runs[0].facts.hash, 'warm replay changed graph facts');
      if (scenario === 'changed')
        assert.notEqual(facts.hash, runs[0].facts.hash, 'edited signature retained stale facts');
      runs.push({
        scenario,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        phases,
        gcMs,
        sampledPeakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 1048576,
        cumulativeMaxRssMiB: process.resourceUsage().maxRSS / 1024,
        reparsed: pipeline.reparsedFileCount,
        hits: pipeline.parseCacheHitFileCount,
        facts,
      });
    }
    return { manifest, runs };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (args.includes('--child')) {
  const mode = option('--child');
  const result =
    mode === 'counts'
      ? await countFacts()
      : mode === 'lifetime'
        ? await retainedTrees()
        : await measureAnalysis(option('--corpus'));
  console.log('BENCH_RESULT=' + JSON.stringify(result));
} else {
  const baseline = option('--baseline-root');
  const candidateRuntime = path.resolve(option('--candidate-root', candidate));
  assert(baseline, 'Supply --baseline-root pointing at the built pre-change package');
  const samples = Number(option('--samples', '3'));
  assert(Number.isInteger(samples) && samples >= 3, '--samples must be at least 3');
  const child = (revision, mode, corpus) => {
    const output = execFileSync(
      process.execPath,
      ['--expose-gc', here, '--child', mode, '--root', revision, '--corpus', corpus ?? ''],
      {
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GITNEXUS_MEMORY: 'off' },
      },
    );
    const line = output.split('\n').find((line) => line.startsWith('BENCH_RESULT='));
    assert(line, 'child did not return measurements');
    return JSON.parse(line.slice('BENCH_RESULT='.length));
  };
  const results = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      cpu: os.cpus()[0]?.model,
      workers: 1,
    },
    counts: {},
    lifetime: {},
    samples: [],
  };
  for (const [name, revision] of [
    ['baseline', baseline],
    ['candidate', candidateRuntime],
  ]) {
    results.counts[name] = child(revision, 'counts');
    results.lifetime[name] = child(revision, 'lifetime');
  }
  assert.deepEqual(
    results.counts.baseline.map((r) => [r.language, r.facts]),
    results.counts.candidate.map((r) => [r.language, r.facts]),
  );
  for (const corpus of args.includes('--providers-only')
    ? ['providers']
    : ['declarations', 'repository']) {
    for (let sample = 0; sample < samples; sample++) {
      const pair = {};
      for (const name of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        console.log(`${corpus} pair ${sample + 1}/${samples}: ${name}`);
        pair[name] = child(name === 'baseline' ? baseline : candidateRuntime, 'analysis', corpus);
      }
      assert.deepEqual(pair.baseline.manifest, pair.candidate.manifest);
      assert.deepEqual(
        pair.baseline.runs.map((r) => r.facts),
        pair.candidate.runs.map((r) => r.facts),
        'before/after graph facts differ',
      );
      results.samples.push({ corpus, sample, ...pair });
      await writeFile(
        option('--output', '/tmp/method-declaration-facts.json'),
        JSON.stringify(results, null, 2) + '\n',
      );
    }
  }
}
