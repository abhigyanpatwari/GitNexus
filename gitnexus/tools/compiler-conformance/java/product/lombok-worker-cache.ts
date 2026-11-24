import { compareCodeUnits } from '../../compare.mjs';
// Lombok accessor, constructor-DI and workspace-proof facts through a real parse worker and warm cache replay.
import fs from 'node:fs';
import type { RelationshipType } from 'gitnexus-shared';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { getRelationships, writeFixtureRepo } from '../../../../test/helpers/resolution-graph.js';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../../src/types/pipeline.js';
import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../src/storage/parsedfile-store.js';

const sources = {
  'Repo.java': `import org.springframework.stereotype.Repository;
@Repository class Repo {}`,
  'Other.java': `import org.springframework.stereotype.Repository;
@Repository class Other {}`,
  'Property.java': `import org.springframework.stereotype.Service;
@Service("property") class Property {}`,
  'Consumers.java': `import lombok.*;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service @RequiredArgsConstructor class RequiredConsumer {
  final Repo repo;
  Other plain;
}
@Service @AllArgsConstructor class AllConsumer {
  Repo repo;
  Other initialized = null;
  final Property fixed = null;
  static Property shared;
  Property $internal;
}
@Service @Data class DataConsumer { final Repo repo; }
@Service @lombok.Value class ValueConsumer { Repo repo; }
@Service @RequiredArgsConstructor class AmbiguousConsumer {
  final Repo repo;
  AmbiguousConsumer(Other other) { repo = null; }
}
@Service @RequiredArgsConstructor(staticName="of") class ConfiguredConsumer {
  final Repo repo;
}
@Service @RequiredArgsConstructor class AnnotatedFieldsConsumer {
  @Qualifier("other") final Other uncertain;
  @org.springframework.beans.factory.annotation.Value("property") final Property property;
  final Repo safe;
}`,
  'Unproven.java': `import org.springframework.stereotype.Service;
@Service @RequiredArgsConstructor class UnprovenConsumer { final Repo repo; }`,
  'Values.java': `@lombok.Value class ValueDto {
  String name;
  boolean active;
  Boolean boxed;
  @lombok.Getter(lombok.AccessLevel.NONE) String hidden;
}
@lombok.Value class Decoy { String name; boolean active; Boolean boxed; }
class Caller {
  void consume(ValueDto dto) { dto.getName(); dto.isActive(); dto.getBoxed(); }
  void negative(ValueDto dto) { dto.getHidden(); dto.setName("x"); }
}`,
  'CacheProbe.java': `import java.util.List;
class CacheItem {
  void save() {} void audit() {} void during() {} void caught() {} void finalized() {} void after() {}
}
class CacheOther implements java.lang.AutoCloseable {
  public void close() {}
  void save() {} void audit() {} void during() {} void caught() {} void finalized() {} void after() {}
}
class CacheFactory { CacheItem make() { return new CacheItem(); } }
class CacheHarness {
  CacheItem field; CacheItem x;
  void accept(java.util.function.Consumer<CacheOther> callback) {}
  void array(CacheItem[] values) { values[0].save(); }
  void wholeArray(CacheItem[] values) { values.save(); }
  void partialArray(CacheItem[][] values) { values[0].save(); }
  void fieldAlias() { var copy = this.field; copy.save(); }
  void factoryAlias(CacheFactory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void beforeLocal() { var copy = field; CacheOther field = new CacheOther(); copy.save(); }
  void blockShadow() { { CacheOther field = new CacheOther(); field.save(); } field.audit(); }
  void resource() {
    try (CacheOther field = new CacheOther()) { field.during(); }
    catch (Exception e) { field.caught(); }
    finally { field.finalized(); }
    field.after();
  }
  void typedLambda() { accept((CacheOther x) -> x.save()); }
  void implicitLambda() { accept(x -> x.audit()); }
  void callback(List<CacheItem> values) { values.forEach(x -> x.save()); }
  void rawCallback(List values) { values.forEach(x -> x.save()); }
}`,
  'identities/a/CacheEntity.java':
    'package cache.a; public class CacheEntity { public void save() {} }',
  'identities/b/CacheEntity.java':
    'package cache.b; public class CacheEntity { public void save() {} }',
  'identities/probe/QualifiedCache.java': `package cache.probe;
import cache.b.CacheEntity;
class QualifiedCache {
  void explicit(cache.a.CacheEntity value) { value.save(); }
  void absent(missing.CacheEntity value) { value.save(); }
}`,
  'identities/shadow/ShadowItem.java':
    'package cache.shadow; public class ShadowItem { public void save() {} }',
  'identities/shadow/java.java': `package cache.shadow;
public class java {
  public static class util {
    public static class List<T> { public void forEach(Object callback) {} }
  }
}`,
  'identities/shadow/ShadowCache.java': `package cache.shadow;
class ShadowCache {
  ShadowItem value;
  void raw(java.util.List<ShadowItem> values) { values.forEach(value -> value.save()); }
}`,
};

function edges(result: Awaited<ReturnType<typeof runPipelineFromRepo>>, type: RelationshipType) {
  return [...result.graph.iterRelationshipsByType(type)]
    .map((edge) => `${edge.sourceId}->${edge.targetId}`)
    .sort(compareCodeUnits);
}

describe('Lombok Value and generated constructor DI through worker/cache paths', () => {
  it(
    'retains exact accessor and dependency owners on cold worker parse and warm replay',
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-value-'));
      const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-value-cache-'));
      try {
        writeFixtureRepo(root, sources);
        const identity = await runtimeParseIdentity();
        const coldCache: ParseCache = {
          identity,
          entries: new Map(),
          usedKeys: new Set(),
          storagePath: storage,
          writeStoragePath: storage,
          onDiskKeys: new Set(),
        };
        const cold = await runPipelineFromRepo(root, () => {}, {
          workerPoolSize: 1,
          skipDerivedGraphPhases: true,
          parseCache: coldCache,
        });
        assert.equal(cold.usedWorkerPool, true);
        assert.deepEqual(
          edges(cold, 'CALLS').filter((edge) => edge.startsWith('Method:Values.java:Caller.')),
          [
            'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.getBoxed#0',
            'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.getName#0',
            'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.isActive#0',
          ],
        );
        assert.deepEqual(edges(cold, 'INJECTS'), [
          'Class:Consumers.java:AllConsumer->Class:Other.java:Other',
          'Class:Consumers.java:AllConsumer->Class:Repo.java:Repo',
          'Class:Consumers.java:AnnotatedFieldsConsumer->Class:Repo.java:Repo',
          'Class:Consumers.java:DataConsumer->Class:Repo.java:Repo',
          'Class:Consumers.java:RequiredConsumer->Class:Repo.java:Repo',
          'Class:Consumers.java:ValueConsumer->Class:Repo.java:Repo',
        ]);
        const synthetic = [...cold.graph.iterNodes()]
          .filter((node) => node.properties.synthetic === 'lombok')
          .map((node) => node.id)
          .sort(compareCodeUnits);
        assert.ok(synthetic.includes('Method:Values.java:ValueDto.getName#0'));
        assert.ok(!synthetic.includes('Method:Values.java:ValueDto.setName#1'));
        assert.ok(!synthetic.includes('Method:Values.java:ValueDto.getHidden#0'));

        // Pin the semantics before checking byte-for-byte cache parity: equal
        // cold/warm graphs could otherwise preserve the same wrong owner.
        const targets = (file: string, caller: string, members = ['save']) =>
          [...cold.graph.iterRelationshipsByType('CALLS')]
            .filter(
              (edge) =>
                edge.sourceId === `Method:${file}:${caller}` &&
                members.includes(cold.graph.getNode(edge.targetId)?.properties.name ?? ''),
            )
            .map((edge) => edge.targetId)
            .sort(compareCodeUnits);
        for (const caller of ['array#1', 'fieldAlias#0', 'factoryAlias#1', 'beforeLocal#0']) {
          assert.deepEqual(targets('CacheProbe.java', `CacheHarness.${caller}`), [
            'Method:CacheProbe.java:CacheItem.save#0',
          ]);
        }
        for (const caller of ['wholeArray#1', 'partialArray#1', 'rawCallback#1']) {
          assert.deepEqual(targets('CacheProbe.java', `CacheHarness.${caller}`), []);
        }
        assert.deepEqual(
          targets('CacheProbe.java', 'CacheHarness.blockShadow#0', ['save', 'audit']),
          ['Method:CacheProbe.java:CacheItem.audit#0', 'Method:CacheProbe.java:CacheOther.save#0'],
        );
        assert.deepEqual(
          targets('CacheProbe.java', 'CacheHarness.resource#0', [
            'during',
            'caught',
            'finalized',
            'after',
          ]),
          [
            'Method:CacheProbe.java:CacheItem.after#0',
            'Method:CacheProbe.java:CacheItem.caught#0',
            'Method:CacheProbe.java:CacheItem.finalized#0',
            'Method:CacheProbe.java:CacheOther.during#0',
          ],
        );
        assert.deepEqual(
          targets('identities/probe/QualifiedCache.java', 'QualifiedCache.explicit#1'),
          ['Method:identities/a/CacheEntity.java:CacheEntity.save#0'],
        );
        assert.deepEqual(
          targets('identities/probe/QualifiedCache.java', 'QualifiedCache.absent#1'),
          [],
        );
        assert.deepEqual(targets('CacheProbe.java', 'CacheHarness.typedLambda#0'), [
          'Method:CacheProbe.java:CacheOther.save#0',
        ]);
        // `x` is the parameter `Consumer<CacheOther>.accept` gives it (JLS 15.27.3),
        // never the field `x` of type CacheItem.
        assert.deepEqual(targets('CacheProbe.java', 'CacheHarness.implicitLambda#0', ['audit']), [
          'Method:CacheProbe.java:CacheOther.audit#0',
        ]);
        assert.deepEqual(targets('CacheProbe.java', 'CacheHarness.callback#1'), [
          'Method:CacheProbe.java:CacheItem.save#0',
        ]);
        assert.deepEqual(targets('identities/shadow/ShadowCache.java', 'ShadowCache.raw#1'), []);

        pruneCache(coldCache, coldCache.usedKeys);
        const keys = await saveParseCache(storage, coldCache);
        assert.ok(keys.length > 0);
        await pruneAndSaveDurableParsedFileStore(
          getDurableParsedFileDir(storage),
          identity.base,
          new Set(keys),
        );
        const warmCache = await loadParseCache(storage, identity, storage);
        const warm = await runPipelineFromRepo(root, () => {}, {
          workerPoolSize: 1,
          skipDerivedGraphPhases: true,
          parseCache: warmCache,
        });
        assert.equal(warm.usedWorkerPool, false);
        assert.deepEqual(edges(warm, 'CALLS'), edges(cold, 'CALLS'));
        assert.deepEqual(edges(warm, 'INJECTS'), edges(cold, 'INJECTS'));
        assert.deepEqual(
          [...warm.graph.iterNodes()]
            .filter((node) => node.properties.synthetic === 'lombok')
            .map((node) => node.id)
            .sort(compareCodeUnits),
          synthetic,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
      }
    },
  );
});

it(
  'corrects only workspace-shadowed annotation plans and restores an explicit sole constructor',
  { timeout: 120_000 },
  async () => {
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
        // A workspace `lombok` package must not undo the q.lombok type shadow.
        'lombok/Placeholder.java': 'package lombok; public class Placeholder {}',
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
        .sort(compareCodeUnits);
      assert.deepEqual(getters, [
        'Method:p/Explicit.java:Explicit.getRepo#0',
        'Method:p/Getter.java:GetterModel.getRepo#0',
        'Method:r/Model.java:Model.getRepo#0',
        'Method:t/Model.java:Model.getRepo#0',
        'Method:u/Model.java:Model.getRepo#0',
      ]);
      assert.deepEqual(edges(result, 'INJECTS'), [
        'Class:p/Ctor.java:Ctor->Class:p/Repo.java:Repo',
        'Class:p/Explicit.java:Explicit->Class:p/Repo.java:Repo',
        'Class:r/Model.java:Model->Class:p/Repo.java:Repo',
        'Class:t/Model.java:Model->Class:p/Repo.java:Repo',
        'Class:u/Model.java:Model->Class:p/Repo.java:Repo',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'recomputes proof for an unchanged cached model when a package shadow is added and removed',
  { timeout: 120_000 },
  async () => {
    // One temporary parent holds the repository and its cache, so no setup
    // failure can leave a directory outside the cleanup below.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-shadow-replay-'));
    try {
      const root = path.join(scratch, 'repo');
      const storage = path.join(scratch, 'cache');
      fs.mkdirSync(root);
      fs.mkdirSync(storage);
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
      assert.equal(cold.usedWorkerPool, true);
      assert.equal(hasGetter(cold), true);
      assert.deepEqual(edges(cold, 'INJECTS'), expectedInjection);
      await save(coldCache);

      writeFixtureRepo(root, { 'p/Value.java': 'package p; public @interface Value {}' });
      const addedCache = await loadParseCache(storage, identity, storage);
      const added = await run(addedCache);
      assert.equal(hasGetter(added), false);
      assert.deepEqual(edges(added, 'INJECTS'), []);
      await save(addedCache);
      const warm = await run(await loadParseCache(storage, identity, storage));
      assert.equal(warm.usedWorkerPool, false);
      assert.equal(hasGetter(warm), false);
      assert.deepEqual(edges(warm, 'INJECTS'), []);

      fs.unlinkSync(path.join(root, 'p/Value.java'));
      const removed = await run(await loadParseCache(storage, identity, storage));
      assert.equal(removed.usedWorkerPool, false);
      assert.equal(hasGetter(removed), true);
      assert.deepEqual(edges(removed, 'INJECTS'), expectedInjection);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

/** `@Value` behind `import lombok.*;` and a single-static-import of `<owner>.Value`. */
const model = (name: string, owner: string) =>
  `package app; import lombok.*; import static ${owner}.Value;
@org.springframework.stereotype.Service @Value public class ${name} { Repo repo; String name; }`;

describe('Lombok annotation behind a single-static-import of the same name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-lombok-static-import-'));
  let result: PipelineResult;
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  before(async () => {
    writeFixtureRepo(root, {
      // A static field is an expression name; it never shadows the annotation type.
      'custom/Constants.java':
        'package custom; public final class Constants { public static final String Value = "v"; }',
      // A static member type shadows lombok.* (JLS 6.4.1).
      'custom/Tags.java': 'package custom; public class Tags { public @interface Value {} }',
      'app/Repo.java':
        'package app; @org.springframework.stereotype.Repository public class Repo {}',
      'app/FieldOwner.java': model('FieldOwner', 'custom.Constants'),
      'app/TypeOwner.java': model('TypeOwner', 'custom.Tags'),
      'app/ExternalOwner.java': model('ExternalOwner', 'com.acme.Constants'),
      'app/Other.java':
        'package app; public class Other { public String getName() { return ""; } public Repo getRepo() { return null; } }',
      'app/Caller.java': `package app; class Caller {
  void field(FieldOwner o) { o.getName(); }
  void type(TypeOwner o) { o.getName(); }
  void external(ExternalOwner o) { o.getName(); }
}`,
    });
    result = await runPipelineFromRepo(root, () => {});
  });

  const callTargets = (source: string) =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.rel.sourceId === source)
      .map((edge) => edge.rel.targetId)
      .sort(compareCodeUnits);
  const syntheticIds = () =>
    [...result.graph.iterNodes()]
      .filter((node) => node.properties.synthetic === 'lombok')
      .map((node) => node.id)
      .sort(compareCodeUnits);

  for (const [caller, targets] of [
    ['field', ['Method:app/FieldOwner.java:FieldOwner.getName#0']],
    ['type', []],
    ['external', []],
  ] as const) {
    it(`resolves the ${caller}-owner accessor call to the Lombok owner only`, () => {
      assert.deepEqual(callTargets(`Method:app/Caller.java:Caller.${caller}#1`), targets);
    });
  }

  it('synthesizes accessors only when the imported owner declares no member type of that name', () => {
    assert.deepEqual(syntheticIds(), [
      'Method:app/FieldOwner.java:FieldOwner.getName#0',
      'Method:app/FieldOwner.java:FieldOwner.getRepo#0',
    ]);
  });

  it('injects through the generated constructor only for the proven Lombok owner', () => {
    assert.deepEqual(
      getRelationships(result, 'INJECTS')
        .map((edge) => `${edge.rel.sourceId}->${edge.rel.targetId}`)
        .sort(compareCodeUnits),
      ['Class:app/FieldOwner.java:FieldOwner->Class:app/Repo.java:Repo'],
    );
  });
});

it(
  'recomputes the static-import proof for an unchanged cached model when the owner changes',
  { timeout: 120_000 },
  async () => {
    // One temporary parent holds the repository and its cache.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-lombok-static-import-replay-'));
    try {
      const root = path.join(scratch, 'repo');
      const storage = path.join(scratch, 'cache');
      fs.mkdirSync(root);
      fs.mkdirSync(storage);
      const fieldOwner =
        'package custom; public final class Constants { public static final String Value = "v"; }';
      writeFixtureRepo(root, {
        'custom/Constants.java': fieldOwner,
        'app/Repo.java':
          'package app; @org.springframework.stereotype.Repository public class Repo {}',
        'app/Model.java': model('Model', 'custom.Constants'),
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
      const facts = (result: Awaited<ReturnType<typeof run>>) => ({
        getter: result.graph.getNode('Method:app/Model.java:Model.getRepo#0') !== undefined,
        injects: [...result.graph.iterRelationshipsByType('INJECTS')]
          .map((edge) => `${edge.sourceId}->${edge.targetId}`)
          .sort(compareCodeUnits),
      });
      const proven = {
        getter: true,
        injects: ['Class:app/Model.java:Model->Class:app/Repo.java:Repo'],
      };
      const refused = { getter: false, injects: [] };

      const cold = await run(coldCache);
      assert.equal(cold.usedWorkerPool, true);
      assert.deepEqual(facts(cold), proven);
      await save(coldCache);

      writeFixtureRepo(root, {
        'custom/Constants.java':
          'package custom; public class Constants { public @interface Value {} }',
      });
      const typeCache = await loadParseCache(storage, identity, storage);
      assert.deepEqual(facts(await run(typeCache)), refused);
      await save(typeCache);
      const warmType = await run(await loadParseCache(storage, identity, storage));
      assert.equal(warmType.usedWorkerPool, false);
      assert.deepEqual(facts(warmType), refused);

      writeFixtureRepo(root, { 'custom/Constants.java': fieldOwner });
      const fieldCache = await loadParseCache(storage, identity, storage);
      assert.deepEqual(facts(await run(fieldCache)), proven);
      await save(fieldCache);
      const warmField = await run(await loadParseCache(storage, identity, storage));
      assert.equal(warmField.usedWorkerPool, false);
      assert.deepEqual(facts(warmField), proven);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);
