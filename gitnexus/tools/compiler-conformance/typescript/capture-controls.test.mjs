import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitTsScopeCaptures } from '../../../dist/core/ingestion/languages/typescript/captures.js';
import { createKnowledgeGraph } from '../../../dist/core/graph/graph.js';
import { createSemanticModel } from '../../../dist/core/ingestion/model/semantic-model.js';
import { javascriptScopeResolver } from '../../../dist/core/ingestion/languages/javascript/scope-resolver.js';
import { typescriptScopeResolver } from '../../../dist/core/ingestion/languages/typescript/scope-resolver.js';
import { isCommonJsExportAssignment } from '../../../dist/core/ingestion/languages/typescript/cjs-export-receiver.js';
import { runScopeResolution } from '../../../dist/core/ingestion/scope-resolution/pipeline/run.js';
import { createWorkerPool } from '../../../dist/core/ingestion/workers/worker-pool.js';

function synthesizedCaptureFingerprint() {
  const root = fileURLToPath(new URL('../../../test/fixtures/lang-resolution/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.startsWith('typescript-') && /\.tsx?$/.test(file))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
  const tags = [
    '@reference.inherits',
    '@type-binding.destructured',
    '@type-binding.map-tuple-entry',
    '@type-binding.instanceof-narrow',
  ];
  assert.ok(files.length);
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(root, file);
    const captures = emitTsScopeCaptures(readFileSync(absolute, 'utf8'), file).filter((capture) =>
      tags.some((tag) => capture[tag]),
    );
    // Preserve match order: equal-strength bindings can depend on arrival order.
    hash.update(JSON.stringify([file, captures])).update('\n');
  }
  return hash.digest('hex');
}

test('the ordered captures retain the namespace on the four qualified heritage references', () => {
  assert.equal(
    synthesizedCaptureFingerprint(),
    '05f338426fee4a7a73102be48cdb3495bafbf164c030835009f9cd1f422a571e',
  );
});

const cases = [
  {
    path: 'common.js',
    content: 'module.exports.value = 1;',
    resolver: javascriptScopeResolver,
    expected: true,
  },
  {
    path: 'esm.js',
    content: 'export {}; module.exports.value = 1;',
    resolver: javascriptScopeResolver,
    expected: false,
  },
  {
    path: 'common.ts',
    content: 'module.exports.value = 1;',
    resolver: typescriptScopeResolver,
    expected: true,
  },
  {
    path: 'esm.ts',
    content: 'export {}; module.exports.value = 1;',
    resolver: typescriptScopeResolver,
    expected: false,
  },
];

test('CommonJS export writes agree between main-thread and worker parsing', async () => {
  const pool = createWorkerPool(
    new URL('../../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
    1,
  );
  try {
    const output = await pool.dispatch(cases.map(({ path, content }) => ({ path, content })));
    const files = output.flatMap((result) => result.parsedFiles);
    assert.equal(files.length, cases.length);
    const workerFiles = new Map(files.map((file) => [file.filePath, file]));
    for (const { path, content, resolver, expected } of cases) {
      for (const worker of [false, true]) {
        let observed = false;
        runScopeResolution(
          {
            graph: createKnowledgeGraph(),
            model: createSemanticModel(),
            files: [{ path, content }],
            ...(worker ? { preExtractedParsedFiles: workerFiles } : {}),
            onResolved({ parsedFiles, indexes }) {
              assert.equal(parsedFiles.length, 1);
              const [parsed] = parsedFiles;
              const writes = parsed.referenceSites.filter(
                (site) => site.kind === 'write' && site.name === 'value',
              );
              assert.equal(writes.length, 1, path);
              assert.equal(parsed.captureSideChannel, expected, path);
              assert.equal(isCommonJsExportAssignment(writes[0], indexes, parsed), expected, path);
              observed = true;
            },
          },
          resolver,
        );
        assert.ok(observed, path);
      }
    }
  } finally {
    await pool.terminate();
  }
});
