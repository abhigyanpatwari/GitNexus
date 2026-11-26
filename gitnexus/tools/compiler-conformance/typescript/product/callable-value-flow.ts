import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import { describe, it } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, type PipelineOptions } from '../support/fixture.js';
import {
  loadParseCache,
  saveParseCache,
  type ParseCache,
} from '../../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../src/storage/parsedfile-store.js';
import { callableCallSiteLines, callsFrom } from '../../../../test/helpers/callable-flow.js';
const parseIdentity = await runtimeParseIdentity();
const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../../../../test/fixtures/typescript-callable-flow',
);
function analyze(project: string, options: PipelineOptions = {}) {
  return runPipelineFromRepo(path.join(fixtureRoot, project), () => {}, {
    skipGraphPhases: true,
    ...options,
  });
}
describe('TypeScript callable value flow', () => {
  it(
    'resolves assign → copy → argument → invoke from a Vue TypeScript script',
    { timeout: 90_000 },
    async () => {
      const result = await analyze('vue-script');
      expect(callsFrom(result, 'invoke')).toContainEqual({
        target: 'target',
        reason: 'callable-value-flow',
      });
    },
  );
  it('keeps template-first Vue source coordinates unverified', { timeout: 90_000 }, async () => {
    const result = await analyze('vue-template');
    expect(result.relationshipIntegrity?.unverifiedEdges).toBeGreaterThan(0);
    expect(result.relationshipIntegrity?.checkedSites).toBe(0);
  });

  it(
    'resolves TypeScript callable assignment, copy, and actual-to-formal invocation',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('assignment');

      expect(callsFrom(result, 'main.ts')).toEqual(
        expect.arrayContaining([
          { target: 'target', reason: 'callable-value-flow' },
          expect.objectContaining({ target: 'outer' }),
        ]),
      );
      expect(callsFrom(result, 'invoke')).toContainEqual({
        target: 'target',
        reason: 'callable-value-flow',
      });
    },
  );

  it(
    'propagates an imported callable through a cross-file wrapper without selecting a decoy',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('imported');

      const edge = getRelationships(result, 'CALLS').find(
        (candidate) =>
          candidate.source === 'invoke' &&
          candidate.target === 'target' &&
          candidate.rel.reason === 'callable-value-flow',
      );
      expect(edge).toBeDefined();
      expect(edge!.sourceFilePath).toBe('wrapper.ts');
      expect(edge!.targetFilePath).toBe('target.ts');
      expect(
        getRelationships(result, 'CALLS').some(
          (candidate) => candidate.source === 'invoke' && candidate.targetFilePath === 'decoy.ts',
        ),
      ).toBe(false);
    },
  );

  it(
    'resolves a bound method assigned to a variable and passed into a wrapper',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('bound-method');

      const edge = getRelationships(result, 'CALLS').find(
        (candidate) =>
          candidate.source === 'invoke' &&
          candidate.target === 'run' &&
          candidate.rel.reason === 'callable-value-flow',
      );
      expect(edge).toBeDefined();
      expect(edge!.targetLabel).toBe('Method');
      expect(edge!.rel.targetId).toContain('Worker.run');
    },
  );

  it(
    'does not reinterpret call results passed as arguments as callable designators',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('factory-argument');

      expect(callableCallSiteLines(result, 'invoke', 'target')).toEqual([]);
      expect(callableCallSiteLines(result, 'invoke', 'factory')).toEqual([]);
    },
  );

  it(
    'keeps a direct call outside a nested same-name callable binding on ordinary resolution',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('block-shadow');

      expect(
        getRelationships(result, 'CALLS').some(
          (edge) => edge.source === 'entry' && edge.target === 'target',
        ),
      ).toBe(true);
      expect(callableCallSiteLines(result, 'entry', 'replacement')).toEqual([8]);
    },
  );

  it(
    'terminates copy cycles and preserves the reachable callable target',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('copy-cycle');

      expect(callsFrom(result, 'main.ts')).toContainEqual({
        target: 'target',
        reason: 'callable-value-flow',
      });
    },
  );

  it(
    'does not treat a callable invocation result as the callable itself',
    { timeout: 60_000 },
    async () => {
      const result = await analyze('non-callable-result');

      expect(callsFrom(result, 'main.ts')).not.toContainEqual({
        target: 'target',
        reason: 'callable-value-flow',
      });
    },
  );

  it(
    'replays identical callable-flow semantics from the durable warm parse cache',
    { timeout: 120_000 },
    async () => {
      const root = path.join(fixtureRoot, 'cache-and-pdg');
      const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-warm-store-'));
      try {
        const coldCache: ParseCache = {
          identity: parseIdentity,
          entries: new Map(),
          usedKeys: new Set(),
          storagePath: storage,
          writeStoragePath: storage,
          onDiskKeys: new Set(),
        };
        const cold = await runPipelineFromRepo(root, () => {}, {
          skipGraphPhases: true,
          parseCache: coldCache,
        });
        const savedKeys = await saveParseCache(storage, coldCache);
        await pruneAndSaveDurableParsedFileStore(
          getDurableParsedFileDir(storage),
          parseIdentity.base,
          new Set(savedKeys),
        );
        const warmCache = await loadParseCache(storage, parseIdentity, storage);
        const warm = await runPipelineFromRepo(root, () => {}, {
          skipGraphPhases: true,
          parseCache: warmCache,
        });
        const project = (result: Awaited<ReturnType<typeof analyze>>) =>
          getRelationships(result, 'CALLS')
            .filter((edge) => edge.rel.reason === 'callable-value-flow')
            .map(
              (edge) =>
                `${edge.sourceFilePath}:${edge.source}->${edge.targetFilePath}:${edge.target}`,
            )
            .sort();
        expect(project(warm)).toEqual(project(cold));
        expect(project(warm)).toEqual(['main.ts:invoke->main.ts:target']);
      } finally {
        fs.rmSync(storage, { recursive: true, force: true });
      }
    },
  );

  it(
    'keeps normal/PDG targets identical and stamps calleeIds at the indirect invocation',
    { timeout: 90_000 },
    async () => {
      const normal = await analyze('cache-and-pdg');
      const pdg = await analyze('cache-and-pdg', { pdg: true });
      const project = (result: Awaited<ReturnType<typeof analyze>>) =>
        callsFrom(result, 'invoke')
          .filter((edge) => edge.reason === 'callable-value-flow')
          .map((edge) => edge.target)
          .sort();
      expect(project(pdg)).toEqual(project(normal));
      expect(project(pdg)).toEqual(['target']);

      const matchingBlocks: Array<Record<string, unknown>> = [];
      pdg.graph.forEachNode((node) => {
        if (
          node.label === 'BasicBlock' &&
          typeof node.properties.text === 'string' &&
          node.properties.text.includes('callback()')
        ) {
          matchingBlocks.push(node.properties);
        }
      });
      expect(matchingBlocks).not.toHaveLength(0);
      expect(
        matchingBlocks.some(
          (properties) =>
            typeof properties.calleeIds === 'string' && properties.calleeIds.includes('target'),
        ),
      ).toBe(true);
    },
  );
});
