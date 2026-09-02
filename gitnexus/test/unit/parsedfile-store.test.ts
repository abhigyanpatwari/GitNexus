import { describe, it, expect, vi } from 'vitest';
import { promises as nodeFsPromises } from 'node:fs';
import v8 from 'node:v8';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ParsedFile } from 'gitnexus-shared';
import {
  clearParsedFileStore,
  persistParsedFileChunk,
  persistParsedFileShardSync,
  persistDurableParsedFileShardSync,
  durableChunkHasShards,
  loadParsedFilesForPaths,
  getParsedFileStoreDir,
  getDurableParsedFileDir,
  parsedFileLoadGc,
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
      const asyncBytes = await readFile(path.join(getParsedFileStoreDir(asyncDir), 'shard.v8'));
      const syncBytes = await readFile(path.join(getParsedFileStoreDir(syncDir), 'shard.v8'));
      expect(syncBytes.equals(asyncBytes)).toBe(true);
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

  // #1983 (Kotlin): the kotlin provider carries a self-describing capture
  // side-channel containing companion scopes and class annotation facts. It
  // shares the single generic `captureSideChannel` field with C++, so confirm
  // the (Set→array) plain-data shape survives the JSON store round-trip too.
  it('round-trips a Kotlin ParsedFile.captureSideChannel through the store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
    try {
      const sideChannel = {
        kind: 'kotlin',
        companionScopes: ['scope:Logger.companion', 'scope:Animal.companion'],
        packageFact: { status: 'known', packageName: 'com.example' },
        classAnnotations: [
          {
            classScopeId: 'scope:App.kt#1:0-2:0:Class',
            annotationNames: ['Service'],
          },
        ],
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
        isSynthetic: true,
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
        isSynthetic: true,
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

/**
 * `receiverChain` at the untrusted boundary. Unlike `callableFlowSites`,
 * `referenceSites` had no sanitizer here at all, so this field arrives with the
 * first one.
 */
describe('parsedfile-store receiverChain sanitation', () => {
  const siteWith = (receiverChain: unknown) => ({
    name: 'save',
    atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 6 },
    inScope: 'x.ts:module',
    kind: 'call',
    ...(receiverChain === undefined ? {} : { receiverChain }),
  });

  it('round-trips a well-formed chain', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-chain-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [
        makeStoreEntry('x.ts', { referenceSites: [siteWith('2|svc|cgetUser')] }),
      ]);
      const loaded = (await loadParsedFilesForPaths(dir, new Set(['x.ts']))).get('x.ts')!;
      expect(loaded.referenceSites[0]).toMatchObject({
        name: 'save',
        receiverChain: '2|svc|cgetUser',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a shard written before the field existed, unchanged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-chain-old-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [
        makeStoreEntry('x.ts', { referenceSites: [siteWith(undefined)] }),
      ]);
      const loaded = (await loadParsedFilesForPaths(dir, new Set(['x.ts']))).get('x.ts')!;
      expect(loaded.referenceSites[0]).toMatchObject({ name: 'save' });
      expect(loaded.referenceSites[0]).not.toHaveProperty('receiverChain');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed', 'not-a-chain'],
    ['unknown future version', '3|svc|cgetUser'],
    ['superseded v1 payload', '1|svc|cgetUser'],
    ['over depth', '2|svc|ca|cb|cc|cd'],
    ['non-string', 42],
  ])(
    'strips a %s chain but KEEPS the site — it still resolves via the text cascade',
    async (_label, payload) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-chain-bad-'));
      try {
        await persistParsedFileChunk(dir, 'chunk-0', [
          makeStoreEntry('x.ts', { referenceSites: [siteWith(payload)] }),
        ]);
        const loaded = (await loadParsedFilesForPaths(dir, new Set(['x.ts']))).get('x.ts')!;
        expect(loaded.referenceSites).toHaveLength(1);
        expect(loaded.referenceSites[0]).toMatchObject({ name: 'save' });
        expect(loaded.referenceSites[0]).not.toHaveProperty('receiverChain');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects the file when referenceSites is not an array at all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-chain-garbage-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [
        makeStoreEntry('garbage.ts', { referenceSites: 'nonsense' }),
        makeStoreEntry('ok.ts', { referenceSites: [siteWith('2|svc|cgetUser')] }),
      ]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['garbage.ts', 'ok.ts']));
      expect(loaded.has('garbage.ts')).toBe(false);
      expect(loaded.has('ok.ts')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('strips only the invalid chain and leaves a valid sibling intact', async () => {
    // Sanitation is per-FIELD, not per-site or per-file. Every other case here
    // uses a single-element array, so the `dropped > 0` .map() branch was never
    // shown to preserve a good neighbour.
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-chain-mixed-'));
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [
        makeStoreEntry('x.ts', {
          referenceSites: [
            siteWith('2|svc|cgetUser'),
            siteWith('not-a-chain'),
            siteWith('2|other|ffield'),
          ],
        }),
      ]);
      const loaded = (await loadParsedFilesForPaths(dir, new Set(['x.ts']))).get('x.ts')!;
      expect(loaded.referenceSites).toHaveLength(3);
      expect(loaded.referenceSites[0]).toMatchObject({ receiverChain: '2|svc|cgetUser' });
      expect(loaded.referenceSites[1]).not.toHaveProperty('receiverChain');
      expect(loaded.referenceSites[2]).toMatchObject({ receiverChain: '2|other|ffield' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes one .v8 shard per chunk and skips deserialize for non-intersecting listings (#3087)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-v8-skip-'));
    const deserialize = vi.spyOn(v8, 'deserialize');
    try {
      await persistParsedFileChunk(dir, 'chunk-0', [makeParsedFile('a.c')]);
      await persistParsedFileChunk(dir, 'chunk-1', [makeParsedFile('b.c')]);
      expect((await readdir(getParsedFileStoreDir(dir))).sort()).toEqual([
        'chunk-0.v8',
        'chunk-1.v8',
      ]);
      deserialize.mockClear();
      const loaded = await loadParsedFilesForPaths(dir, new Set(['b.c']));
      expect([...loaded.keys()]).toEqual(['b.c']);
      expect(deserialize).toHaveBeenCalledTimes(1);
    } finally {
      deserialize.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when the embedded path listing is corrupted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-listing-fb-'));
    try {
      await persistParsedFileChunk(dir, 'ok', [makeParsedFile('a.c')]);
      const dest = path.join(getParsedFileStoreDir(dir), 'ok.v8');
      const buf = await readFile(dest);
      const v8len = buf.readUInt16LE(14);
      const pathsOff = 16 + v8len + 12;
      buf[pathsOff] = 0;
      await writeFile(dest, buf);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c']));
      expect(loaded.has('a.c')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits a path listing when a filePath contains a newline and still loads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-listing-nl-'));
    const weird = 'weird\nname.c';
    const deserialize = vi.spyOn(v8, 'deserialize');
    try {
      await persistParsedFileChunk(dir, 'ok', [makeParsedFile(weird)]);
      expect(await readdir(getParsedFileStoreDir(dir))).toEqual(['ok.v8']);
      deserialize.mockClear();
      const loaded = await loadParsedFilesForPaths(dir, new Set(['unrelated.c']));
      expect(loaded.size).toBe(0);
      expect(deserialize).toHaveBeenCalledTimes(1);
      expect((await loadParsedFilesForPaths(dir, new Set([weird]))).has(weird)).toBe(true);
    } finally {
      deserialize.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rewrites a shard in place when the path listing is no longer safe', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-listing-rewrite-'));
    const weird = 'weird\nname.c';
    try {
      await persistParsedFileChunk(dir, 'ok', [makeParsedFile('safe.c')]);
      await persistParsedFileChunk(dir, 'ok', [makeParsedFile(weird)]);
      expect(await readdir(getParsedFileStoreDir(dir))).toEqual(['ok.v8']);
      const loaded = await loadParsedFilesForPaths(dir, new Set([weird, 'safe.c']));
      expect(loaded.has(weird)).toBe(true);
      expect(loaded.has('safe.c')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not forceGc on a small store (byte budget, not every 8 shards) (#3086)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-gc-'));
    const gc = vi.fn();
    const prev = parsedFileLoadGc.run;
    parsedFileLoadGc.run = gc;
    try {
      for (let i = 0; i < 16; i++) {
        await persistParsedFileChunk(dir, `s${i}`, [makeParsedFile(`f${i}.c`)]);
      }
      await loadParsedFilesForPaths(dir, new Set(Array.from({ length: 16 }, (_, i) => `f${i}.c`)));
      expect(gc).not.toHaveBeenCalled();
    } finally {
      parsedFileLoadGc.run = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forceGc when accumulated raw JSON bytes reach parsedFileLoadGc.byteBudget (#3086)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-gc-pos-'));
    const gc = vi.fn();
    const prevRun = parsedFileLoadGc.run;
    const prevBudget = parsedFileLoadGc.byteBudget;
    parsedFileLoadGc.run = gc;
    parsedFileLoadGc.byteBudget = 8;
    try {
      await persistParsedFileChunk(dir, 's0', [makeParsedFile('f0.c')]);
      await loadParsedFilesForPaths(dir, new Set(['f0.c']));
      expect(gc).toHaveBeenCalled();
    } finally {
      parsedFileLoadGc.run = prevRun;
      parsedFileLoadGc.byteBudget = prevBudget;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores a complete durable chunk into a stable run-store snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-durable-load-'));
    try {
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, 'abc', 1, 0, [makeParsedFile('a.c')]);
      expect(await durableChunkHasShards(dir, 'abc', new Set(['a.c']))).toBe(true);
      await rm(path.join(durable, 'abc'), { recursive: true, force: true });
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c']));
      expect(loaded.has('a.c')).toBe(true);
      expect(await readdir(getParsedFileStoreDir(dir))).toEqual(['abc-w1-0.v8']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a durable chunk with corrupt or incomplete shard coverage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-durable-partial-'));
    try {
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, 'abc', 1, 0, [makeParsedFile('a.c')]);
      persistDurableParsedFileShardSync(durable, 'abc', 2, 0, [makeParsedFile('b.c')]);
      await writeFile(path.join(durable, 'abc', 'abc-w2-0.v8'), Buffer.from([0, 1, 2]));

      expect(await durableChunkHasShards(dir, 'abc', new Set(['a.c', 'b.c']))).toBe(false);
      expect(await readdir(getParsedFileStoreDir(dir))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects valid durable shards that do not cover every indexed path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-durable-missing-'));
    try {
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, 'abc', 1, 0, [makeParsedFile('a.c')]);

      expect(await durableChunkHasShards(dir, 'abc', new Set(['a.c', 'b.c']))).toBe(false);
      expect(await readdir(getParsedFileStoreDir(dir))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('run-store shards overlay durable hits for the same path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-overlay-'));
    try {
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, 'abc', 1, 0, [makeParsedFile('a.c')]);
      expect(await durableChunkHasShards(dir, 'abc', new Set(['a.c']))).toBe(true);
      persistParsedFileShardSync(dir, 'w1-0', [makeParsedFile('other.c')]);
      persistParsedFileShardSync(dir, 'w1-1', [makeStoreEntry('a.c', { moduleScope: 'from-run' })]);
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c', 'other.c']));
      expect(loaded.get('a.c')?.moduleScope).toBe('from-run');
      expect(loaded.has('other.c')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clearParsedFileStore leaves the durable cache intact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-durable-keep-'));
    try {
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, 'abc', 1, 0, [makeParsedFile('a.c')]);
      const src = path.join(durable, 'abc', 'abc-w1-0.v8');
      const before = await readFile(src);
      persistParsedFileShardSync(dir, 'w1-0', [makeParsedFile('run.c')]);
      await clearParsedFileStore(dir);
      expect(await readFile(src)).toEqual(before);
      expect(await durableChunkHasShards(dir, 'abc', new Set(['a.c']))).toBe(true);
      expect((await loadParsedFilesForPaths(dir, new Set(['a.c']))).has('a.c')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips Maps and shared def identity through V8 (#3089)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-v8-id-'));
    try {
      const def = {
        nodeId: 'Function:a.c:fn',
        filePath: 'a.c',
        type: 'Function' as const,
        qualifiedName: 'fn',
      };
      const pf = makeParsedFile('a.c');
      (pf.localDefs as unknown as object[])[0] = def;
      (pf.scopes[0] as { ownedDefs: object[] }).ownedDefs = [def];
      await persistParsedFileChunk(dir, 'ok', [pf]);
      const loadedFile = (await loadParsedFilesForPaths(dir, new Set(['a.c']))).get('a.c');
      expect(loadedFile).toBeDefined();
      if (!loadedFile) return;
      expect(loadedFile.scopes[0].bindings).toBeInstanceOf(Map);
      expect(loadedFile.localDefs[0]).toBe(loadedFile.scopes[0].ownedDefs[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing or corrupt V8 shard as a miss with no JSON fallback', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-v8-miss-'));
    try {
      await persistParsedFileChunk(dir, 'gone', [makeParsedFile('a.c')]);
      await persistParsedFileChunk(dir, 'junk', [makeParsedFile('b.c')]);
      const storeDir = getParsedFileStoreDir(dir);
      await rm(path.join(storeDir, 'gone.v8'));
      await writeFile(path.join(storeDir, 'junk.v8'), Buffer.from([0, 1, 2, 3, 4]));
      const loaded = await loadParsedFilesForPaths(dir, new Set(['a.c', 'b.c']));
      expect(loaded.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the atomic V8 publish cannot replace the dest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pfstore-v8-blocked-'));
    try {
      const dest = path.join(getParsedFileStoreDir(dir), 'ok.v8');
      await nodeFsPromises.mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'occupied'), 'x', 'utf-8');
      expect(await persistParsedFileChunk(dir, 'ok', [makeParsedFile('a.c')])).toBe(false);
      expect((await loadParsedFilesForPaths(dir, new Set(['a.c']))).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
