import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ParsedFile } from 'gitnexus-shared';
import {
  clearParsedFileStore,
  persistParsedFileChunk,
  persistParsedFileShardSync,
  loadParsedFilesForPaths,
  getParsedFileStoreDir,
} from '../../src/storage/parsedfile-store.js';

/**
 * Build a minimal ParsedFile whose Scope carries `bindings` / `typeBindings`
 * Maps — the round-trip's fidelity hinges on those Maps surviving JSON
 * serialization (they would otherwise collapse to `{}`).
 */
const makeParsedFile = (filePath: string): ParsedFile =>
  ({
    filePath,
    moduleScope: `${filePath}:module`,
    parsedImports: [],
    localDefs: [
      { nodeId: `Function:${filePath}:fn`, filePath, type: 'Function', qualifiedName: 'fn' },
    ],
    referenceSites: [],
    scopes: [
      {
        id: `${filePath}:module`,
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 9, endCol: 0 },
        filePath,
        bindings: new Map([['fn', [{ defId: `Function:${filePath}:fn`, origin: 'local' }]]]),
        ownedDefs: [],
        imports: [],
        typeBindings: new Map([['x', { name: 'int' }]]),
      },
    ],
  }) as unknown as ParsedFile;

/**
 * Store payload with arbitrary (possibly corrupt) field overrides. The one
 * controlled escape hatch for building malformed serialization-boundary
 * fixtures lives HERE instead of double-casts scattered through the tests
 * (#2522 review).
 */
function makeStoreEntry(filePath: string, overrides: Record<string, unknown>): ParsedFile {
  return {
    ...(makeParsedFile(filePath) as unknown as Record<string, unknown>),
    ...overrides,
  } as unknown as ParsedFile;
}

describe('parsedfile-store', () => {
  it('round-trips ParsedFiles (incl. Scope Maps) and filters by requested paths', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [makeParsedFile('a.c'), makeParsedFile('b.c')]);
      await persistParsedFileChunk(dir, 'chunk-1', [makeParsedFile('c.c')]);

      // Filtering: only requested paths come back.
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c', 'c.c']));
      expect([...loaded.keys()].sort()).toEqual(['a.c', 'c.c']);
      expect(loaded.has('b.c')).toBe(false);

      // Map fidelity: bindings / typeBindings survive as real Maps.
      const a = loaded.get('a.c')!;
      const scope = a.scopes[0];
      expect(scope.bindings).toBeInstanceOf(Map);
      expect(scope.bindings.get('fn')?.[0]?.defId).toBe('Function:a.c:fn');
      expect(scope.typeBindings).toBeInstanceOf(Map);
      expect((scope.typeBindings.get('x') as { name: string }).name).toBe('int');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes no shard for an empty chunk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-empty', []);
      let shardCount = 0;
      try {
        shardCount = (await readdir(getParsedFileStoreDir(dir))).length;
      } catch {
        shardCount = 0; // dir not created — also fine
      }
      expect(shardCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clearParsedFileStore removes all shards (subsequent load is empty)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [makeParsedFile('a.c')]);
      await clearParsedFileStore(dir);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c']));
      expect(loaded.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty map when the store is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c']));
      expect(loaded.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips validated callable-flow operand and signature metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const pf = makeStoreEntry('flow.cpp', {
        callableFlowSites: [
          {
            kind: 'seed',
            destination: {
              name: 'member',
              inScope: 'scope:entry',
              atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 8 },
              indirection: 0,
              addressOf: false,
              expressionKind: 'binding',
            },
            targetName: 'run',
            targetQualifiedName: 'Base.run',
            targetRange: { startLine: 3, startCol: 12, endLine: 3, endCol: 21 },
            expectedSignature: {
              parameterCount: 1,
              parameterTypes: ['int'],
              isConst: true,
            },
          },
        ],
      });
      await persistParsedFileChunk(dir, 'flow', [pf]);

      const loaded = await loadParsedFilesForPaths(dir, new Set(['flow.cpp']));
      expect(loaded.get('flow.cpp')?.callableFlowSites).toEqual(pf.callableFlowSites);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops a malformed callable-flow site but retains the file and its other sites (per-site sanitation, #2522)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const operand = {
        name: 'callback',
        inScope: 'scope:entry',
        atRange: { startLine: 2, startCol: 2, endLine: 2, endCol: 10 },
        indirection: 17,
        addressOf: false,
        expressionKind: 'binding',
      };
      const invalid = makeStoreEntry('invalid.c', {
        callableFlowSites: [
          {
            kind: 'invoke',
            callSite: { startLine: 2, startCol: 2, endLine: 2, endCol: 12 },
            inScope: 'scope:entry',
            callee: operand,
            invocationKind: 'indirect',
            arity: 0,
          },
        ],
      });
      await persistParsedFileChunk(dir, 'invalid', [invalid, makeParsedFile('valid.c')]);

      const loaded = await loadParsedFilesForPaths(dir, new Set(['invalid.c', 'valid.c']));
      // The file survives with the offending site dropped — a per-file
      // rejection here caused a permanent, silent warm-cache reparse loop.
      expect(loaded.get('invalid.c')?.callableFlowSites).toEqual([]);
      expect(loaded.has('valid.c')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts empty-string parameterTypes entries ("" = unknown type, real C++ extractor output)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const pf = makeStoreEntry('cv.cpp', {
        callableFlowSites: [
          {
            kind: 'seed',
            destination: {
              name: 'fp',
              inScope: 'scope:entry',
              atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 8 },
              indirection: 0,
              addressOf: false,
              expressionKind: 'binding',
            },
            targetName: 'handler',
            targetRange: { startLine: 1, startCol: 12, endLine: 1, endCol: 19 },
            expectedSignature: { parameterCount: 2, parameterTypes: ['int', ''] },
          },
        ],
      });
      await persistParsedFileChunk(dir, 'cv', [pf]);

      const loaded = await loadParsedFilesForPaths(dir, new Set(['cv.cpp']));
      expect(loaded.get('cv.cpp')?.callableFlowSites).toEqual(pf.callableFlowSites);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects the whole file only when callableFlowSites is non-array garbage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const garbage = makeStoreEntry('garbage.c', {
        callableFlowSites: 'not-an-array',
      });
      await persistParsedFileChunk(dir, 'garbage', [garbage, makeParsedFile('ok.c')]);

      const loaded = await loadParsedFilesForPaths(dir, new Set(['garbage.c', 'ok.c']));
      expect(loaded.has('garbage.c')).toBe(false);
      expect(loaded.has('ok.c')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #1983 parallel serialization: the sync worker writer and the async writer
  // share one serialization core and MUST produce byte-identical shards (the
  // loader's deep-equals masks byte drift, so assert raw bytes).
  it('persistParsedFileShardSync writes byte-identical shards to the async writer', async () => {
    const asyncDir = await mkdtemp(path.join(tmpdir(), 'pfstore-a-'));
    const syncDir = await mkdtemp(path.join(tmpdir(), 'pfstore-s-'));
    try {
      const files = [makeParsedFile('a.c'), makeParsedFile('b.c')];
      await persistParsedFileChunk(asyncDir, 'shard', files);
      persistParsedFileShardSync(syncDir, 'shard', files);
      const asyncBytes = await readFile(
        path.join(getParsedFileStoreDir(asyncDir), 'shard.json'),
        'utf-8',
      );
      const syncBytes = await readFile(
        path.join(getParsedFileStoreDir(syncDir), 'shard.json'),
        'utf-8',
      );
      expect(syncBytes).toBe(asyncBytes);
    } finally {
      await rm(asyncDir, { recursive: true, force: true });
      await rm(syncDir, { recursive: true, force: true });
    }
  });

  it('persistParsedFileShardSync round-trips through loadParsedFilesForPaths with Maps intact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      persistParsedFileShardSync(dir, 'w1-0', [makeParsedFile('a.c')]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c']));
      const scope = loaded.get('a.c')!.scopes[0];
      expect(scope.bindings).toBeInstanceOf(Map);
      expect(scope.bindings.get('fn')?.[0]?.defId).toBe('Function:a.c:fn');
      expect(scope.typeBindings).toBeInstanceOf(Map);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #1983 capture side-channel: a ParsedFile may carry a plain-data
  // `captureSideChannel` (e.g. C++ ADL / namespace / two-phase marks the worker
  // computed). It MUST survive the JSON store round-trip so the main thread can
  // restore those module maps WITHOUT a re-parse. Plain objects/arrays only —
  // no Maps/Sets — so the interning reviver passes them through unchanged.
  it('round-trips a ParsedFile.captureSideChannel (plain data) through the store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const sideChannel = {
        adl: {
          argInfoBySite: [
            [
              6,
              4,
              [
                {
                  simpleClassName: 'Event',
                  templateSimpleClassName: '',
                  templateNamespace: '',
                  templateArgClassNames: [],
                  templateArgNamespaces: [],
                },
              ],
            ],
          ],
          noAdlSites: [[9, 2]],
        },
        inlineNamespaceRanges: ['1:0:3:1'],
        fileLocal: {
          fileLocalNames: ['helper'],
          anonymousNamespaceRanges: ['4:0:6:1'],
        },
        twoPhase: {
          dependentBases: [['Derived', [['Base', ['detail']]]]],
          dependentPackBaseClasses: ['Mix'],
        },
      };
      const pf = makeStoreEntry('app.cpp', {
        captureSideChannel: sideChannel,
      });

      persistParsedFileShardSync(dir, 'w1-0', [pf]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['app.cpp']));
      const got = loaded.get('app.cpp')!;
      // Deep-equal: the plain-data snapshot survives byte-for-byte (after JSON).
      expect((got as { captureSideChannel?: unknown }).captureSideChannel).toEqual(sideChannel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #1983 (Kotlin): the kotlin provider carries a self-describing companion-
  // scope side-channel `{ kind: 'kotlin', companionScopes: ScopeId[] }`. It
  // shares the single generic `captureSideChannel` field with C++, so confirm
  // the (Set→array) plain-data shape survives the JSON store round-trip too.
  it('round-trips a Kotlin ParsedFile.captureSideChannel through the store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const sideChannel = {
        kind: 'kotlin',
        companionScopes: ['scope:Logger.companion', 'scope:Animal.companion'],
      };
      const pf = makeStoreEntry('App.kt', {
        captureSideChannel: sideChannel,
      });

      persistParsedFileShardSync(dir, 'w1-0', [pf]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['App.kt']));
      const got = loaded.get('App.kt')!;
      expect((got as { captureSideChannel?: unknown }).captureSideChannel).toEqual(sideChannel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #1983 (C): the C provider carries a self-describing static-linkage side-
  // channel `{ kind: 'c', staticNames: string[] }` (the file-local `static`
  // function names the worker recorded). It shares the single generic
  // `captureSideChannel` field with C++/Kotlin, so confirm the plain-data shape
  // survives the JSON store round-trip too — without it, `static` functions
  // leak into cross-file resolution on the worker-only parse path.
  it('round-trips a C ParsedFile.captureSideChannel through the store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const sideChannel = { kind: 'c', staticNames: ['compute', 'helper'] };
      const pf = makeStoreEntry('local.c', {
        captureSideChannel: sideChannel,
      });

      persistParsedFileShardSync(dir, 'w1-0', [pf]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['local.c']));
      const got = loaded.get('local.c')!;
      expect((got as { captureSideChannel?: unknown }).captureSideChannel).toEqual(sideChannel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persistParsedFileShardSync writes no shard and no directory for empty input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      persistParsedFileShardSync(dir, 'w1-0', []);
      let entries: string[] = [];
      try {
        entries = await readdir(getParsedFileStoreDir(dir));
      } catch {
        entries = []; // store dir not created — the expected parity with the async writer
      }
      expect(entries).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Def-object dedup: each SymbolDefinition is serialized THREE times — in
  // ParsedFile.localDefs, in the owning scope.ownedDefs, and inside
  // scope.bindings[].def (BindingRef) — but is ONE object by reference in the
  // live extractor. JSON.parse rebuilds three distinct objects; the load reviver
  // must re-share them by nodeId (collapsing ~3× the def-object heap on the
  // disk-backed/kernel path). Re-sharing is byte-identical to resolution because
  // every consumer reads defs by value (nodeId/type), never by object identity.
  it("re-shares a def's three serialized copies into one object on load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const def = {
        nodeId: 'Function:a.c:fn',
        filePath: 'a.c',
        type: 'Function',
        qualifiedName: 'fn',
      };
      const pf = {
        filePath: 'a.c',
        moduleScope: 'a.c:module',
        parsedImports: [],
        localDefs: [def], // copy 1
        referenceSites: [],
        scopes: [
          {
            id: 'a.c:module',
            parent: null,
            kind: 'Module',
            range: { startLine: 1, startCol: 0, endLine: 9, endCol: 0 },
            filePath: 'a.c',
            bindings: new Map([['fn', [{ def }]]]), // copy 3 (BindingRef.def)
            ownedDefs: [def], // copy 2
            imports: [],
            typeBindings: new Map(),
          },
        ],
      } as unknown as ParsedFile;

      persistParsedFileShardSync(dir, 'w1-0', [pf]);
      const loaded = (await loadParsedFilesForPaths(dir, new Set(['a.c']))).get('a.c')!;

      const fromLocal = loaded.localDefs[0];
      const scope = loaded.scopes[0];
      const fromOwned = scope.ownedDefs[0];
      const fromBinding = scope.bindings.get('fn')![0].def;

      // All three deserialized copies are re-shared into ONE object.
      expect(fromLocal).toBe(fromOwned);
      expect(fromLocal).toBe(fromBinding);
      // Value-identical to what was written.
      expect(fromLocal).toEqual({
        nodeId: 'Function:a.c:fn',
        filePath: 'a.c',
        type: 'Function',
        qualifiedName: 'fn',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps defs with distinct nodeIds as distinct objects (no over-collapsing)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const def1 = {
        nodeId: 'Function:a.c:fn1',
        filePath: 'a.c',
        type: 'Function',
        qualifiedName: 'fn1',
      };
      const def2 = {
        nodeId: 'Function:a.c:fn2',
        filePath: 'a.c',
        type: 'Function',
        qualifiedName: 'fn2',
      };
      const pf = {
        filePath: 'a.c',
        moduleScope: 'a.c:module',
        parsedImports: [],
        localDefs: [def1, def2],
        referenceSites: [],
        scopes: [
          {
            id: 'a.c:module',
            parent: null,
            kind: 'Module',
            range: { startLine: 1, startCol: 0, endLine: 9, endCol: 0 },
            filePath: 'a.c',
            bindings: new Map([
              ['fn1', [{ def: def1 }]],
              ['fn2', [{ def: def2 }]],
            ]),
            ownedDefs: [def1, def2],
            imports: [],
            typeBindings: new Map(),
          },
        ],
      } as unknown as ParsedFile;

      persistParsedFileShardSync(dir, 'w1-0', [pf]);
      const loaded = (await loadParsedFilesForPaths(dir, new Set(['a.c']))).get('a.c')!;

      expect(loaded.localDefs[0]).not.toBe(loaded.localDefs[1]);
      expect(loaded.localDefs[0].nodeId).toBe('Function:a.c:fn1');
      expect(loaded.localDefs[1].nodeId).toBe('Function:a.c:fn2');
      // Each still re-shares with its own ownedDefs copy.
      expect(loaded.localDefs[0]).toBe(loaded.scopes[0].ownedDefs[0]);
      expect(loaded.localDefs[1]).toBe(loaded.scopes[0].ownedDefs[1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
