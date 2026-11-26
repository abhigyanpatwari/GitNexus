import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';

export const loaderSource = `function allowed() {
  const ns = require('./target');
  const { run: renamed } = require('./target');
  ns.run(); renamed();
}
function blocked(require) { const ns = require('./forbidden'); ns.run(); }
function ordered() { ns.run(); const ns = require('./target'); ns.run(); }
function hoisted() { { var ns = require('./target'); } ns.run(); }
async function dynamic() { const ns = await import('./target'); ns.run(); }
const Named = class Hidden { method() { return Hidden; } };
class Parent {}
class Child extends Parent {}
`;

// Maps/Sets are part of the shared Scope contract. Their entries, and every
// provider fact, must contain only data: never a tree-sitter node or callback.
export function assertPlainFacts(value: unknown): void {
  if (value === null || value === undefined || typeof value !== 'object') {
    assert.ok(!['function', 'symbol'].includes(typeof value));
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      assertPlainFacts(key);
      assertPlainFacts(item);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) assertPlainFacts(item);
  } else {
    assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)));
    for (const item of Object.values(value)) assertPlainFacts(item);
  }
}

export async function runWorkerParity(fixtures: Record<string, string>) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-local-import-worker-'));
  try {
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    const marker = path.join(tempDir, 'worker.jsonl');
    const worker = path.join(tempDir, 'observed-worker.mjs');
    const realWorker = new URL(
      '../../dist/core/ingestion/workers/parse-worker.js',
      import.meta.url,
    );
    assert.ok(fs.existsSync(realWorker), 'build gitnexus before real-worker parity tests');
    fs.writeFileSync(
      worker,
      `
import fs from 'node:fs';
import { parentPort, threadId } from 'node:worker_threads';
const record = (entry) => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(entry) + '\\n');
record({ type: 'boot', threadId });
parentPort.on('message', (message) => {
  if (message.type === 'sub-batch') record({ type: 'dispatch', files: message.files.map(file => file.path) });
});
const send = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...rest) => {
  if (message.type === 'result') record({ type: 'result', fileCount: message.data.fileCount,
    parsedPaths: message.data.parsedFiles.map(file => file.filePath) });
  return send(message, ...rest);
};
await import(${JSON.stringify(realWorker.href)});
`,
    );
    const directFiles = new Map<string, ParsedFile>();
    for (const [filePath, source] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(repoDir, filePath), source);
      const provider = getProviderForFile(filePath)!;
      const parsed = extractParsedFile(provider, source, filePath);
      assert.ok(parsed, `direct extraction for ${filePath}`);
      const captureSideChannel = provider.collectCaptureSideChannel?.(filePath);
      directFiles.set(
        filePath,
        captureSideChannel === undefined ? parsed : { ...parsed, captureSideChannel },
      );
    }
    const paths = Object.keys(fixtures);
    const output = await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      paths.map((filePath) => ({
        path: filePath,
        size: fs.statSync(path.join(repoDir, filePath)).size,
      })),
      paths,
      paths.length,
      repoDir,
      Date.now(),
      () => {},
      { workerUrlForTest: pathToFileURL(worker), workerPoolSize: 1 },
    );
    const workerFiles = new Map(output.parsedFiles.map((file) => [file.filePath, file]));
    const witness: Array<{ type: string; files?: string[]; parsedPaths?: string[] }> = fs
      .readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return { directFiles, workerFiles, output, witness };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export function assertWorkerDispatch(
  { output, witness, workerFiles }: Awaited<ReturnType<typeof runWorkerParity>>,
  fixtures: Record<string, string>,
) {
  assert.equal(output.usedWorkerPool, true);
  assert.equal(output.reparsedFileCount, Object.keys(fixtures).length);
  assert.equal(output.parseCacheHitFileCount, 0);
  assert.deepEqual(output.scopeExtractionFailures, []);
  assert.ok(witness.some((entry) => entry.type === 'boot'));
  assert.deepEqual(
    witness.flatMap((entry) => entry.files ?? []).sort(),
    Object.keys(fixtures).sort(),
  );
  assert.deepEqual(
    witness.flatMap((entry) => entry.parsedPaths ?? []).sort(),
    Object.keys(fixtures).sort(),
  );
  assert.deepEqual([...workerFiles.keys()].sort(), Object.keys(fixtures).sort());
}
