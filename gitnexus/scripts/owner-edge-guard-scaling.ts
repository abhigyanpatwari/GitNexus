/**
 * Reproducible scaling probe for the per-file owner-edge guard.
 *
 * Run alone, after a build, from gitnexus/:
 * node --expose-gc --import tsx scripts/owner-edge-guard-scaling.ts > /tmp/owner-edge-scaling.json
 * --operations-only skips timings; --sizes=1024,2048,... --samples=11 --warmup=3 override defaults.
 *
 * Timings include guard lifecycle and appending preconstructed rows, excluding
 * fixture creation, prefix copies, assertions, and explicit GC. Prefix-isolation
 * timings call the guard directly on a fixed 16-member slice. Proxy counters run
 * separately: they are deterministic regression checks, never timed thresholds.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  createOwnerEdgeGuard,
  dropDanglingInFileOwnerEdges,
} from '../src/core/ingestion/workers/owner-edge-guard.js';
import type { ParseWorkerResult } from '../src/core/ingestion/workers/parse-worker.js';

const source = readFileSync(
  new URL('../src/core/ingestion/workers/owner-edge-guard.ts', import.meta.url),
);

type Slice = Pick<ParseWorkerResult, 'nodes' | 'relationships'>;
type Rel = Slice['relationships'][number];
type Shape = 'member-free' | 'clean' | 'dangling' | 'predefined' | 'duplicate' | 'owner-last';
type FileFixture = Slice & { path: string; expected: Rel[] };
type Reads = { nodes: number; relationships: number; writes: number };

const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1024,2048,4096,8192,16384,32768,65536' },
    samples: { type: 'string', default: '11' },
    warmup: { type: 'string', default: '3' },
    'operations-only': { type: 'boolean', default: false },
  },
});
const sizes = values.sizes.split(',').map(Number);
const samples = Number(values.samples);
const warmup = Number(values.warmup);
assert(
  sizes.length >= 2 &&
    sizes.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > sizes[i - 1])),
);
assert(Number.isSafeInteger(samples) && samples >= 3);
assert(Number.isSafeInteger(warmup) && warmup >= 1);

const edge = (type: Rel['type'], sourceId: string, targetId: string): Rel => ({
  id: `${type}:${sourceId}->${targetId}`,
  sourceId,
  targetId,
  type,
  confidence: 1,
  reason: '',
});

function fixture(shape: Shape, count: number, file: number): FileFixture {
  // Fixed-width ids keep the string-length dimension constant across sizes.
  const path = `src/file-${String(file).padStart(8, '0')}.ts`;
  const owner = `Class:${path}:Owner`;
  const result: FileFixture = { path, nodes: [], relationships: [], expected: [] };
  const addNode = (id: string, label: string): void => {
    result.nodes.push({
      id,
      label,
      properties: {
        name: id,
        filePath: path,
        startLine: 0,
        endLine: 0,
        language: SupportedLanguages.TypeScript,
        isExported: false,
      },
    });
  };
  if (shape === 'clean') addNode(owner, 'Class');
  for (let i = 0; i < count; i++) {
    const target = `Method:${path}:member-${String(i).padStart(8, '0')}`;
    const defined = edge('DEFINES', `File:${path}`, target);
    const member = edge(i % 2 ? 'HAS_PROPERTY' : 'HAS_METHOD', owner, target);
    addNode(target, 'Method');
    if (shape === 'member-free' || shape === 'predefined') result.relationships.push(defined);
    if (shape !== 'member-free') result.relationships.push(member);
    if (shape === 'duplicate') result.relationships.push(edge('HAS_PROPERTY', owner, target));
    result.expected.push(shape === 'clean' || shape === 'owner-last' ? member : defined);
  }
  if (shape === 'owner-last') addNode(owner, 'Class');
  return result;
}

function files(shape: Shape, count: number, perFile: number): FileFixture[] {
  const result: FileFixture[] = [];
  for (let i = 0; i < count; i += perFile)
    result.push(fixture(shape, Math.min(perFile, count - i), i / perFile));
  return result;
}

function append(target: Slice, file: Slice): void {
  for (const node of file.nodes) target.nodes.push(node);
  for (const rel of file.relationships) target.relationships.push(rel);
}

function verify(result: Slice, expected: Rel[], nodeCount: number): void {
  assert.equal(result.nodes.length, nodeCount);
  assert.deepEqual(result.relationships, expected);
}

/** Count numeric array accesses only while the production guard runs. */
function operations(input: FileFixture[], prefix: Slice): Reads {
  const raw: Slice = { nodes: prefix.nodes.slice(), relationships: prefix.relationships.slice() };
  let nodeStart = raw.nodes.length;
  let relStart = raw.relationships.length;
  const reads: Reads = { nodes: 0, relationships: 0, writes: 0 };
  const watched = <T>(array: T[], kind: 'nodes' | 'relationships'): T[] =>
    new Proxy(array, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          assert(
            Number(property) >= (kind === 'nodes' ? nodeStart : relStart),
            `rescanned previous ${kind}`,
          );
          reads[kind]++;
        }
        return Reflect.get(target, property, receiver);
      },
      set(target, property, value, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          assert(
            Number(property) >= (kind === 'nodes' ? nodeStart : relStart),
            `rewrote previous ${kind}`,
          );
          reads.writes++;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
  const guarded = {
    nodes: watched(raw.nodes, 'nodes'),
    relationships: watched(raw.relationships, 'relationships'),
  };
  const guard = createOwnerEdgeGuard(guarded);
  for (const file of input) {
    guard.open(file.path); // Settles the previous slice before the boundaries advance.
    nodeStart = raw.nodes.length;
    relStart = raw.relationships.length;
    append(raw, file); // Fixture appends bypass the access counters.
  }
  guard.settle();
  const settledReads = { ...reads };
  guard.settle();
  assert.deepEqual(reads, settledReads, 'settling twice rescans a file');
  const n = input.reduce((sum, file) => sum + file.nodes.length, 0);
  const e = input.reduce((sum, file) => sum + file.relationships.length, 0);
  assert(reads.nodes <= n, 'more than one node pass');
  assert(reads.relationships <= 3 * e, 'more than three relationship passes');
  assert(reads.writes <= e, 'more than one compaction pass');
  verify(
    raw,
    [...prefix.relationships, ...input.flatMap((file) => file.expected)],
    prefix.nodes.length + n,
  );
  return reads;
}

function trial(input: FileFixture[], prefix: Slice, direct: boolean, expected: Rel[]): number {
  const result: Slice = {
    nodes: prefix.nodes.slice(),
    relationships: prefix.relationships.slice(),
  };
  const nodeStart = result.nodes.length;
  const relStart = result.relationships.length;
  if (direct) append(result, input[0]);
  globalThis.gc?.();
  const start = performance.now();
  if (direct) {
    dropDanglingInFileOwnerEdges(result, input[0].path, nodeStart, relStart);
  } else {
    const guard = createOwnerEdgeGuard(result);
    for (const file of input) {
      guard.open(file.path);
      append(result, file);
    }
    guard.settle();
  }
  const elapsed = performance.now() - start;
  verify(
    result,
    expected,
    prefix.nodes.length + input.reduce((sum, file) => sum + file.nodes.length, 0),
  );
  return elapsed;
}

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
};

function measure(shape: Shape, count: number, perFile: number, prefixCount = 0) {
  const input = files(shape, count, perFile);
  const prefix = prefixCount
    ? fixture('member-free', prefixCount, 99999999)
    : { nodes: [], relationships: [] };
  const nodes = input.reduce((sum, file) => sum + file.nodes.length, 0);
  const relationships = input.reduce((sum, file) => sum + file.relationships.length, 0);
  const counts = operations(input, prefix);
  const direct = prefixCount > 0;
  const samplesMs: number[] = [];
  if (!values['operations-only']) {
    for (let i = 0; i < warmup + samples; i++) {
      const freshInput = files(shape, count, perFile);
      const expected = [...prefix.relationships, ...freshInput.flatMap((file) => file.expected)];
      const elapsed = trial(freshInput, prefix, direct, expected);
      if (i >= warmup) samplesMs.push(elapsed);
    }
  }
  const medianMs = samplesMs.length ? percentile(samplesMs, 0.5) : null;
  return {
    shape,
    members: count,
    files: input.length,
    prefixRows: prefix.nodes.length + prefix.relationships.length,
    nodes,
    relationships,
    indexedReads: counts,
    samplesMs,
    medianMs,
    p95Ms: samplesMs.length ? percentile(samplesMs, 0.95) : null,
    nsPerRow: medianMs === null ? null : (medianMs * 1e6) / (nodes + relationships),
  };
}

function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2 || points.some(({ x, y }) => x <= 0 || y <= 0)) return null;
  const xs = points.map(({ x }) => Math.log(x));
  const ys = points.map(({ y }) => Math.log(y));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  return (
    xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) /
    xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0)
  );
}

const cases: ReturnType<typeof measure>[] = [];
const scaling: { shape: Shape; distribution: string; logLogSlope: number | null }[] = [];
const shapes: Shape[] = [
  'member-free',
  'clean',
  'dangling',
  'predefined',
  'duplicate',
  'owner-last',
];
// Alternate ascending/descending sizes to avoid tying every large case to late-run thermal drift.
for (const [shapeIndex, shape] of shapes.entries()) {
  for (const distribution of ['one-file', 'many-files']) {
    const rows = (shapeIndex % 2 ? [...sizes].reverse() : sizes).map((size) =>
      measure(shape, size, distribution === 'one-file' ? size : 16),
    );
    cases.push(...rows);
    scaling.push({
      shape,
      distribution,
      logLogSlope: values['operations-only']
        ? null
        : slope(
            rows.flatMap((row) =>
              row.medianMs === null ? [] : [{ x: row.nodes + row.relationships, y: row.medianMs }],
            ),
          ),
    });
    process.stderr.write(`Validated ${shape} / ${distribution}\n`);
  }
}
const prefixIsolation = sizes.map((size) => measure('dangling', 16, 16, size));
process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'gitnexus.owner-edge-guard-scaling/v1',
      recordedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model,
        explicitGc: typeof globalThis.gc === 'function',
        processMaxRssKiB: process.resourceUsage().maxRSS,
      },
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      config: { sizes, samples, warmup, operationsOnly: values['operations-only'] },
      methodology: {
        timed:
          'guard lifecycle + append preconstructed rows; prefixIsolation times only the direct guard',
        excluded:
          'fresh fixture generation for every sample, prefix copies, assertions, explicit GC, Proxy instrumentation',
        statistics:
          'nearest-rank median/p95; least-squares slope of log(median ms) versus log(active rows)',
        operations:
          'at most one indexed node read, three indexed relationship reads, one relationship write per active row; no earlier-slice indexed accesses',
        limits:
          'Kernel benchmark, not end-to-end indexing throughput. Timings and slopes are descriptive, not asymptotic proof. maxRSS covers all fixtures and validation and is not guard peak memory. Set operations assume average constant-time hashing; string work scales with id lengths.',
        memory:
          'Live guard scratch is O(nodes + edges) of the largest active file; output accumulation and delayed garbage collection are excluded from that bound.',
      },
      cases,
      scaling,
      prefixIsolation,
    },
    null,
    2,
  )}\n`,
);
