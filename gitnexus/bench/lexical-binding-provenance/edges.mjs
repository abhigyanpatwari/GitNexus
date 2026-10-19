#!/usr/bin/env node
/** Export or compare exact CALLS/METHOD_OVERRIDES multisets on a frozen corpus. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const SOURCE = path.resolve(process.env.BENCH_SOURCE_ROOT ?? REPO);
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  assert.ok(args[at + 1] && !args[at + 1].startsWith('--'), `${name} requires a value`);
  return args[at + 1];
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (edge) => JSON.stringify(edge);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort(compareText);
}

function corpusManifest(root) {
  return filesUnder(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: hash(fs.readFileSync(file)),
  }));
}

function prepareCorpus(destination) {
  assert.equal(fs.existsSync(destination), false, 'refusing to replace an existing corpus');
  const fixtures = path.join(REPO, 'gitnexus/test/fixtures/lang-resolution');
  const fixtureFiles = filesUnder(fixtures);
  const code = fixtureFiles.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const selectedRoots = new Set(
    code.map((file) => path.relative(fixtures, file).split(path.sep)[0]),
  );
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fixtureFiles) {
    const relative = path.relative(fixtures, file);
    if (!selectedRoots.has(relative.split(path.sep)[0])) continue;
    // Include configuration and other support files only in fixtures containing
    // TS/JS. Other source languages are excluded from this exact comparison.
    if (!/\.[cm]?[jt]sx?$/.test(file) && !/\.(?:json|jsonc|yaml|yml)$/.test(file)) continue;
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  const probes = path.join(HERE, 'fixtures');
  if (fs.existsSync(probes))
    fs.cpSync(probes, path.join(destination, 'binding-provenance'), { recursive: true });
  return { files: corpusManifest(destination), fixtureCount: selectedRoots.size };
}

function nodeIdentity(graph, id) {
  const node = graph.getNode(id);
  assert.ok(node, `edge references missing node ${id}`);
  return {
    label: node.label,
    filePath: node.properties.filePath ?? null,
    name: node.properties.name ?? null,
    startLine: node.properties.startLine ?? null,
  };
}

async function exportEdges(corpus, destination) {
  const manifest = corpusManifest(corpus);
  assert.ok(
    manifest.some((file) => /\.[cm]?[jt]sx?$/.test(file.path)),
    'empty TS/JS corpus',
  );
  const { runPipelineFromRepo } = await import(
    pathToFileURL(path.join(SOURCE, 'gitnexus/src/core/ingestion/pipeline.ts')).href
  );
  const result = await runPipelineFromRepo(corpus, () => {}, {
    workerPoolSize: 2,
    skipDerivedGraphPhases: true,
  });
  const keyedEdges = [];
  for (const edge of result.graph.iterRelationships()) {
    if (edge.type !== 'CALLS' && edge.type !== 'METHOD_OVERRIDES') continue;
    const identity = {
      type: edge.type,
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      source: nodeIdentity(result.graph, edge.sourceId),
      target: nodeIdentity(result.graph, edge.targetId),
    };
    keyedEdges.push({ edge: identity, key: canonical(identity) });
  }
  keyedEdges.sort((a, b) => compareText(a.key, b.key));
  const edges = keyedEdges.map(({ edge }) => edge);
  assert.ok(
    edges.some((edge) => edge.type === 'CALLS'),
    'pipeline produced no CALLS edges',
  );
  assert.ok(
    edges.some((edge) => edge.type === 'METHOD_OVERRIDES'),
    'pipeline produced no override edges',
  );
  // Arrays deliberately preserve multiplicity; a Set would hide duplicate edges.
  const output = {
    schema: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: SOURCE, encoding: 'utf8' }).trim()
        .length > 0,
    nodeVersion: process.version,
    corpusFingerprint: hash(JSON.stringify(manifest)),
    manifest,
    counts: Object.fromEntries(
      ['CALLS', 'METHOD_OVERRIDES'].map((type) => [
        type,
        edges.filter((edge) => edge.type === type).length,
      ]),
    ),
    fingerprint: hash(keyedEdges.map(({ key }) => key).join('\n')),
    edges,
  };
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
  console.error(
    JSON.stringify(
      {
        revision: output.revision,
        corpusFingerprint: output.corpusFingerprint,
        counts: output.counts,
        fingerprint: output.fingerprint,
        destination,
      },
      null,
      2,
    ),
  );
}

function multisetDifference(before, after) {
  const counts = new Map();
  for (const edge of before) {
    const key = canonical(edge);
    const entry = counts.get(key) ?? { edge, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const added = [];
  for (const edge of after) {
    const entry = counts.get(canonical(edge));
    if (entry?.count) entry.count--;
    else added.push(edge);
  }
  const removed = [...counts.values()].flatMap(({ edge, count }) =>
    Array.from({ length: count }, () => edge),
  );
  return { removed, added };
}

const prepare = option('--prepare-corpus');
const compare = option('--compare');
const output = option('--output');
if (prepare) {
  const result = prepareCorpus(path.resolve(prepare));
  console.log(
    JSON.stringify(
      {
        fixtureCount: result.fixtureCount,
        files: result.files.length,
        corpusFingerprint: hash(JSON.stringify(result.files)),
      },
      null,
      2,
    ),
  );
} else if (compare) {
  const candidate = option('--candidate');
  assert.ok(candidate, '--compare requires --candidate');
  const before = JSON.parse(fs.readFileSync(compare, 'utf8'));
  const after = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  assert.equal(
    after.corpusFingerprint,
    before.corpusFingerprint,
    'corpora differ; comparison is invalid',
  );
  assert.deepEqual(after.manifest, before.manifest, 'corpus file identities differ');
  const difference = multisetDifference(before.edges, after.edges);
  const report = {
    baselineRevision: before.revision,
    candidateRevision: after.revision,
    corpusFingerprint: before.corpusFingerprint,
    counts: { baseline: before.counts, candidate: after.counts },
    ...difference,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) fs.writeFileSync(output, text);
  else process.stdout.write(text);
  const overrideDeltas = [...difference.removed, ...difference.added].filter(
    (edge) => edge.type === 'METHOD_OVERRIDES',
  );
  assert.equal(overrideDeltas.length, 0, 'METHOD_OVERRIDES changed');
  if (args.includes('--check'))
    assert.equal(
      difference.removed.length + difference.added.length,
      0,
      'CALLS changed; inspect every exact site/target delta',
    );
} else {
  const corpus = option('--corpus');
  assert.ok(
    corpus && output,
    'use --prepare-corpus DIR, --corpus DIR --output FILE, or --compare BASELINE --candidate CANDIDATE [--output FILE] [--check]',
  );
  await exportEdges(path.resolve(corpus), path.resolve(output));
}
