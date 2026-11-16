import fs from 'node:fs';
import type { RelationshipType } from 'gitnexus-shared';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
  void unknownLambda() { accept(x -> x.audit()); }
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

function edgesOf(result: Awaited<ReturnType<typeof runPipelineFromRepo>>, type: RelationshipType) {
  return [...result.graph.iterRelationshipsByType(type)]
    .map((edge) => `${edge.sourceId}->${edge.targetId}`)
    .sort();
}

describe('Lombok Value and generated constructor DI through worker/cache paths', () => {
  it('retains exact accessor and dependency owners on cold worker parse and warm replay', async () => {
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
      expect(cold.usedWorkerPool).toBe(true);
      expect(
        edgesOf(cold, 'CALLS').filter((edge) => edge.startsWith('Method:Values.java:Caller.')),
      ).toEqual([
        'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.getBoxed#0',
        'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.getName#0',
        'Method:Values.java:Caller.consume#1->Method:Values.java:ValueDto.isActive#0',
      ]);
      expect(edgesOf(cold, 'INJECTS')).toEqual([
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
        .sort();
      expect(synthetic).toContain('Method:Values.java:ValueDto.getName#0');
      expect(synthetic).not.toContain('Method:Values.java:ValueDto.setName#1');
      expect(synthetic).not.toContain('Method:Values.java:ValueDto.getHidden#0');

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
          .sort();
      for (const caller of ['array#1', 'fieldAlias#0', 'factoryAlias#1', 'beforeLocal#0']) {
        expect(targets('CacheProbe.java', `CacheHarness.${caller}`)).toEqual([
          'Method:CacheProbe.java:CacheItem.save#0',
        ]);
      }
      for (const caller of ['wholeArray#1', 'partialArray#1', 'rawCallback#1']) {
        expect(targets('CacheProbe.java', `CacheHarness.${caller}`)).toEqual([]);
      }
      expect(targets('CacheProbe.java', 'CacheHarness.blockShadow#0', ['save', 'audit'])).toEqual([
        'Method:CacheProbe.java:CacheItem.audit#0',
        'Method:CacheProbe.java:CacheOther.save#0',
      ]);
      expect(
        targets('CacheProbe.java', 'CacheHarness.resource#0', [
          'during',
          'caught',
          'finalized',
          'after',
        ]),
      ).toEqual([
        'Method:CacheProbe.java:CacheItem.after#0',
        'Method:CacheProbe.java:CacheItem.caught#0',
        'Method:CacheProbe.java:CacheItem.finalized#0',
        'Method:CacheProbe.java:CacheOther.during#0',
      ]);
      expect(targets('identities/probe/QualifiedCache.java', 'QualifiedCache.explicit#1')).toEqual([
        'Method:identities/a/CacheEntity.java:CacheEntity.save#0',
      ]);
      expect(targets('identities/probe/QualifiedCache.java', 'QualifiedCache.absent#1')).toEqual(
        [],
      );
      expect(targets('CacheProbe.java', 'CacheHarness.typedLambda#0')).toEqual([
        'Method:CacheProbe.java:CacheOther.save#0',
      ]);
      expect(targets('CacheProbe.java', 'CacheHarness.unknownLambda#0', ['audit'])).toEqual([]);
      expect(targets('CacheProbe.java', 'CacheHarness.callback#1')).toEqual([
        'Method:CacheProbe.java:CacheItem.save#0',
      ]);
      expect(targets('identities/shadow/ShadowCache.java', 'ShadowCache.raw#1')).toEqual([]);

      pruneCache(coldCache, coldCache.usedKeys);
      const keys = await saveParseCache(storage, coldCache);
      expect(keys.length).toBeGreaterThan(0);
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
      expect(warm.usedWorkerPool).toBe(false);
      expect(edgesOf(warm, 'CALLS')).toEqual(edgesOf(cold, 'CALLS'));
      expect(edgesOf(warm, 'INJECTS')).toEqual(edgesOf(cold, 'INJECTS'));
      expect(
        [...warm.graph.iterNodes()]
          .filter((node) => node.properties.synthetic === 'lombok')
          .map((node) => node.id)
          .sort(),
      ).toEqual(synthetic);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storage, { recursive: true, force: true });
    }
  }, 120_000);
});
