import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { RelationshipType } from 'gitnexus-shared';
import { runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';

function edges(result: Awaited<ReturnType<typeof runPipelineFromRepo>>, type: RelationshipType) {
  return [...result.graph.iterRelationshipsByType(type)]
    .map((edge) => `${edge.sourceId}->${edge.targetId}`)
    .sort();
}

it('corrects only workspace-shadowed annotation plans and restores an explicit sole constructor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-workspace-proof-'));
  try {
    writeFixtureRepo(root, {
      'p/Repo.java': 'package p; @org.springframework.stereotype.Repository public class Repo {}',
      'p/Value.java': 'package p; public @interface Value {}',
      'p/RequiredArgsConstructor.java': 'package p; public @interface RequiredArgsConstructor {}',
      'p/Model.java': `package p; import lombok.*;
@org.springframework.stereotype.Service @Value class Model { Repo repo; }`,
      'p/Explicit.java': `package p; import lombok.Value;
@org.springframework.stereotype.Service @Value class Explicit { Repo repo; }`,
      'p/Getter.java': `package p; import lombok.*;
@org.springframework.stereotype.Service @Value @lombok.Getter class GetterModel { Repo repo; }`,
      'p/Ctor.java': `package p; import lombok.*;
@org.springframework.stereotype.Service @RequiredArgsConstructor class Ctor {
  Repo repo;
  Ctor(Repo repo) {}
}`,
      'q/lombok.java': 'package q; public class lombok { public @interface Value {} }',
      'q/Model.java': `package q;
@org.springframework.stereotype.Service @lombok.Value class Model { p.Repo repo; }`,
      'r/Model.java': `package r;
@org.springframework.stereotype.Service @lombok.Value class Model { p.Repo repo; }`,
      's/Base.java': 'package s; public class Base { public @interface Getter {} }',
      's/Model.java':
        'package s; import lombok.*; class Model extends Base { @Getter p.Repo repo; }',
      't/Model.java': `package t;
@org.springframework.stereotype.Service @lombok.Value class Model extends external.Base { p.Repo repo; }`,
      'u/Model.java': `package u; import lombok.Value;
@org.springframework.stereotype.Service @Value class Model { @interface Value {} p.Repo repo; }`,
    });
    const result = await runPipelineFromRepo(root, () => {}, {
      workerPoolSize: 1,
      skipDerivedGraphPhases: true,
    });
    const getters = [...result.graph.iterNodes()]
      .filter(
        (node) => node.properties.synthetic === 'lombok' && node.properties.name === 'getRepo',
      )
      .map((node) => node.id)
      .sort();
    expect(getters).toEqual([
      'Method:p/Explicit.java:Explicit.getRepo#0',
      'Method:p/Getter.java:GetterModel.getRepo#0',
      'Method:r/Model.java:Model.getRepo#0',
      'Method:t/Model.java:Model.getRepo#0',
      'Method:u/Model.java:Model.getRepo#0',
    ]);
    expect(edges(result, 'INJECTS')).toEqual([
      'Class:p/Ctor.java:Ctor->Class:p/Repo.java:Repo',
      'Class:p/Explicit.java:Explicit->Class:p/Repo.java:Repo',
      'Class:r/Model.java:Model->Class:p/Repo.java:Repo',
      'Class:t/Model.java:Model->Class:p/Repo.java:Repo',
      'Class:u/Model.java:Model->Class:p/Repo.java:Repo',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it('recomputes proof for an unchanged cached model when a package shadow is added and removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-shadow-replay-'));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-shadow-cache-'));
  try {
    writeFixtureRepo(root, {
      'p/Repo.java': 'package p; @org.springframework.stereotype.Repository public class Repo {}',
      'p/Model.java': `package p; import lombok.*;
@org.springframework.stereotype.Service @Value public class Model { Repo repo; }`,
    });
    const identity = await runtimeParseIdentity();
    const coldCache: ParseCache = {
      identity,
      entries: new Map(),
      usedKeys: new Set(),
      storagePath: storage,
      writeStoragePath: storage,
      onDiskKeys: new Set(),
    };
    const run = (parseCache: ParseCache) =>
      runPipelineFromRepo(root, () => {}, {
        workerPoolSize: 1,
        skipDerivedGraphPhases: true,
        parseCache,
      });
    const save = async (cache: ParseCache) => {
      pruneCache(cache, cache.usedKeys);
      const keys = await saveParseCache(storage, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        identity.base,
        new Set(keys),
      );
    };
    const hasGetter = (result: Awaited<ReturnType<typeof run>>) =>
      result.graph.getNode('Method:p/Model.java:Model.getRepo#0') !== undefined;
    const expectedInjection = ['Class:p/Model.java:Model->Class:p/Repo.java:Repo'];
    const cold = await run(coldCache);
    expect(cold.usedWorkerPool).toBe(true);
    expect(hasGetter(cold)).toBe(true);
    expect(edges(cold, 'INJECTS')).toEqual(expectedInjection);
    await save(coldCache);

    writeFixtureRepo(root, { 'p/Value.java': 'package p; public @interface Value {}' });
    const addedCache = await loadParseCache(storage, identity, storage);
    const added = await run(addedCache);
    expect(hasGetter(added)).toBe(false);
    expect(edges(added, 'INJECTS')).toEqual([]);
    await save(addedCache);
    const warm = await run(await loadParseCache(storage, identity, storage));
    expect(warm.usedWorkerPool).toBe(false);
    expect(hasGetter(warm)).toBe(false);
    expect(edges(warm, 'INJECTS')).toEqual([]);

    fs.unlinkSync(path.join(root, 'p/Value.java'));
    const removed = await run(await loadParseCache(storage, identity, storage));
    expect(removed.usedWorkerPool).toBe(false);
    expect(hasGetter(removed)).toBe(true);
    expect(edges(removed, 'INJECTS')).toEqual(expectedInjection);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  }
}, 120_000);
