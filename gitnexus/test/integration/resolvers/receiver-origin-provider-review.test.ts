import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeFixtureRepo,
  runPipelineFromRepo,
  getResolutionOutcomes,
  getRelationships,
} from './helpers.js';
const cases = [
  [
    'Node process import in TypeScript',
    'main.ts',
    "import process from 'node:process';\nexport const CURRENT = process.env.RUNTIME_TEST_KEY;\n",
    'RUNTIME_TEST_KEY',
    true,
  ],
  [
    'Node process import in JavaScript',
    'main.js',
    "import runtime from 'process';\nexport const CURRENT = runtime.env.RUNTIME_TEST_KEY;\n",
    'RUNTIME_TEST_KEY',
    true,
  ],
  [
    'unknown import named process',
    'main.ts',
    "import process from 'not-node-runtime';\nexport const CURRENT = process.env.RUNTIME_TEST_KEY;\n",
    'RUNTIME_TEST_KEY',
    false,
  ],
  ...[
    'Dictionary',
    'SortedDictionary',
    'SortedList',
    'ConcurrentDictionary',
    'ReadOnlyDictionary',
    'IDictionary',
    'IReadOnlyDictionary',
  ].map(
    (type) =>
      [
        type,
        'main.cs',
        `using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Collections.ObjectModel;
class User {}
class Service {
 private ${type}<string,User> data;
 public void Run() { foreach (var key in this.data.Keys) {} }
}
`,
        'Keys',
        true,
      ] as const,
  ),
] as const;
it.each(cases)(
  '%s uses provider evidence without overriding program claims',
  async (_label, file, source, member, external) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-provider-review-'));
    try {
      writeFixtureRepo(root, { [file]: source });
      const result = await runPipelineFromRepo(root, () => {});
      const drops = getResolutionOutcomes(result).filter(
        (o) => o.kind === 'suppressed' && o.reason === 'receiver-unresolved' && o.name === member,
      );
      expect(drops.length).toBeGreaterThan(0);
      if (external)
        expect(drops.every((o) => o.kind === 'suppressed' && o.receiverOrigin === 'external')).toBe(
          true,
        );
      else
        expect(drops.some((o) => o.kind === 'suppressed' && o.receiverOrigin === 'external')).toBe(
          false,
        );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);

it('keeps a program collection authoritative', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-program-collection-'));
  try {
    writeFixtureRepo(root, {
      'main.cs': `class SortedDictionary<K,V> { public string[] Keys; }
class User {}
class Service {
 private SortedDictionary<string,User> data;
 public void Run() { foreach (var key in this.data.Keys) {} }
}
`,
    });
    const r = await runPipelineFromRepo(root, () => {});
    expect(
      getRelationships(r, 'ACCESSES').filter(
        (e) => e.target === 'Keys' && e.targetFilePath === 'main.cs',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      getResolutionOutcomes(r).some(
        (o) => o.kind === 'suppressed' && o.name === 'Keys' && o.receiverOrigin === 'external',
      ),
    ).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
