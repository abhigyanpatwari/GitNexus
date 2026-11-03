#!/usr/bin/env node
// Compare identical text and chunk outputs against an unchanged built checkout.
// node --expose-gc bench/analyze-resume/text-streaming.mjs /path/to/baseline/gitnexus/dist
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as candidateText from '../../dist/core/embeddings/embedding-pipeline.js';
import * as candidateChunks from '../../dist/core/embeddings/character-chunk.js';

if (!process.argv[2]) throw new Error('Pass the unchanged baseline dist directory');
const baselineDirectory = path.resolve(process.argv[2]);
const baselineText = await import(
  pathToFileURL(path.join(baselineDirectory, 'core/embeddings/embedding-pipeline.js'))
);
const baselineChunks = await import(
  pathToFileURL(path.join(baselineDirectory, 'core/embeddings/character-chunk.js'))
);
const node = (label, content) => ({
  id: `${label}:source.ts:Example`,
  name: 'Example',
  filePath: 'source.ts',
  label,
  content,
  startLine: 1,
  endLine: 1,
});
const cases = [
  {
    name: 'short-code',
    node: node('Function', 'export function example() { return "漢😀"; }\n'),
    repetitions: 10000,
  },
  { name: 'many-short-lines', node: node('File', 'a \t\r\n\n\n'.repeat(600000)), repetitions: 1 },
  {
    name: 'large-short-label',
    node: node('TypeAlias', 'type Huge = ' + '"漢😀" | '.repeat(300000) + 'never;\n'),
    repetitions: 1,
  },
  {
    name: 'large-declaration',
    node: node(
      'Class',
      'export class Example {\n' +
        '  field: string;\n'.repeat(100000) +
        '  method() { return "😀"; }\n}\n',
    ),
    repetitions: 1,
  },
];
const samples = [];
const fingerprints = {};
for (const entry of cases) {
  for (let trial = -1; trial < 7; trial++) {
    for (const mode of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      global.gc?.();
      const impl = mode === 'candidate' ? candidateText : baselineText;
      const start = performance.now();
      let fingerprint;
      for (let i = 0; i < entry.repetitions; i++) fingerprint = impl.contentHashForNode(entry.node);
      const ms = performance.now() - start;
      if (fingerprints[entry.name]) assert.equal(fingerprint, fingerprints[entry.name]);
      fingerprints[entry.name] = fingerprint;
      if (trial >= 0) samples.push({ case: entry.name, trial, mode, ms });
    }
  }
}
const content = 'a\n'.repeat(2 * 1024 * 1024);
for (let trial = -1; trial < 7; trial++) {
  for (const mode of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    global.gc?.();
    const impl = mode === 'candidate' ? candidateChunks : baselineChunks;
    const start = performance.now();
    const chunks =
      mode === 'candidate'
        ? impl.iterateCharacterChunks(content, 1, 2097153, 1200, 120)
        : impl.characterChunk(content, 1, 2097153, 1200, 120);
    const hash = createHash('sha256');
    for (const chunk of chunks) hash.update(JSON.stringify(chunk));
    const ms = performance.now() - start;
    const fingerprint = hash.digest('hex');
    if (fingerprints.chunks) assert.equal(fingerprint, fingerprints.chunks);
    fingerprints.chunks = fingerprint;
    if (trial >= 0) samples.push({ case: 'chunks', trial, mode, ms });
  }
}
const ratios = {};
for (const name of Object.keys(fingerprints)) {
  const median = (mode) =>
    samples
      .filter((s) => s.case === name && s.mode === mode)
      .map((s) => s.ms)
      .sort((a, b) => a - b)[3];
  ratios[name] = median('candidate') / median('baseline');
}
process.stdout.write(
  JSON.stringify(
    { node: process.version, platform: process.platform, fingerprints, ratios, samples },
    null,
    2,
  ) + '\n',
);
