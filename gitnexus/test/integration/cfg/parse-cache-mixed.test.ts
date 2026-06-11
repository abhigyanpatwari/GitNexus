import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDurableParsedFileDir,
  persistDurableParsedFileShardSync,
  restoreDurableParsedFileShard,
  loadParsedFilesForPaths,
} from '../../../src/storage/parsedfile-store.js';
import type { ParsedFile } from 'gitnexus-shared';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';

// #2082 M2 U5 — the warm/mixed cache seam for statement facts. On a warm (or
// mixed) run the unchanged chunk's ParsedFiles are BYTE-COPIED from the
// durable store instead of re-parsed (#2038); if that copy (or the store's
// interning reviver) dropped or aliased the new `bindings`/`statements`
// fields, reaching-defs would silently degrade to `no-facts` for every cached
// file — exactly the field-loss class the #2038 mergeChunkResults lesson
// warns about. This pins the persist → restore → load round-trip at the exact
// seam scope-resolution consumes.

const factCfg: FunctionCfg = {
  filePath: 'src/a.ts',
  functionStartLine: 1,
  functionEndLine: 5,
  functionStartColumn: 0,
  entryIndex: 0,
  exitIndex: 1,
  blocks: [
    { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry', statements: [] },
    {
      index: 1,
      startLine: 5,
      endLine: 5,
      text: '',
      kind: 'exit',
      statements: [
        { line: 2, defs: [0], uses: [] },
        { line: 3, defs: [1], uses: [0] },
      ],
    },
  ],
  edges: [{ from: 0, to: 1, kind: 'seq' }],
  bindings: [
    { name: 'x', declLine: 2, declColumn: 6, kind: 'let' },
    { name: 'y', declLine: 3, declColumn: 6, kind: 'const' },
  ],
};

const mkParsedFile = (filePath: string): ParsedFile =>
  ({
    filePath,
    moduleScope: '',
    scopes: [],
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
    cfgSideChannel: [factCfg],
  }) as unknown as ParsedFile;

describe('durable ParsedFile store carries M2 statement facts (#2082 U5)', () => {
  let tempDir = '';
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-facts-store-'));
  });
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persist → restore → loadParsedFilesForPaths preserves bindings + statements deep-equal', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'c'.repeat(64);
    const files = ['src/a.ts', 'src/b.ts'];

    // What a worker writes at flush on a cache MISS (the cold half of a
    // mixed-mode run)…
    persistDurableParsedFileShardSync(durableDir, chunkHash, 7, 0, files.map(mkParsedFile));
    // …and what a warm HIT byte-copies into the run-scoped store.
    await restoreDurableParsedFileShard(durableDir, tempDir, chunkHash);

    const loaded = await loadParsedFilesForPaths(tempDir, new Set(files));
    expect(loaded.size).toBe(2);
    for (const filePath of files) {
      const pf = loaded.get(filePath);
      expect(pf).toBeDefined();
      const channel = (pf as { cfgSideChannel?: unknown }).cfgSideChannel;
      expect(Array.isArray(channel)).toBe(true);
      const cfg = (channel as FunctionCfg[])[0];
      // deep-equal: the interning reviver may dedup strings/objects but the
      // VALUES must be intact — and no aliasing may merge the two files'
      // distinct fact arrays into wrong shapes.
      expect(cfg.bindings).toEqual(factCfg.bindings);
      expect(cfg.blocks.map((b) => b.statements)).toEqual(factCfg.blocks.map((b) => b.statements));
    }
  });

  it('facts survive even when two files share identical binding tables (reviver dedup safety)', async () => {
    // The store reviver interns strings and dedups objects keyed on `nodeId`
    // presence — BindingEntry/StatementFacts deliberately carry no such field,
    // so dedup must never alias-then-mutate across files. Two files with
    // byte-identical channels is the worst case.
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'd'.repeat(64);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 7, 0, [
      mkParsedFile('src/same1.ts'),
      mkParsedFile('src/same2.ts'),
    ]);
    await restoreDurableParsedFileShard(durableDir, tempDir, chunkHash);
    const loaded = await loadParsedFilesForPaths(
      tempDir,
      new Set(['src/same1.ts', 'src/same2.ts']),
    );
    const c1 = (loaded.get('src/same1.ts') as { cfgSideChannel?: FunctionCfg[] }).cfgSideChannel;
    const c2 = (loaded.get('src/same2.ts') as { cfgSideChannel?: FunctionCfg[] }).cfgSideChannel;
    expect(c1?.[0].bindings).toEqual(factCfg.bindings);
    expect(c2?.[0].bindings).toEqual(factCfg.bindings);
  });
});
