#!/usr/bin/env node
// node --import tsx bench/embedding-inputs/measure.cjs [--check]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
(async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(__dirname, 'baseline.json'), 'utf8'));
  const { chunkNode } = await import(
    pathToFileURL(path.join(root, 'src/core/embeddings/chunker.ts')).href
  );
  const generator = await import(
    pathToFileURL(path.join(root, 'src/core/embeddings/text-generator.ts')).href
  );
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
  };
  const sameEnvironment = Object.entries(environment).every(
    ([key, value]) => baseline.environment?.[key] === value,
  );
  const results = [];
  for (const fields of baseline.fields) {
    const content =
      'export interface Payload {\n' +
      Array.from({ length: fields }, (_, i) => `  field${i}: string; // 中文字段说明😀${i}\n`).join(
        '',
      ) +
      '}';
    const node = {
      id: 'Interface:payload.ts:Payload',
      name: 'Payload',
      label: 'Interface',
      filePath: 'payload.ts',
      content,
    };
    const chunks = await chunkNode(node.label, content, node.filePath, 0, fields + 1, 1200, 120);
    const samples = [];
    let largestInput = 0;
    let inputs = 0;
    for (let trial = 0; trial < 4; trial++) {
      const start = performance.now();
      for (let iteration = 0; iteration < baseline.iterations; iteration++) {
        let previous = '';
        for (const chunk of chunks) {
          const text = generator.generateEmbeddingText(
            node,
            chunk.text,
            {},
            chunk.chunkIndex,
            previous,
          );
          const parts = generator.splitEmbeddingText
            ? generator.splitEmbeddingText(text, baseline.max_input_chars)
            : [text];
          let length = 0;
          for (const input of parts) {
            largestInput = Math.max(largestInput, input.length);
            length += input.length;
            inputs++;
          }
          assert.equal(length, text.length);
          previous = chunk.text.slice(-120);
        }
      }
      const ms = performance.now() - start;
      if (trial > 0) samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    results.push({
      fields,
      source_bytes: Buffer.byteLength(content),
      chunks: chunks.length,
      fingerprint: createHash('sha256').update(content).digest('hex'),
      median_ms: samples[1],
      samples_ms: samples,
      largest_input: largestInput,
      inputs,
    });
  }
  const scaling =
    results[1].median_ms / results[0].median_ms / (baseline.fields[1] / baseline.fields[0]);
  console.log(JSON.stringify({ environment, results, normalized_scaling: scaling }, null, 2));
  if (process.argv.includes('--check')) {
    assert.ok(scaling <= baseline.linear_scaling_budget);
    if (!sameEnvironment)
      console.warn(
        'Absolute timing gate skipped: baseline environment differs; correctness and scaling gates still apply.',
      );
    for (const result of results) {
      assert.ok(result.largest_input <= baseline.max_input_chars);
      const original = baseline.results?.find((row) => row.fields === result.fields);
      assert.ok(original, 'Record a measured main baseline before checking');
      assert.equal(result.fingerprint, original.fingerprint);
      if (sameEnvironment)
        assert.ok(result.median_ms / original.median_ms <= baseline.regression_budget);
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
