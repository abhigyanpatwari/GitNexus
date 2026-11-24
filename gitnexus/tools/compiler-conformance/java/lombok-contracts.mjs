import { compareCodeUnits } from '../compare.mjs';
import { copyResolutionProject } from './graph-observations.mjs';
import assert from 'node:assert/strict';
import { runtimeParseIdentity } from './spring-support.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeFixtureRepo,
  runPipelineFromRepo,
  getRelationships,
  getNodesByLabelFull,
  getResolutionOutcomes,
} from './graph-observations.mjs';
import { loadParseCache, pruneCache, saveParseCache } from '../../../dist/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../dist/storage/parsedfile-store.js';
const parseIdentity = await runtimeParseIdentity();
function projectLombokMethods(result) {
  return [...result.graph.iterNodes()]
    .filter((n) => n.label === 'Method' && n.properties.synthetic === 'lombok')
    .map(
      (n) =>
        `${n.id}|${n.properties.qualifiedName}|${n.properties.name}|${n.properties.parameterCount}|${n.properties.returnType}|${n.properties.visibility}`,
    )
    .sort(compareCodeUnits);
}
function projectCallsToGetName(result) {
  return getRelationships(result, 'CALLS')
    .filter((e) => e.target === 'getName')
    .map((e) => `${e.source}->${e.target}@${e.targetFilePath}`)
    .sort(compareCodeUnits);
}
async function verifyJavaLombokAccessorSynthesisPipeline() {
  // keeps an inherited synthetic setter in the overload family when its formal types are unavailable
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-overload-'));
    try {
      copyResolutionProject(root, 'lombok-inherited-setter');
      const linked = await runPipelineFromRepo(root, () => {});
      assert.deepEqual(
        getRelationships(linked, 'CALLS').filter(
          (edge) => edge.source === 'choose' && edge.target === 'setValue',
        ),
        [],
      );
      assert.ok(
        getResolutionOutcomes(linked).some(
          (item) =>
            item?.kind === 'suppressed' &&
            item?.reason === 'overload-unknown' &&
            item?.name === 'setValue' &&
            item?.candidateGraphIds.some(
              (item) => item === 'Method:Inheritance.java:GeneratedBase.setValue#1',
            ) &&
            item?.candidateGraphIds.some(
              (item) => item === 'Method:Inheritance.java:GeneratedChild.setValue#1',
            ) &&
            item?.candidateSetComplete === true,
        ),
      );
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // Getters and setters resolve to their owner in both same-file and cross-file layouts.
  for (const layout of ['same-file', 'cross-file']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-pair-'));
    try {
      const models = `import lombok.Data;
@Data class Pair { private int first, second; }
@Data class Decoy { private int first, second; }
`;
      const caller = `class Consumer {
  void update(Pair pair) {
    pair.setFirst(pair.getSecond());
    pair.setSecond(pair.getFirst());
  }
}
`;
      writeFixtureRepo(
        root,
        layout === 'same-file'
          ? {
              'Models.java': models + caller,
            }
          : {
              'Models.java': models,
              'Consumer.java': caller,
            },
      );
      const linked = await runPipelineFromRepo(root, () => {});
      const calls = getRelationships(linked, 'CALLS').filter((edge) => edge.source === 'update');
      assert.deepEqual(calls.map((edge) => edge.rel.targetId).sort(compareCodeUnits), [
        'Method:Models.java:Pair.getFirst#0',
        'Method:Models.java:Pair.getSecond#0',
        'Method:Models.java:Pair.setFirst#1',
        'Method:Models.java:Pair.setSecond#1',
      ]);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // resolves Consumer.consume -> User.getName for @Data
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-'));
    try {
      copyResolutionProject(root, 'lombok-data-call');
      const linked = await runPipelineFromRepo(root, () => {});
      const methods = getNodesByLabelFull(linked, 'Method');
      const getName = methods.find(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('LombokUser.java'),
      );
      assert.notEqual(getName, undefined);
      assert.partialDeepStrictEqual(getName?.properties, {
        parameterCount: 0,
        returnType: 'String',
        synthetic: 'lombok',
        visibility: 'public',
        qualifiedName: 'User.getName',
      });
      const hasMethod = getRelationships(linked, 'HAS_METHOD').filter(
        (e) => e.source === 'User' && e.target === 'getName',
      );
      assert.ok(hasMethod.length >= 1);
      const calls = getRelationships(linked, 'CALLS').filter(
        (e) => e.source === 'consume' && e.target === 'getName',
      );
      assert.equal(
        calls.some((e) => e.targetFilePath.endsWith('LombokUser.java')),
        true,
      );
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // Kotlin caller of Java getName(): synthetic Method exists; CALLS blocked by pre-existing JVM interop
  {
    const lombokRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-lombok-'));
    const handRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-hand-'));
    try {
      copyResolutionProject(lombokRoot, 'kotlin-lombok-accessor');
      copyResolutionProject(handRoot, 'kotlin-handwritten-accessor');
      const lombok = await runPipelineFromRepo(lombokRoot, () => {});
      const hand = await runPipelineFromRepo(handRoot, () => {});
      const lombokGetName = getNodesByLabelFull(lombok, 'Method').filter(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('User.java'),
      );
      assert.equal(lombokGetName.length, 1);
      assert.equal(lombokGetName[0]?.properties.synthetic, 'lombok');
      assert.equal(lombokGetName[0]?.properties.qualifiedName, 'User.getName');
      const handGetName = getNodesByLabelFull(hand, 'Method').filter(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('User.java'),
      );
      assert.equal(handGetName.length, 1);
      assert.equal(handGetName[0]?.properties.synthetic, undefined);
      assert.deepEqual(projectCallsToGetName(lombok), []);
      assert.deepEqual(projectCallsToGetName(hand), []);
      assert.equal(
        getRelationships(lombok, 'CALLS').some((e) => e.source === 'run' && e.target === 'getUser'),
        true,
      );
    } finally {
      fs.rmSync(lombokRoot, {
        recursive: true,
        force: true,
      });
      fs.rmSync(handRoot, {
        recursive: true,
        force: true,
      });
    }
  }
  // cold parse, warm replay (byte-identical Method ids), and incompatible historical cache miss
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-cache-repo-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-cache-store-'));
    try {
      copyResolutionProject(root, 'lombok-cache');
      const coldCache = {
        identity: parseIdentity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        writeStoragePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: coldCache,
      });
      assert.equal(cold.usedWorkerPool, true);
      const coldMethods = projectLombokMethods(cold);
      assert.equal(
        coldMethods.some((m) => m.includes('|User.getName|getName|')),
        true,
      );
      assert.equal(
        projectCallsToGetName(cold).some((c) => c.startsWith('consume->getName@')),
        true,
      );
      pruneCache(coldCache, coldCache.usedKeys);
      const savedKeys = await saveParseCache(storage, coldCache);
      assert.ok(savedKeys.length > 0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        parseIdentity.base,
        new Set(savedKeys),
      );
      const warmCache = await loadParseCache(storage, parseIdentity, storage);
      assert.deepEqual(warmCache.onDiskKeys, new Set(savedKeys));
      const warm = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: warmCache,
      });
      assert.equal(warm.usedWorkerPool, false);
      assert.deepEqual(projectLombokMethods(warm), coldMethods);
      assert.deepEqual(projectCallsToGetName(warm), projectCallsToGetName(cold));
      const indexPath = path.join(storage, 'parse-cache', 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index.version = '82+0.0.0-historical';
      fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
      const historical = await loadParseCache(storage, parseIdentity, storage);
      assert.equal(historical.entries.size, 0);
      assert.equal(historical.onDiskKeys?.size ?? 0, 0);
      const recoveredCache = {
        identity: parseIdentity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        writeStoragePath: storage,
        onDiskKeys: new Set(),
      };
      const recovered = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: recoveredCache,
      });
      assert.equal(recovered.usedWorkerPool, true);
      assert.deepEqual(projectLombokMethods(recovered), coldMethods);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
      fs.rmSync(storage, {
        recursive: true,
        force: true,
      });
    }
  }
}
export async function checkLombokContracts() {
  await verifyJavaLombokAccessorSynthesisPipeline();
}
