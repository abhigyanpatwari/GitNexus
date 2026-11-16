import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
} from './resolvers/helpers.js';
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

/** `@Value` behind `import lombok.*;` and a single-static-import of `<owner>.Value`. */
const model = (name: string, owner: string) =>
  `package app; import lombok.*; import static ${owner}.Value;
@org.springframework.stereotype.Service @Value public class ${name} { Repo repo; String name; }`;

describe('Lombok annotation behind a single-static-import of the same name (review follow-ups, round 4)', () => {
  const result = useFixture('java-review-followups-r4-lombok', {
    // A static field is an expression name; it never shadows the annotation type.
    'custom/Constants.java':
      'package custom; public final class Constants { public static final String Value = "v"; }',
    // A static member type shadows lombok.* (JLS 6.4.1).
    'custom/Tags.java': 'package custom; public class Tags { public @interface Value {} }',
    'app/Repo.java': 'package app; @org.springframework.stereotype.Repository public class Repo {}',
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

  const callTargets = (source: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === source)
      .map((edge) => edge.rel.targetId)
      .sort();
  const syntheticIds = () =>
    [...result().graph.iterNodes()]
      .filter((node) => node.properties.synthetic === 'lombok')
      .map((node) => node.id)
      .sort();

  it.each([
    ['field', ['Method:app/FieldOwner.java:FieldOwner.getName#0']],
    ['type', []],
    ['external', []],
  ])('resolves the %s-owner accessor call to the Lombok owner only', (caller, targets) => {
    expect(callTargets(`Method:app/Caller.java:Caller.${caller}#1`)).toEqual(targets);
  });

  it('synthesizes accessors only when the imported owner declares no member type of that name', () => {
    expect(syntheticIds()).toEqual([
      'Method:app/FieldOwner.java:FieldOwner.getName#0',
      'Method:app/FieldOwner.java:FieldOwner.getRepo#0',
    ]);
  });

  it('injects through the generated constructor only for the proven Lombok owner', () => {
    expect(
      getRelationships(result(), 'INJECTS')
        .map((edge) => `${edge.rel.sourceId}->${edge.rel.targetId}`)
        .sort(),
    ).toEqual(['Class:app/FieldOwner.java:FieldOwner->Class:app/Repo.java:Repo']);
  });
});

it('recomputes the static-import proof for an unchanged cached model when the owner changes', async () => {
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
        .sort(),
    });
    const proven = {
      getter: true,
      injects: ['Class:app/Model.java:Model->Class:app/Repo.java:Repo'],
    };
    const refused = { getter: false, injects: [] };

    const cold = await run(coldCache);
    expect(cold.usedWorkerPool).toBe(true);
    expect(facts(cold)).toEqual(proven);
    await save(coldCache);

    writeFixtureRepo(root, {
      'custom/Constants.java':
        'package custom; public class Constants { public @interface Value {} }',
    });
    const typeCache = await loadParseCache(storage, identity, storage);
    expect(facts(await run(typeCache))).toEqual(refused);
    await save(typeCache);
    const warmType = await run(await loadParseCache(storage, identity, storage));
    expect(warmType.usedWorkerPool).toBe(false);
    expect(facts(warmType)).toEqual(refused);

    writeFixtureRepo(root, { 'custom/Constants.java': fieldOwner });
    const fieldCache = await loadParseCache(storage, identity, storage);
    expect(facts(await run(fieldCache))).toEqual(proven);
    await save(fieldCache);
    const warmField = await run(await loadParseCache(storage, identity, storage));
    expect(warmField.usedWorkerPool).toBe(false);
    expect(facts(warmField)).toEqual(proven);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
