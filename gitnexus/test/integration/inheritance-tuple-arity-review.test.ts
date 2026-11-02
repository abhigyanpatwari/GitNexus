import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
it('counts a C# tuple as one inherited type argument', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-tuple-base-'));
  try {
    writeFixtureRepo(root, {
      'Tuple.cs': 'namespace P { class Child : Base<(int, string)> {} }',
      'One.cs': 'namespace P { class Base<T> {} }',
      'Two.cs': 'namespace P { class Base<T, U> {} }',
    });
    const result = await runPipelineFromRepo(root, () => {}, {});
    expect(
      getRelationships(result, 'EXTENDS')
        .filter((e) => e.source === 'Child')
        .map((e) => e.targetFilePath),
    ).toEqual(['One.cs']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
