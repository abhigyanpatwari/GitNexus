import { fixtureGitExecutable } from '../../../../test/helpers/git-executable.js';
import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, after, afterEach, it } from 'node:test';
import {
  decodeSpringAopReason,
  SPRING_AOP_EVIDENCE_ID_PREFIX,
} from '../../../../src/core/ingestion/frameworks/spring/aop.js';
import { SPRING_AUTO_CONFIGURATION_SYNTHETIC_ID_PREFIX } from '../../../../src/core/ingestion/frameworks/spring/auto-configuration.js';
import { springVendorPrefixesKey } from '../../../../src/core/ingestion/frameworks/spring/vendor-prefixes.js';
import { JAVA_ENUM_INTERFACE_HERITAGE_FEATURE } from '../../../../src/core/ingestion/languages/java/analysis-features.js';
import { getStoragePaths, saveMeta, loadMeta } from '../../../../src/storage/repo-manager.js';
import {
  gitCommitAll,
  withoutAnalysisFeature,
  readWildcardServiceAnnotations,
} from '../../../../test/helpers/incremental-test-repo.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../../../../test/helpers/mini-repo.js';
import { createTempDir } from '../../../../test/helpers/test-db.js';

function incrementalSource(name: string) {
  return new URL(
    '../../../../test/fixtures/java-products/incremental-orchestration/' + name,
    import.meta.url,
  );
}

let registry: Awaited<ReturnType<typeof createTempDir>>;
const priorVendorPrefixes = process.env.GITNEXUS_SPRING_VENDOR_PREFIXES;
before(async () => {
  registry = await createTempDir('gn-java-incremental-home-');
  process.env.GITNEXUS_HOME = registry.dbPath;
  process.env.GITNEXUS_SHARED_STORE = 'off';
  delete process.env.GITNEXUS_STORAGE_PATH;
  delete process.env.GITNEXUS_STORAGE_ROOT;
});
after(async () => {
  if (registry) await registry.cleanup();
});
afterEach(() => {
  if (priorVendorPrefixes === undefined) delete process.env.GITNEXUS_SPRING_VENDOR_PREFIXES;
  else process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = priorVendorPrefixes;
});
const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-incr-orch-');

const SPRING_SERVICE = 'org.springframework.stereotype.Service';

async function setupSpringBeanIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-bean-');
  const src = path.join(repo.dbPath, 'src', 'com', 'other');
  await mkdir(src, { recursive: true });
  await copyFile(incrementalSource('WildcardService.java'), path.join(src, 'WildcardService.java'));
  execFileSync(fixtureGitExecutable(), ['init'], { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial spring bean candidate');
  return repo;
}

async function setupJavaEnumHeritageIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-java-enum-heritage-');
  const src = path.join(repo.dbPath, 'src');
  await mkdir(src, { recursive: true });
  await copyFile(incrementalSource('Status.java'), path.join(src, 'Status.java'));
  execFileSync(fixtureGitExecutable(), ['init'], { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial Java enum heritage');
  return repo;
}

const springAopAspectSource = (pointcut: string) =>
  readFileSync(incrementalSource('TraceAspect.java'), 'utf8').replace(
    'within(com.example.FirstService)',
    pointcut,
  );

async function setupSpringAopIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-aop-');
  const javaSrc = path.join(repo.dbPath, 'src', 'main', 'java', 'com', 'example');
  const kotlinSrc = path.join(repo.dbPath, 'src', 'main', 'kotlin', 'com', 'example');
  const resources = path.join(repo.dbPath, 'src', 'main', 'resources');
  await Promise.all([
    mkdir(javaSrc, { recursive: true }),
    mkdir(kotlinSrc, { recursive: true }),
    mkdir(resources, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(repo.dbPath, '.gitignore'), '.gitnexus/\n', 'utf-8'),
    copyFile(incrementalSource('FirstService.java'), path.join(javaSrc, 'FirstService.java')),
    writeFile(
      path.join(javaSrc, 'TraceAspect.java'),
      springAopAspectSource('within(com.example.FirstService)'),
      'utf-8',
    ),
    writeFile(
      path.join(kotlinSrc, 'KotlinService.kt'),
      'package com.example\n\n' +
        'import org.springframework.transaction.annotation.Transactional as Tx\n\n' +
        'class KotlinService {\n' +
        '  @Tx fun kotlinTx() {}\n' +
        '}\n',
      'utf-8',
    ),
    writeFile(path.join(resources, 'application.properties'), 'feature.enabled=true\n', 'utf-8'),
  ]);
  execFileSync(fixtureGitExecutable(), ['init'], { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial spring aop fixture');
  return repo;
}

async function setupSpringBeanFactoryIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-bean-factory-');
  const src = path.join(repo.dbPath, 'src', 'com', 'other');
  await mkdir(src, { recursive: true });
  await copyFile(
    incrementalSource('WildcardConfiguration.java'),
    path.join(src, 'WildcardConfiguration.java'),
  );
  execFileSync(fixtureGitExecutable(), ['init'], { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial spring bean factory');
  return repo;
}

async function countStatusImplementsNamed(repoPath: string): Promise<number> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      "MATCH (e:Enum {name: 'Status'})-[r:CodeRelation]->(i:Interface {name: 'Named'}) " +
        "WHERE r.type = 'IMPLEMENTS' RETURN count(r) AS c",
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

async function deleteStatusImplementsNamed(repoPath: string): Promise<void> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    await adapter.executeQuery(
      "MATCH (e:Enum {name: 'Status'})-[r:CodeRelation]->(i:Interface {name: 'Named'}) " +
        "WHERE r.type = 'IMPLEMENTS' DELETE r",
    );
  } finally {
    await adapter.closeLbug();
  }
}

/**
 * Direct count over INJECTS CodeRelation rows — mirrors pdg-mode-flip's
 * countBasicBlocks: reopen the repo DB, count, close (runFullAnalysis closes
 * the singleton on completion, so each count owns its own open/close).
 */
async function countInjects(repoPath: string): Promise<number> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'INJECTS' RETURN count(r) AS c`,
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

async function countSpringAutoConfigurationDeclarations(repoPath: string): Promise<number> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'DECLARES' ` +
        `AND (r.reason = 'spring-auto-configuration-import' ` +
        `OR r.reason = 'spring-auto-configuration-factory') RETURN count(r) AS c`,
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

async function countSpringBeanFactoryDeclarations(repoPath: string): Promise<number> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'DECLARES' ` +
        `AND r.reason STARTS WITH 'spring-bean-factory:' RETURN count(r) AS c`,
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

async function countSpringAutoConfigurationSyntheticClasses(repoPath: string): Promise<number> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH (n:Class) WHERE n.id STARTS WITH ` +
        `'${SPRING_AUTO_CONFIGURATION_SYNTHETIC_ID_PREFIX}' ` +
        `RETURN count(n) AS c`,
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

interface SpringAopPersistedRelationship {
  readonly relType: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly reason: string;
}

interface SpringAopPersistedEvidence {
  readonly id: string;
  readonly description: string;
}

interface SpringAopPersistedSnapshot {
  readonly relationships: readonly SpringAopPersistedRelationship[];
  readonly evidence: readonly SpringAopPersistedEvidence[];
}

async function readSpringAopSnapshot(repoPath: string): Promise<SpringAopPersistedSnapshot> {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const relationships = (await adapter.executeQuery(
      `MATCH (s)-[r:CodeRelation]->(t) ` +
        `WHERE (r.type = 'ADVISED_BY' OR r.type = 'DECLARES') ` +
        `AND r.reason STARTS WITH 'spring-aop:v1:' ` +
        `RETURN r.type AS relType, s.id AS sourceId, s.name AS sourceName, ` +
        `t.id AS targetId, t.name AS targetName, r.reason AS reason ` +
        `ORDER BY relType, sourceId, targetId, reason`,
    )) as SpringAopPersistedRelationship[];
    const evidence = (await adapter.executeQuery(
      `MATCH (n:CodeElement) WHERE n.id STARTS WITH '${SPRING_AOP_EVIDENCE_ID_PREFIX}' ` +
        `RETURN n.id AS id, n.description AS description ORDER BY id`,
    )) as SpringAopPersistedEvidence[];
    return { relationships, evidence };
  } finally {
    await adapter.closeLbug();
  }
}

function assertSpringAopSnapshotShape(
  snapshot: SpringAopPersistedSnapshot,
  expectedAdviceSource: string,
): void {
  assert.equal(snapshot.relationships.length, 4);
  assert.equal(snapshot.evidence.length, 3);
  const decoded = snapshot.relationships.map((relationship) => ({
    relationship,
    reason: decodeSpringAopReason(relationship.reason),
  }));
  assert.deepEqual(decoded.map(({ reason }) => reason?.kind).sort(compareCodeUnits), [
    'advice',
    'aspect',
    'behavior',
    'pointcut',
  ]);
  assert.equal(
    decoded.find(({ reason }) => reason?.kind === 'behavior')?.relationship.sourceName,
    'kotlinTx',
  );
  const advice = decoded.find(({ reason }) => reason?.kind === 'advice')?.relationship;
  assert.equal(advice?.sourceName, expectedAdviceSource);
  assert.equal(advice?.targetName, 'trace');
  assert.equal(
    new Set(
      snapshot.relationships.map(
        (relationship) =>
          `${relationship.relType}\0${relationship.sourceId}\0${relationship.targetId}\0${relationship.reason}`,
      ),
    ).size,
    snapshot.relationships.length,
  );
  assert.equal(new Set(snapshot.evidence.map(({ id }) => id)).size, snapshot.evidence.length);
}

/** Java DI fixture (#2200): `@Autowired List<IFoo>` + 2 implementers ⇒ exactly
 *  2 INJECTS edges (Consumer→FooA, Consumer→FooB). Same shapes as the
 *  spring-di-pipeline integration fixture. */
const JAVA_DI_FIXTURE = ['IFoo.java', 'FooA.java', 'FooB.java', 'Consumer.java'];
it(
  'a Java index missing enum heritage evidence rebuilds before the fast path (#2918)',
  { timeout: 300_000 },
  async () => {
    const repo = await setupJavaEnumHeritageIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      assert.partialDeepStrictEqual(meta!.analysisFeatures, {
        [JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.id]: JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.version,
      });
      assert.equal(await countStatusImplementsNamed(repo.dbPath), 1);

      await deleteStatusImplementsNamed(repo.dbPath);
      assert.equal(await countStatusImplementsNamed(repo.dbPath), 0);

      await saveMeta(
        storagePath,
        withoutAnalysisFeature(meta!, JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.id),
      );
      const logs: string[] = [];
      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      assert.equal(reanalyzed.alreadyUpToDate, undefined);
      assert.ok(logs.join('\n').includes(`missing:${JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.id}`));
      assert.partialDeepStrictEqual((await loadMeta(storagePath))!.analysisFeatures, {
        [JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.id]: JAVA_ENUM_INTERFACE_HERITAGE_FEATURE.version,
      });
      assert.equal(await countStatusImplementsNamed(repo.dbPath), 1);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'rebuilds a JVM index when the registered Spring vendor prefixes change',
  { timeout: 300_000 },
  async () => {
    const repo = await setupSpringBeanIncrementalRepo();
    try {
      process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = 'Win';
      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      assert.equal((await loadMeta(storagePath))?.springVendorPrefixes, springVendorPrefixesKey());

      process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = 'Acme,Win';
      const logs: string[] = [];
      const rebuilt = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      assert.equal(rebuilt.alreadyUpToDate, undefined);
      assert.ok(rebuilt.rebuildReasons.includes('spring-vendor-prefixes'));
      assert.ok(logs.join('\n').includes('Spring vendor mapping prefixes changed'));
      assert.equal((await loadMeta(storagePath))?.springVendorPrefixes, springVendorPrefixesKey());

      const steady = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      assert.equal(steady.alreadyUpToDate, true);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'replaces Spring AOP evidence across real incremental runs without duplicates',
  { timeout: 600_000 },
  async () => {
    const repo = await setupSpringAopIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const firstSnapshot = await readSpringAopSnapshot(repo.dbPath);
      assertSpringAopSnapshotShape(firstSnapshot, 'first');
      const firstPointcutEvidenceId = firstSnapshot.relationships.find(
        ({ reason }) => decodeSpringAopReason(reason)?.kind === 'pointcut',
      )?.targetId;
      assert.notEqual(firstPointcutEvidenceId, undefined);

      const aspectPath = path.join(
        repo.dbPath,
        'src',
        'main',
        'java',
        'com',
        'example',
        'TraceAspect.java',
      );
      await writeFile(
        aspectPath,
        springAopAspectSource(
          '@annotation(org.springframework.transaction.annotation.Transactional)',
        ),
        'utf-8',
      );
      gitCommitAll(repo.dbPath, 'retarget spring advice');
      const retargetLogs: string[] = [];
      const retargeted = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => retargetLogs.push(message) },
      );
      assert.equal(retargeted.alreadyUpToDate, undefined);
      assert.ok(retargetLogs.join('\n').includes('Incremental: changed=1'));
      assert.ok(!retargetLogs.join('\n').includes('switching to a full DB write'));

      const secondSnapshot = await readSpringAopSnapshot(repo.dbPath);
      assertSpringAopSnapshotShape(secondSnapshot, 'kotlinTx');
      const secondPointcutEvidenceId = secondSnapshot.relationships.find(
        ({ reason }) => decodeSpringAopReason(reason)?.kind === 'pointcut',
      )?.targetId;
      assert.notEqual(secondPointcutEvidenceId, undefined);
      assert.notEqual(secondPointcutEvidenceId, firstPointcutEvidenceId);
      assert.ok(!secondSnapshot.evidence.map(({ id }) => id).includes(firstPointcutEvidenceId));

      const propertyPath = path.join(
        repo.dbPath,
        'src',
        'main',
        'resources',
        'application.properties',
      );
      await writeFile(propertyPath, 'feature.enabled=false\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'change unrelated resource');
      const replayLogs: string[] = [];
      const replayed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        {
          onLog: (message) => replayLogs.push(message),
          onProgress: () => {},
        },
      );
      assert.equal(replayed.alreadyUpToDate, undefined);
      assert.ok(replayLogs.join('\n').includes('Incremental: changed=1'));
      assert.ok(!replayLogs.join('\n').includes('switching to a full DB write'));
      assert.deepEqual(await readSpringAopSnapshot(repo.dbPath), secondSnapshot);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'rewrites unchanged Spring bean metadata when same-package shadowing changes',
  { timeout: 600_000 },
  async () => {
    const repo = await setupSpringBeanIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.deepEqual(await readWildcardServiceAnnotations(repo.dbPath), [SPRING_SERVICE]);

      const shadow = path.join(repo.dbPath, 'src', 'com', 'other', 'Service.java');
      await copyFile(incrementalSource('Service.java'), shadow);
      gitCommitAll(repo.dbPath, 'add same-package annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.deepEqual(await readWildcardServiceAnnotations(repo.dbPath), []);

      await rm(shadow);
      gitCommitAll(repo.dbPath, 'remove same-package annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.deepEqual(await readWildcardServiceAnnotations(repo.dbPath), [SPRING_SERVICE]);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'rewrites unchanged Bean factory declarations when same-package shadowing changes',
  { timeout: 600_000 },
  async () => {
    const repo = await setupSpringBeanFactoryIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countSpringBeanFactoryDeclarations(repo.dbPath), 1);

      const shadow = path.join(repo.dbPath, 'src', 'com', 'other', 'Bean.java');
      await copyFile(incrementalSource('Bean.java'), shadow);
      gitCommitAll(repo.dbPath, 'add same-package Bean annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countSpringBeanFactoryDeclarations(repo.dbPath), 0);

      await rm(shadow);
      gitCommitAll(repo.dbPath, 'remove same-package Bean annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countSpringBeanFactoryDeclarations(repo.dbPath), 1);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'incremental runs neither strand nor duplicate INJECTS edges (delete-all is not pdg-gated) (#2200)',
  { timeout: 600_000 },
  async () => {
    const repo = await setupMiniRepo();
    try {
      const src = path.join(repo.dbPath, 'src');
      for (const name of JAVA_DI_FIXTURE) {
        await copyFile(incrementalSource(name), path.join(src, name));
      }
      gitCommitAll(repo.dbPath, 'add java di fixture');

      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');

      // Full index: Consumer.foos fans out to the two IFoo implementers.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countInjects(repo.dbPath), 2);

      // Incremental run 1: comment-only touch of an UNRELATED file (none of
      // the Java DI files change), committed so lastCommit moves.
      const target = path.join(src, 'logger.ts');
      const beforeFirstTouch = await readFile(target, 'utf-8');
      await writeFile(target, beforeFirstTouch + '\n// di idempotency touch 1\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'unrelated touch 1');
      const run1 = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      assert.equal(run1.alreadyUpToDate, undefined);
      assert.equal(await countInjects(repo.dbPath), 2);

      // Incremental run 2: second unrelated touch. A gated delete would have
      // appended two more rows per writeback (4 by now) — must still be 2.
      const beforeSecondTouch = await readFile(target, 'utf-8');
      await writeFile(target, beforeSecondTouch + '\n// di idempotency touch 2\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'unrelated touch 2');
      const run2 = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      assert.equal(run2.alreadyUpToDate, undefined);
      assert.equal(await countInjects(repo.dbPath), 2);
    } finally {
      await repo.cleanup();
    }
  },
);

it(
  'incremental runs do not duplicate repository-wide Spring DECLARES edges (#2415)',
  { timeout: 600_000 },
  async () => {
    const repo = await setupMiniRepo();
    try {
      const sourceDir = path.join(repo.dbPath, 'src', 'main', 'java', 'com', 'example');
      const metadataDir = path.join(repo.dbPath, 'src', 'main', 'resources', 'META-INF', 'spring');
      await mkdir(sourceDir, { recursive: true });
      await mkdir(metadataDir, { recursive: true });
      await writeFile(
        path.join(metadataDir, 'org.springframework.boot.autoconfigure.AutoConfiguration.imports'),
        'com.example.ExampleAutoConfiguration\n',
        'utf-8',
      );
      gitCommitAll(repo.dbPath, 'add auto configuration metadata');

      const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countSpringAutoConfigurationDeclarations(repo.dbPath), 1);
      assert.equal(await countSpringAutoConfigurationSyntheticClasses(repo.dbPath), 1);

      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      for (const run of [1, 2]) {
        const before = await readFile(target, 'utf-8');
        await writeFile(target, `${before}\n// auto-register idempotency touch ${run}\n`, 'utf-8');
        gitCommitAll(repo.dbPath, `unrelated auto-register touch ${run}`);
        await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
        assert.equal(await countSpringAutoConfigurationDeclarations(repo.dbPath), 1);
        assert.equal(await countSpringAutoConfigurationSyntheticClasses(repo.dbPath), 1);
      }

      await copyFile(
        incrementalSource('ExampleAutoConfiguration.java'),
        path.join(sourceDir, 'ExampleAutoConfiguration.java'),
      );
      gitCommitAll(repo.dbPath, 'add source for metadata-only auto configuration');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      assert.equal(await countSpringAutoConfigurationDeclarations(repo.dbPath), 1);
      assert.equal(await countSpringAutoConfigurationSyntheticClasses(repo.dbPath), 0);
    } finally {
      await repo.cleanup();
    }
  },
);
