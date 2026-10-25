import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  closeLbug,
  executeQuery,
  initLbug,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  loadParseCacheChunk,
  pruneCache,
  saveParseCache,
} from '../../src/storage/parse-cache.js';
import {
  clearParsedFileStore,
  durableChunkHasShards,
  getDurableParsedFileDir,
  loadDurableParsedFileIndex,
  loadParsedFilesForPaths,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import { createTempDir } from '../helpers/test-db.js';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';
import { findDanglingEdges } from './resolvers/helpers.js';

describe('named class-expression owners through the real parse worker', () => {
  it.each(['ts', 'tsx', 'js', 'mjs'])(
    'resolves a declaration shadowing an outer class inside an expression in .%s',
    async (extension) => {
      const temp = await createTempDir();
      try {
        await fs.writeFile(
          path.join(temp.dbPath, `shadow.${extension}`),
          'class Local {} const A = class Outer { m() { class Local {} return new Local(); } };',
        );
        const result = await runPipelineFromRepo(temp.dbPath, () => {}, { workerPoolSize: 1 });
        const locals = result.graph.nodes.filter(
          (node) => node.label === 'Class' && node.properties.name === 'Local',
        );
        expect(locals).toHaveLength(2);
        const inner = locals.find((node) => node.id.includes('.Local'))!;
        expect(inner).toBeDefined();
        const method = result.graph.nodes.find(
          (node) => node.label === 'Method' && node.properties.name === 'm',
        )!;
        const calls = result.graph.relationships.filter(
          (edge) => edge.type === 'CALLS' && edge.sourceId === method.id,
        );
        expect(calls.map((edge) => edge.targetId)).toEqual([inner.id]);
      } finally {
        await temp.cleanup();
      }
    },
  );
  it.each(['jsx', 'vue'])('preserves owners for the shared .%s provider', async (extension) => {
    const source = 'const X = class Named { status = 500; run() { return this.status; } };';
    const { graph } = await parseFilesWithWorkers([
      {
        path: `shared.${extension}`,
        content: extension === 'vue' ? `<script setup lang="ts">\n${source}\n</script>` : source,
      },
    ]);
    const owner = graph.nodes.find(
      (node) => node.label === 'Class' && node.properties.name === 'Named',
    );
    expect(owner).toBeDefined();
    const edges = graph.relationships.filter(
      (edge) =>
        edge.sourceId === owner!.id && (edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY'),
    );
    expect(edges.map((edge) => graph.getNode(edge.targetId)?.properties.name).sort()).toEqual([
      'run',
      'status',
    ]);
  });

  it.each(['ts', 'js'])(
    'keeps declaration and anonymous-expression controls in .%s',
    async (extension) => {
      const { graph } = await parseFilesWithWorkers([
        {
          path: `control.${extension}`,
          content:
            'class Control { status = 1; run() {} } const Anonymous = class { value = 2; method() {} };',
        },
      ]);
      expect(
        graph.nodes.filter((node) => node.label === 'Class').map((node) => node.properties.name),
      ).toEqual(['Control']);
      const owner = graph.getNode(`Class:control.${extension}:Control`);
      expect(owner).toBeDefined();
      const edges = graph.relationships.filter((edge) => edge.sourceId === owner!.id);
      expect(edges.map((edge) => graph.getNode(edge.targetId)?.properties.name).sort()).toEqual([
        'run',
        'status',
      ]);
    },
  );
  it.each(['ts', 'tsx', 'js', 'mjs'])(
    'retains the class and its members in .%s',
    async (extension) => {
      const { graph } = await parseFilesWithWorkers([
        {
          path: `mock.${extension}`,
          content: `vi.mock('api', () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    messageForUser() { return 'Failed'; }
  },
}));`,
        },
      ]);
      const owner = graph.nodes.find(
        (node) => node.label === 'Class' && node.properties.name === 'ApiError',
      );
      expect(owner).toBeDefined();
      expect(owner!.properties).toMatchObject({
        filePath: `mock.${extension}`,
        startLine: 1,
        endLine: 4,
      });
      const edges = graph.relationships.filter(
        (edge) => edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY',
      );
      expect(edges).toHaveLength(2);
      expect(edges.map((edge) => graph.getNode(edge.targetId)?.properties.name).sort()).toEqual([
        'messageForUser',
        'status',
      ]);
      expect(
        graph.nodes.find((node) => node.properties.name === 'messageForUser')!.properties
          .parameterCount,
      ).toBe(0);
      expect(
        graph.nodes.find((node) => node.properties.name === 'status')!.properties.isStatic,
      ).toBe(false);
      for (const edge of edges) {
        expect(edge.sourceId).toBe(owner!.id);
        expect(graph.getNode(edge.sourceId)).toBeDefined();
        expect(graph.getNode(edge.targetId)).toBeDefined();
      }
    },
  );

  it('retains a TypeScript constructor parameter property on its expression owner', async () => {
    const { graph } = await parseFilesWithWorkers([
      {
        path: 'parameter.ts',
        content: `vi.mock('api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number) { super('HTTP ' + status); }
  },
}));`,
      },
    ]);
    const owner = graph.nodes.find(
      (node) => node.label === 'Class' && node.properties.name === 'ApiError',
    );
    expect(owner).toBeDefined();
    const property = graph.nodes.find(
      (node) => node.label === 'Property' && node.properties.name === 'status',
    );
    expect(property).toBeDefined();
    expect(property!.id).toBe('Property:parameter.ts:ApiError@1:12.status');
    expect(graph.relationships).toContainEqual(
      expect.objectContaining({
        type: 'HAS_PROPERTY',
        sourceId: owner!.id,
        targetId: property!.id,
      }),
    );
    for (const edge of graph.relationships.filter(
      (edge) => edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY',
    )) {
      expect(graph.getNode(edge.sourceId)).toBeDefined();
      expect(graph.getNode(edge.targetId)).toBeDefined();
    }
  });

  it.each(['ts', 'tsx', 'js', 'mjs'])(
    'keeps nested expression members distinct from declarations in .%s',
    async (extension) => {
      const { graph } = await parseFilesWithWorkers([
        {
          path: `nested.${extension}`,
          content: `class ApiError { status = 200; messageForUser() { return 'outer'; } }
class Holder {
  nested = class ApiError { status = 500; messageForUser() { return 'inner'; } };
}`,
        },
      ]);
      const owners = graph.nodes.filter(
        (node) => node.label === 'Class' && node.properties.name === 'ApiError',
      );
      expect(owners).toHaveLength(2);
      expect(new Set(owners.map((node) => node.id)).size).toBe(2);
      const memberIds = new Set<string>();
      for (const owner of owners) {
        const edges = graph.relationships.filter(
          (edge) =>
            edge.sourceId === owner.id &&
            (edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY'),
        );
        expect(edges.map((edge) => graph.getNode(edge.targetId)?.properties.name).sort()).toEqual([
          'messageForUser',
          'status',
        ]);
        edges.forEach((edge) => memberIds.add(edge.targetId));
      }
      expect(memberIds.size).toBe(4);
      for (const edge of graph.relationships.filter(
        (edge) => edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY',
      )) {
        expect(graph.getNode(edge.sourceId)).toBeDefined();
        expect(graph.getNode(edge.targetId)).toBeDefined();
      }
    },
  );

  it.each(['ts', 'tsx', 'js', 'mjs'])(
    'distinguishes same-named expressions in sibling methods in .%s',
    async (extension) => {
      const { graph } = await parseFilesWithWorkers([
        {
          path: `siblings.${extension}`,
          content: `class Holder {
  first() { return class Local { status = 1; run() {} }; }
  second() { return class Local { status = 2; run() {} }; }
}`,
        },
      ]);
      const owners = graph.nodes.filter(
        (node) => node.label === 'Class' && node.properties.name === 'Local',
      );
      expect(owners).toHaveLength(2);
      const targets = new Set<string>();
      for (const owner of owners) {
        const edges = graph.relationships.filter(
          (edge) =>
            edge.sourceId === owner.id &&
            (edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY'),
        );
        expect(edges.map((edge) => graph.getNode(edge.targetId)?.properties.name).sort()).toEqual([
          'run',
          'status',
        ]);
        for (const edge of edges) {
          targets.add(edge.targetId);
          const member = graph.getNode(edge.targetId)!;
          expect(member.properties.startLine).toBe(owner.properties.startLine);
        }
      }
      expect(targets.size).toBe(4);
    },
  );

  it.each(['ts', 'tsx', 'js', 'mjs'])(
    'resolves expression members and keeps self names internal in .%s',
    async (extension) => {
      const temp = await createTempDir();
      try {
        await fs.writeFile(
          path.join(temp.dbPath, `self.${extension}`),
          `class Holder { child = class Child { p=1; m(){return this.p;} }; }
const X = class Named { static s() {} m() { Named.s(); } };
Named.s();`,
        );
        const result = await runPipelineFromRepo(temp.dbPath, () => {}, { workerPoolSize: 1 });
        const member = (ownerName: string, memberName: string) => {
          const owner = result.graph.nodes.find(
            (node) => node.label === 'Class' && node.properties.name === ownerName,
          )!;
          expect(owner).toBeDefined();
          const edge = result.graph.relationships.find(
            (edge) =>
              edge.sourceId === owner.id &&
              (edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY') &&
              result.graph.getNode(edge.targetId)?.properties.name === memberName,
          );
          expect(edge).toBeDefined();
          return edge!.targetId;
        };
        expect(result.graph.relationships).toContainEqual(
          expect.objectContaining({
            type: 'ACCESSES',
            sourceId: member('Child', 'm'),
            targetId: member('Child', 'p'),
          }),
        );
        const staticId = member('Named', 's');
        const calls = result.graph.relationships.filter(
          (edge) => edge.type === 'CALLS' && edge.targetId === staticId,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]!.sourceId).toBe(member('Named', 'm'));
        expect(
          findDanglingEdges(result, ['HAS_METHOD', 'HAS_PROPERTY', 'CALLS', 'ACCESSES']),
        ).toEqual([]);
      } finally {
        await temp.cleanup();
      }
    },
  );

  it('preserves owners through the full pipeline, both durable caches, and native COPY', async () => {
    const temp = await createTempDir();
    const repo = path.join(temp.dbPath, 'repo');
    const storage = path.join(temp.dbPath, 'storage');
    const identity = await runtimeParseIdentity();
    const extensions = ['ts', 'tsx', 'js', 'mjs'];
    const source = `class ApiError { status = 200; messageForUser() { return 'outer'; } }
vi.mock('api', () => ({
  ApiError: class MockError extends Error { status = 500; messageForUser() { return 'mock'; } },
}));
class Holder {
  nested = class ApiError { status = 501; messageForUser() { return 'inner'; } };
}`;
    try {
      await fs.mkdir(repo);
      for (const extension of extensions)
        await fs.writeFile(path.join(repo, `mock.${extension}`), source);
      const coldCache = await loadParseCache(storage, identity, storage);
      const cold = await runPipelineFromRepo(repo, () => {}, {
        workerPoolSize: 1,
        parseCache: coldCache,
      });
      expect(cold.usedWorkerPool).toBe(true);
      expect(cold.reparsedFileCount).toBe(4);
      expect(cold.parseCacheHitFileCount).toBe(0);
      expect(cold.scopeExtractionFailures).toEqual([]);

      const assertOwners = (result: typeof cold) => {
        expect(findDanglingEdges(result, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);
        for (const extension of extensions) {
          for (const name of ['ApiError', 'MockError@2:12', 'Holder.ApiError@5:11']) {
            const ownerId = `Class:mock.${extension}:${name}`;
            expect(result.graph.getNode(ownerId)).toBeDefined();
            const edges = result.graph.relationships.filter(
              (edge) =>
                edge.sourceId === ownerId &&
                (edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY'),
            );
            expect(
              edges.map((edge) => result.graph.getNode(edge.targetId)?.properties.name).sort(),
            ).toEqual(['messageForUser', 'status']);
            expect(edges.map((edge) => edge.targetId).sort()).toEqual([
              `Method:mock.${extension}:${name}.messageForUser#0`,
              `Property:mock.${extension}:${name}.status`,
            ]);
          }
        }
      };
      assertOwners(cold);
      pruneCache(coldCache, coldCache.usedKeys);
      const keys = await saveParseCache(storage, coldCache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        identity.base,
        new Set(keys),
      );
      await clearParsedFileStore(storage);
      const durable = await loadDurableParsedFileIndex(
        getDurableParsedFileDir(storage),
        identity.base,
      );
      for (const [key, wanted] of durable)
        expect(await durableChunkHasShards(storage, key, wanted)).toBe(true);
      const paths = new Set([...durable.values()].flatMap((paths) => [...paths]));
      expect([...paths].sort()).toEqual(extensions.map((extension) => `mock.${extension}`).sort());
      const parsed = await loadParsedFilesForPaths(storage, paths);
      expect(parsed.size).toBe(4);
      for (const file of parsed.values()) {
        expect(file.scopes.filter((scope) => scope.kind === 'Class')).toHaveLength(4);
        expect(
          file.localDefs
            .filter((definition) => definition.type === 'Property')
            .map((definition) => definition.qualifiedName)
            .sort(),
        ).toEqual([
          'ApiError.status',
          'Holder.ApiError@5:11.status',
          'Holder.nested',
          'MockError@2:12.status',
        ]);
      }

      const warmCache = await loadParseCache(storage, identity, storage);
      const chunks = await Promise.all(
        [...warmCache.onDiskKeys!].map((key) => loadParseCacheChunk(warmCache, key)),
      );
      expect(chunks.length).toBeGreaterThan(0);
      // ParsedFiles must come from their durable shards, not worker-result chunks.
      expect(
        chunks.flatMap((chunk) => chunk ?? []).flatMap((part) => part.parsedFiles ?? []),
      ).toEqual([]);
      const warm = await runPipelineFromRepo(repo, () => {}, {
        workerPoolSize: 1,
        parseCache: warmCache,
      });
      expect(warm.usedWorkerPool).toBe(false);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(4);
      expect(warm.scopeExtractionFailures).toEqual([]);
      assertOwners(warm);
      const members = (result: typeof cold) =>
        result.graph.relationships
          .filter((edge) => edge.type === 'HAS_METHOD' || edge.type === 'HAS_PROPERTY')
          .map((edge) => `${edge.type}:${edge.sourceId}->${edge.targetId}`)
          .sort();
      expect(members(warm)).toEqual(members(cold));

      await initLbug(path.join(temp.dbPath, 'lbug'), { skipFts: true });
      const loaded = await loadGraphToLbug(warm.graph, repo, storage);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.skippedRels).toBe(0);
      const rows = await executeQuery(
        "MATCH (c:Class)-[r:CodeRelation]->(m) WHERE r.type IN ['HAS_METHOD', 'HAS_PROPERTY'] RETURN c.id AS owner, m.id AS member, r.type AS type",
      );
      expect(rows.map((row) => `${row.type}:${row.owner}->${row.member}`).sort()).toEqual(
        members(warm),
      );
      const classes = await executeQuery('MATCH (c:Class) RETURN c.id AS id');
      expect(classes).toHaveLength(16);
    } finally {
      await closeLbug();
      await clearParsedFileStore(storage);
      await temp.cleanup();
    }
  }, 120000);
});
