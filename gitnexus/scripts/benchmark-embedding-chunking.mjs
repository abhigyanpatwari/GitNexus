/** Paired chunk preparation, hashing and local-model inference benchmark.
 * Usage: node --expose-gc scripts/benchmark-embedding-chunking.mjs BASELINE_REPO CANDIDATE_REPO RESULT_JSON [--source]
 * Build both repositories first and use the same dependencies/model/hardware.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

const [baselineRoot, candidateRoot, output] = process.argv.slice(2);
const sourceMode = process.argv.includes('--source');
if (!baselineRoot || !candidateRoot || !output)
  throw new Error('Pass baseline repo, candidate repo and result JSON path');
async function load(root) {
  const base = `${root}/gitnexus/dist/core/embeddings/`;
  const modules = await Promise.all(
    [
      'chunker',
      'text-generator',
      'structural-extractor',
      'embedding-pipeline',
      'exact-search',
      'ast-utils',
    ].map((name) => import(pathToFileURL(`${base}${name}.js`).href)),
  );
  const sourceReader = `${base}source-reader.js`;
  if (existsSync(sourceReader)) modules.push(await import(pathToFileURL(sourceReader).href));
  return Object.assign({}, ...modules);
}
const baseline = await load(baselineRoot);
const candidate = await load(candidateRoot);
const embedder = await import(
  pathToFileURL(`${candidateRoot}/gitnexus/dist/core/embeddings/embedder.js`).href
);
await embedder.initEmbedder(undefined, { threads: 2, device: 'cpu' }, 'cpu');
const lines = (n, prefix = '  ') =>
  Array.from({ length: n }, (_, i) => `${prefix}const value${i} = compute(${i});`).join('\n');
const sources = {
  short: ['Function', 'function sample() { return 42; }'],
  flat: ['Function', `function sample() {\n${lines(100)}\n  return tailSentinel;\n}`],
  nested: [
    'Function',
    `function sample() {\n if (ready) {\n${lines(100, '    ')}\n } else {\n${lines(40, '    ')}\n }\n return tailSentinel;\n}`,
  ],
  large: ['Function', `function sample() {\n${lines(260)}\n  return tailSentinel;\n}`],
  medium: [
    'Function',
    `function sample() {\n${Array.from({ length: 30 }, (_, i) => ` consume(${i}, "${'x'.repeat(280)}");`).join('\n')}\n}`,
  ],
  class: [
    'Class',
    `class Sample {\n before: string;\n run() {\n${lines(100, '    ')}\n }\n after = 42;\n}`,
  ],
};
const nodes = Object.fromEntries(
  Object.entries(sources).map(([key, [label, content]]) => [
    key,
    {
      id: `${label}:sample.ts:sample`,
      label,
      name: 'sample',
      filePath: `${key}.ts`,
      content,
      startLine: 1,
      endLine: content.split('\n').length,
    },
  ]),
);
const fixtureRoot = sourceMode
  ? await mkdtemp(path.join(tmpdir(), 'gitnexus-chunk-bench-'))
  : undefined;
const fileHashes = new Map();
if (fixtureRoot) {
  for (const node of Object.values(nodes)) {
    const raw = `\n${node.content}`;
    await writeFile(path.join(fixtureRoot, node.filePath), raw);
    fileHashes.set(node.filePath, createHash('sha256').update(raw).digest('hex'));
    // Match ingestion's capped, normalized snippet; production rehydrates
    // eligible nodes from the verified original file before chunking.
    node.content = (
      node.content.length > 5000 ? `${node.content.slice(0, 5000)}\n... [truncated]` : node.content
    ).replace(/[\r\n\t]+/g, ' ');
  }
}
const sourceContext = { repoPath: fixtureRoot, fileHashes, contentRetention: 'full' };
async function prepare(api, original, reader) {
  const node = { ...original };
  if (reader && api.needsEmbeddingSource(node, {})) node.content = await reader.read(node);
  let options;
  if (node.label === 'Class') {
    if (api.EmbeddingSourceReader) {
      const tree = await api.ensureAndParse(node.content, node.filePath);
      Object.assign(node, await api.extractStructuralNames(node.content, node.filePath, tree));
      options = { tree };
    } else Object.assign(node, await api.extractStructuralNames(node.content, node.filePath));
  }
  const chunks = await api.chunkNode(
    node.label,
    node.content,
    node.filePath,
    node.startLine,
    node.endLine,
    1200,
    120,
    options,
  );
  if (chunks[0]?.classDeclaration !== undefined) node.classDeclaration = chunks[0].classDeclaration;
  let count = 0,
    chars = 0,
    tail = '';
  const texts = [];
  let previousEnd;
  for (const chunk of chunks) {
    for (const text of api.splitEmbeddingText(
      api.generateEmbeddingText(
        node,
        chunk.text,
        {},
        chunk.chunkIndex,
        api.withoutOverlappingContext?.(tail, previousEnd, chunk.startOffset) ?? tail,
      ),
      4096,
    )) {
      count++;
      chars += text.length;
      texts.push(text);
    }
    tail = chunk.text.slice(-120);
    previousEnd = chunk.endOffset;
  }
  return { count, chars, texts };
}
async function sample(api, cohort) {
  // Yield between samples and production-sized batches so native tree
  // finalizers can run, as they do while the real pipeline awaits inference.
  await setImmediate();
  global.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  let work = { count: 0, chars: 0 };
  const reader =
    sourceMode && api.EmbeddingSourceReader
      ? new api.EmbeddingSourceReader(sourceContext)
      : undefined;
  if (cohort.startsWith('inference:')) {
    const prepared = [];
    for (let i = 0; i < 4; i++) {
      const result = await prepare(api, nodes[cohort.slice(10)], reader);
      work = { count: result.count, chars: result.chars };
      prepared.push(...result.texts);
    }
    for (let i = 0; i < prepared.length; i += 8)
      await embedder.embedBatch(prepared.slice(i, i + 8));
  } else if (cohort === 'query') {
    const query = await embedder.embedText('find the function returning the tail sentinel');
    const vector = Array.from(query);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      nodeId: `Function:${i}`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 10,
      embedding: vector,
    }));
    api.rankExactEmbeddingRows(rows, vector, 10, 0.5);
  } else if (cohort.startsWith('hash:')) {
    const node = nodes[cohort.slice(5)];
    for (let i = 0; i < 10000; i++)
      api.contentHashForNode(node, {}, reader ? sourceContext : undefined);
  } else {
    for (let i = 0; i < (cohort === 'short' ? 10000 : 200); i++) {
      const result = await prepare(api, nodes[cohort], reader);
      work = { count: result.count, chars: result.chars };
      if (i % 16 === 15) await setImmediate();
    }
  }
  const ms = performance.now() - start;
  const after = process.memoryUsage();
  return {
    ms,
    rss: after.rss,
    heapUsed: after.heapUsed,
    heapDelta: after.heapUsed - before.heapUsed,
    ...work,
  };
}
const result = {
  runtime: process.version,
  model: 'Snowflake/snowflake-arctic-embed-xs',
  device: 'cpu',
  threads: 2,
  sourceMode,
  baselineRoot,
  candidateRoot,
  samples: {},
};
try {
  for (const cohort of [
    ...Object.keys(nodes),
    ...Object.keys(nodes).map((key) => `hash:${key}`),
    ...Object.keys(nodes).map((key) => `inference:${key}`),
    'query',
  ]) {
    for (let i = 0; i < 3; i++) {
      await sample(baseline, cohort);
      await sample(candidate, cohort);
    }
    const pairs = [];
    for (let i = 0; i < 16; i++) {
      const pair = {};
      for (const key of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
        pair[key] = await sample(key === 'baseline' ? baseline : candidate, cohort);
      pairs.push(pair);
    }
    result.samples[cohort] = pairs;
    const percentile = (key, q) =>
      pairs.map((p) => p[key].ms).sort((a, b) => a - b)[Math.ceil(q * pairs.length) - 1];
    console.log(
      JSON.stringify({
        cohort,
        baselineMedian: percentile('baseline', 0.5),
        candidateMedian: percentile('candidate', 0.5),
        baselineP95: percentile('baseline', 0.95),
        candidateP95: percentile('candidate', 0.95),
        baselineWork: pairs[0].baseline,
        candidateWork: pairs[0].candidate,
      }),
    );
  }
  await writeFile(output, JSON.stringify(result, null, 2));
} finally {
  await embedder.disposeEmbedder();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
}
