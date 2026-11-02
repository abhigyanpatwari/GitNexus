import { runtimeParseIdentity } from '../../helpers/runtime-parse-identity.js';
/**
 * Production-path Lombok accessor synthesis: Method nodes, HAS_METHOD, and CALLS
 * through the real worker/provider pipeline (not unit synthesizer alone).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  writeFixtureRepo,
  runPipelineFromRepo,
  getRelationships,
  getNodesByLabelFull,
  getResolutionOutcomes,
} from './helpers.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';

const parseIdentity = await runtimeParseIdentity();

function projectLombokMethods(result: Awaited<ReturnType<typeof runPipelineFromRepo>>) {
  return [...result.graph.iterNodes()]
    .filter((n) => n.label === 'Method' && n.properties.synthetic === 'lombok')
    .map(
      (n) =>
        `${n.id}|${n.properties.qualifiedName}|${n.properties.name}|${n.properties.parameterCount}|${n.properties.returnType}|${n.properties.visibility}`,
    )
    .sort();
}

function projectCallsToGetName(result: Awaited<ReturnType<typeof runPipelineFromRepo>>) {
  return getRelationships(result, 'CALLS')
    .filter((e) => e.target === 'getName')
    .map((e) => `${e.source}->${e.target}@${e.targetFilePath}`)
    .sort();
}

describe('Java Lombok accessor synthesis (pipeline)', () => {
  it('keeps an inherited synthetic setter in the overload family when its formal types are unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-overload-'));
    try {
      writeFixtureRepo(root, {
        'Inheritance.java': `import lombok.Data;
@Data class GeneratedBase { private String value; }
class GeneratedChild extends GeneratedBase { public void setValue(Object value) {} }
class Consumer { void choose(GeneratedChild target) { target.setValue("x"); } }
`,
      });
      const linked = await runPipelineFromRepo(root, () => {});
      expect(
        getRelationships(linked, 'CALLS').filter(
          (edge) => edge.source === 'choose' && edge.target === 'setValue',
        ),
      ).toEqual([]);
      expect(getResolutionOutcomes(linked)).toContainEqual(
        expect.objectContaining({
          kind: 'suppressed',
          reason: 'overload-unknown',
          name: 'setValue',
          candidateGraphIds: expect.arrayContaining([
            'Method:Inheritance.java:GeneratedBase.setValue#1',
            'Method:Inheritance.java:GeneratedChild.setValue#1',
          ]),
          candidateSetComplete: true,
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it.each(['same-file', 'cross-file'] as const)(
    'resolves all getter and setter calls to their owner in a %s fixture',
    async (layout) => {
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
            ? { 'Models.java': models + caller }
            : { 'Models.java': models, 'Consumer.java': caller },
        );
        const linked = await runPipelineFromRepo(root, () => {});
        const calls = getRelationships(linked, 'CALLS').filter((edge) => edge.source === 'update');
        expect(calls.map((edge) => edge.rel.targetId).sort()).toEqual([
          'Method:Models.java:Pair.getFirst#0',
          'Method:Models.java:Pair.getSecond#0',
          'Method:Models.java:Pair.setFirst#1',
          'Method:Models.java:Pair.setSecond#1',
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    60000,
  );

  it('resolves Consumer.consume -> User.getName for @Data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-'));
    try {
      writeFixtureRepo(root, {
        'LombokUser.java': `import lombok.Data;
@Data
class User {
  private String name;
}
class Consumer {
  String consume(User user) {
    return user.getName();
  }
}
`,
      });

      const linked = await runPipelineFromRepo(root, () => {});
      const methods = getNodesByLabelFull(linked, 'Method');
      const getName = methods.find(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('LombokUser.java'),
      );
      expect(getName).toBeDefined();
      expect(getName?.properties).toMatchObject({
        parameterCount: 0,
        returnType: 'String',
        synthetic: 'lombok',
        visibility: 'public',
        qualifiedName: 'User.getName',
      });

      const hasMethod = getRelationships(linked, 'HAS_METHOD').filter(
        (e) => e.source === 'User' && e.target === 'getName',
      );
      expect(hasMethod.length).toBeGreaterThanOrEqual(1);

      const calls = getRelationships(linked, 'CALLS').filter(
        (e) => e.source === 'consume' && e.target === 'getName',
      );
      expect(calls.some((e) => e.targetFilePath.endsWith('LombokUser.java'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('Kotlin caller of Java getName(): synthetic Method exists; CALLS blocked by pre-existing JVM interop', async () => {
    // Control: hand-written Java getName is also unreachable from Kotlin callers
    // in this pipeline (Kotlin→Kotlin member CALLS work; Kotlin→Java do not).
    // Lombok must not invent a second interop feature — only prove the Method
    // node Java callers already resolve is present for Kotlin to target later.
    const lombokRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-lombok-'));
    const handRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-hand-'));
    try {
      writeFixtureRepo(lombokRoot, {
        'models/User.java': `package models;
import lombok.Data;
@Data
public class User {
  private String name;
  public void save() {}
}
`,
        'models/Factory.kt': `package models
fun getUser(): User = User()
`,
        'app/App.kt': `package app
import models.getUser
class App {
  fun run() {
    val u = getUser()
    u.save()
    u.getName()
  }
}
`,
      });
      writeFixtureRepo(handRoot, {
        'models/User.java': `package models;
public class User {
  private String name;
  public String getName() { return name; }
  public void save() {}
}
`,
        'models/Factory.kt': `package models
fun getUser(): User = User()
`,
        'app/App.kt': `package app
import models.getUser
class App {
  fun run() {
    val u = getUser()
    u.save()
    u.getName()
  }
}
`,
      });

      const lombok = await runPipelineFromRepo(lombokRoot, () => {});
      const hand = await runPipelineFromRepo(handRoot, () => {});

      const lombokGetName = getNodesByLabelFull(lombok, 'Method').filter(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('User.java'),
      );
      expect(lombokGetName).toHaveLength(1);
      expect(lombokGetName[0]?.properties.synthetic).toBe('lombok');
      expect(lombokGetName[0]?.properties.qualifiedName).toBe('User.getName');

      const handGetName = getNodesByLabelFull(hand, 'Method').filter(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('User.java'),
      );
      expect(handGetName).toHaveLength(1);
      expect(handGetName[0]?.properties.synthetic).toBeUndefined();

      // Pre-existing gap: Kotlin resolves getUser (Kotlin) but not Java members.
      expect(projectCallsToGetName(lombok)).toEqual([]);
      expect(projectCallsToGetName(hand)).toEqual([]);
      expect(
        getRelationships(lombok, 'CALLS').some((e) => e.source === 'run' && e.target === 'getUser'),
      ).toBe(true);

      // Document: Kotlin property read `user.name` is ACCESSES on the field
      // Property, not a JavaBeans getter lowering. Not asserted as CALLS.
    } finally {
      fs.rmSync(lombokRoot, { recursive: true, force: true });
      fs.rmSync(handRoot, { recursive: true, force: true });
    }
  }, 120000);

  it('cold parse, warm replay (byte-identical Method ids), and incompatible historical cache miss', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-cache-repo-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-cache-store-'));
    try {
      writeFixtureRepo(root, {
        'LombokUser.java': `import lombok.Data;
@Data
class User {
  private String name;
}
class Consumer {
  String consume(User user) {
    return user.getName();
  }
}
`,
      });

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
        workerPoolSize: 1,
        parseCache: coldCache,
      });
      expect(cold.usedWorkerPool).toBe(true);
      const coldMethods = projectLombokMethods(cold);
      expect(coldMethods.some((m) => m.includes('|User.getName|getName|'))).toBe(true);
      expect(projectCallsToGetName(cold).some((c) => c.startsWith('consume->getName@'))).toBe(true);

      pruneCache(coldCache, coldCache.usedKeys);
      const savedKeys = await saveParseCache(storage, coldCache);
      expect(savedKeys.length).toBeGreaterThan(0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        parseIdentity.base,
        new Set(savedKeys),
      );

      const warmCache = await loadParseCache(storage, parseIdentity, storage);
      expect(warmCache.onDiskKeys).toEqual(new Set(savedKeys));
      const warm = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: warmCache,
      });
      expect(warm.usedWorkerPool).toBe(false);
      expect(projectLombokMethods(warm)).toEqual(coldMethods);
      expect(projectCallsToGetName(warm)).toEqual(projectCallsToGetName(cold));

      // Historical incompatible cache: foreign version must not replay.
      const indexPath = path.join(storage, 'parse-cache', 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { version: string };
      index.version = '82+0.0.0-historical';
      fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
      const historical = await loadParseCache(storage, parseIdentity, storage);
      expect(historical.entries.size).toBe(0);
      expect(historical.onDiskKeys?.size ?? 0).toBe(0);

      const recoveredCache: ParseCache = {
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
      expect(recovered.usedWorkerPool).toBe(true);
      expect(projectLombokMethods(recovered)).toEqual(coldMethods);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storage, { recursive: true, force: true });
    }
  }, 120000);
});
