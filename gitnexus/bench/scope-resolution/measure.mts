/** Real worker parsing + scope resolution, in a fresh process per sample. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { SupportedLanguages } from 'gitnexus-shared';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { processCobol } from '../../src/core/ingestion/cobol-processor.js';
import { processPlSql } from '../../src/core/ingestion/plsql-processor.js';
import { loadPlSqlParser } from '../../src/core/ingestion/plsql/facts-store.js';
import { generateId } from '../../src/lib/utils.js';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.js';
import { corpus, generators } from './corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, 'baselines.json');
const MARKER = 'SCOPE_BENCH_RESULT ';
const digest = (rows: string[]) =>
  createHash('sha256').update(rows.sort().join('\n')).digest('hex');

async function sample(language: SupportedLanguages, count: number, methods: number) {
  const { files, config } = corpus(language, count, methods);
  const dir = mkdtempSync(join(tmpdir(), 'gitnexus-scope-bench-'));
  try {
    for (const file of [...files, ...config]) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.content);
    }
    const resolver = SCOPE_RESOLVERS.get(language);
    assert.ok(resolver, `No scope resolver registered for ${language}`);
    const resolutionConfig = await resolver.loadResolutionConfig?.(dir);
    const parseStarted = performance.now();
    const { graph, model, data } = await parseFilesWithWorkers(files, { poolSize: 1 });
    // The normal pipeline creates these during structure processing, before
    // either parser runs. The worker helper only supplies symbol nodes.
    for (const file of files) {
      graph.addNode({
        id: generateId('File', file.path),
        label: 'File',
        properties: { name: basename(file.path), filePath: file.path },
      });
    }
    // COBOL's structural graph is emitted by its standalone production parser.
    if (language === SupportedLanguages.Cobol) {
      processCobol(graph, files, new Set(files.map((file) => file.path)));
    }
    // PL/SQL's structural graph is emitted by its standalone ANTLR parser, loaded on demand.
    if (language === SupportedLanguages.PlSql) {
      await loadPlSqlParser();
      processPlSql(graph, files, new Set(files.map((file) => file.path)));
    }
    const parseMs = performance.now() - parseStarted;
    const heapAfterParse = process.memoryUsage().heapUsed;
    let parsedFileCount = 0;
    let moduleTypeBindings = 0;
    let typeBindings = 0;
    const resolveStarted = performance.now();
    runScopeResolution(
      {
        graph,
        model,
        files,
        resolutionConfig,
        preExtractedParsedFiles: new Map(data.parsedFiles.map((file) => [file.filePath, file])),
        onResolved: ({ parsedFiles }) => {
          parsedFileCount = parsedFiles.length;
          for (const file of parsedFiles) {
            for (const scope of file.scopes) {
              typeBindings += scope.typeBindings.size;
              if (scope.id === file.moduleScope) moduleTypeBindings += scope.typeBindings.size;
            }
          }
        },
      },
      resolver,
    );
    const resolveMs = performance.now() - resolveStarted;
    const heapAfterResolve = process.memoryUsage().heapUsed;
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;
    assert.equal(parsedFileCount, files.length, `${language}: scope extraction omitted files`);
    assert.ok(graph.nodeCount > files.length, `${language}: no declarations parsed`);
    let calls = 0;
    let crossFileCalls = 0;
    const edges: string[] = [];
    for (const edge of graph.iterRelationships()) {
      edges.push(
        JSON.stringify([edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.reason]),
      );
      if (edge.type !== 'CALLS') continue;
      calls++;
      const source = graph.getNode(edge.sourceId);
      const target = graph.getNode(edge.targetId);
      if (
        source !== undefined &&
        target !== undefined &&
        source.properties.filePath !== target.properties.filePath
      )
        crossFileCalls++;
    }
    assert.ok(crossFileCalls > 0, `${language}: cross-file workload resolved no calls`);
    const nodes = [...graph.iterNodes()].map((node) =>
      JSON.stringify([node.id, node.label, node.properties.name, node.properties.filePath]),
    );
    return {
      language,
      entities: count,
      files: files.length,
      methodsPerEntity: methods,
      parseMs,
      resolveMs,
      heapAfterParse,
      heapAfterResolve,
      peakRssBytes,
      moduleTypeBindings,
      typeBindings,
      nodes: graph.nodeCount,
      edges: graph.relationshipCount,
      calls,
      crossFileCalls,
      fingerprint: digest([...nodes, ...edges]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--worker') {
  const result = await sample(args[1] as SupportedLanguages, Number(args[2]), Number(args[3]));
  console.log(MARKER + JSON.stringify(result));
} else {
  const value = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? fallback : args[index + 1];
  };
  const languages = Object.values(SupportedLanguages).sort();
  assert.deepEqual(Object.keys(generators).sort(), languages, 'Missing benchmark language');
  assert.deepEqual([...SCOPE_RESOLVERS.keys()].sort(), languages, 'Resolver inventory changed');
  const selected = value('--language', 'all');
  assert.ok(
    selected === 'all' || languages.includes(selected as SupportedLanguages),
    'Unknown language',
  );
  const sizes = value('--sizes', '100,1000').split(',').map(Number);
  const repetitions = Number(value('--repetitions', '3'));
  const methods = Number(value('--methods', '20'));
  assert.ok(
    [...sizes, repetitions, methods].every((n) => Number.isSafeInteger(n) && n >= 2),
    'Sizes, repetitions and methods must be integers >= 2',
  );
  const check = args.includes('--check');
  const record = args.includes('--record');
  assert.ok(!(check && record), '--check cannot record new baselines');
  if (record) assert.equal(selected, 'all', '--record requires all languages');
  const baselines = check ? JSON.parse(readFileSync(BASELINES, 'utf8')) : {};
  const results: Awaited<ReturnType<typeof sample>>[] = [];
  const trials: Awaited<ReturnType<typeof sample>>[] = [];
  const failures: string[] = [];
  const records: Record<
    string,
    {
      fingerprint: string;
      nodes: number;
      edges: number;
      crossFileCalls: number;
      moduleTypeBindings: number;
      typeBindings: number;
    }
  > = {};
  for (const language of languages.filter((lang) => selected === 'all' || lang === selected)) {
    for (const count of sizes) {
      const samples: Awaited<ReturnType<typeof sample>>[] = [];
      for (let trial = 0; trial < repetitions; trial++) {
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(import.meta.url),
            '--worker',
            language,
            String(count),
            String(methods),
          ],
          {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GITNEXUS_LOG_LEVEL: 'error' },
          },
        );
        const line = child.stdout?.split('\n').find((line) => line.startsWith(MARKER));
        if (child.status !== 0 || !line) {
          const failure = `${language}/${count}: ${child.error?.message || child.stderr || child.signal || `exit ${child.status}`}`;
          failures.push(failure);
          console.error(failure);
          break;
        }
        samples.push(JSON.parse(line.slice(MARKER.length)));
      }
      trials.push(...samples);
      if (samples.length !== repetitions) continue;
      if (new Set(samples.map((item) => item.fingerprint)).size !== 1)
        failures.push(`${language}/${count}: nondeterministic graph`);
      for (const field of ['moduleTypeBindings', 'typeBindings'] as const) {
        if (new Set(samples.map((item) => item[field])).size !== 1)
          failures.push(`${language}/${count}: nondeterministic ${field}`);
      }
      const result = { ...samples[0] };
      for (const key of [
        'parseMs',
        'resolveMs',
        'heapAfterParse',
        'heapAfterResolve',
        'peakRssBytes',
      ] as const) {
        const values = samples.map((item) => item[key]).sort((a, b) => a - b);
        result[key] =
          (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
      }
      const key = `${language}/${count}/${methods}`;
      records[key] = {
        fingerprint: result.fingerprint,
        nodes: result.nodes,
        edges: result.edges,
        crossFileCalls: result.crossFileCalls,
        moduleTypeBindings: result.moduleTypeBindings,
        typeBindings: result.typeBindings,
      };
      if (check) {
        const baseline = baselines[key];
        if (
          !baseline ||
          (['fingerprint', 'nodes', 'edges', 'crossFileCalls'] as const).some(
            (field) => records[key][field] !== baseline[field],
          )
        )
          failures.push(`${key}: graph differs from committed baseline`);
        for (const field of ['moduleTypeBindings', 'typeBindings'] as const) {
          if (!Number.isSafeInteger(baseline?.[field]) || result[field] > baseline[field])
            failures.push(
              `${key}: ${field} exceeds measured baseline (${result[field]} > ${baseline?.[field]})`,
            );
        }
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const scaling = [...new Set(results.map((r) => r.language))].map((language) => {
    const rows = results.filter((r) => r.language === language).sort((a, b) => a.files - b.files);
    const small = rows[0];
    const large = rows[rows.length - 1];
    const fileRatio = large.files / small.files;
    return {
      language,
      fileRatio,
      normalizedResolveRatio: large.resolveMs / small.resolveMs / fileRatio,
      heapRatio: large.heapAfterResolve / small.heapAfterResolve,
      moduleBindingRatio:
        small.moduleTypeBindings === 0 ? null : large.moduleTypeBindings / small.moduleTypeBindings,
    };
  });
  const report = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    parsingWorkers: 1,
    repetitions,
    results,
    scaling,
    trials,
    failures,
  };
  const output = value('--output', '');
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const table = [
    '## Scope-resolution benchmark',
    '',
    'Medians from fresh processes. Heap is sampled after each phase; RSS is the process high-water mark through resolution. These are synthetic workloads.',
    '',
    '| Language | Files | Parse ms | Resolve ms | Heap after resolve MiB | Peak RSS MiB | Module type bindings | Cross-file calls |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(
      (r) =>
        `| ${r.language} | ${r.files} | ${r.parseMs.toFixed(1)} | ${r.resolveMs.toFixed(1)} | ${(r.heapAfterResolve / 2 ** 20).toFixed(1)} | ${(r.peakRssBytes / 2 ** 20).toFixed(1)} | ${r.moduleTypeBindings} | ${r.crossFileCalls} |`,
    ),
    '',
    ...failures.map((failure) => `- FAILED: ${failure}`),
    '',
  ].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  assert.equal(failures.length, 0, failures.join('\n'));
  if (record) writeFileSync(BASELINES, JSON.stringify(records, null, 2) + '\n');
}
