/**
 * Integration coverage for the `runFullAnalysis` incremental-orchestration
 * wiring (Claude PR-review Finding 2).
 *
 * These tests exercise the *real runtime path* — they call
 * `runFullAnalysis` against a real on-disk git repo backed by a real
 * LadybugDB at `<repo>/.gitnexus/`, and assert behaviours that pure
 * unit tests on `diffFileHashes` / `extractChangedSubgraph` cannot
 * catch:
 *
 *   - the `isIncremental` decision (post-pipeline eligibility check)
 *   - `incrementalInProgress` dirty-flag set-before-mutation and
 *     clear-on-success
 *   - the importer-closure expansion (1-hop reached via the writable
 *     set, transitive reachable via bounded BFS)
 *   - the "forced full rebuild on dirty-flag-from-prior-crash" path
 *
 * Each test creates a temporary git repo, runs the analyzer, and asserts
 * on the resulting `meta.json` and graph state. Cleanup is best-effort
 * (Windows LadybugDB handle release can lag; `cleanupTempDir` retries).
 */

import { execSync } from 'child_process';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';
// Shared embedding-seed trio (this shipping review, FIX 8) — the KTD9
// zero-vector seeding pattern lives in one helper module now instead of two
// divergent copies here and in incremental-dirty-recovery.test.ts.
import {
  readEmbeddingNodeIds,
  seedEmbeddingForNodeId,
  seedEmbeddingsForFiles,
  stampEmbeddingCount,
} from '../helpers/embedding-seed.js';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import { SPRING_BEAN_INVENTORY_FEATURE } from '../../src/core/ingestion/frameworks/spring/analysis-features.js';
import { SPRING_CONFIG_BINDINGS_FEATURE } from '../../src/core/ingestion/languages/java/analysis-features.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-incr-orch-');

/** Stage + commit everything in the temp repo (mirrors mini-repo.ts's git calls). */
const gitCommitAll = (cwd: string, message: string): void => {
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd,
    stdio: 'pipe',
  });
  execSync(
    `git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "${message}"`,
    { cwd, stdio: 'pipe' },
  );
};

const SPRING_SERVICE = 'org.springframework.stereotype.Service';

function withoutAnalysisFeature(meta: RepoMeta, featureId: string): RepoMeta {
  return {
    ...meta,
    analysisFeatures: Object.fromEntries(
      Object.entries(meta.analysisFeatures ?? {}).filter(([id]) => id !== featureId),
    ),
  };
}

async function setupSpringBeanIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-bean-');
  const src = path.join(repo.dbPath, 'src', 'com', 'other');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'WildcardService.java'),
    'package com.other;\n' +
      'import org.springframework.stereotype.*;\n\n' +
      '@Service public class WildcardService {}\n',
    'utf-8',
  );
  execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial spring bean candidate');
  return repo;
}

async function setupKotlinSpringBeanIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-bean-kotlin-');
  const src = path.join(repo.dbPath, 'src', 'com', 'other');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'WildcardService.kt'),
    'package com.other\n' +
      'import org.springframework.stereotype.*\n\n' +
      '@Service class WildcardService\n',
    'utf-8',
  );
  execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial Kotlin spring bean candidate');
  return repo;
}

async function setupSpringConfigIncrementalRepo() {
  const repo = await createTempDir('gitnexus-incr-spring-config-');
  const resources = path.join(repo.dbPath, 'src', 'main', 'resources');
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, 'application.properties'), 'service.timeout=30\n', 'utf-8');
  execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
  gitCommitAll(repo.dbPath, 'initial spring configuration');
  return repo;
}

async function readWildcardServiceAnnotations(repoPath: string): Promise<string[]> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      "MATCH (c:Class) WHERE c.name = 'WildcardService' " +
        'RETURN c.frameworkAnnotations AS frameworkAnnotations LIMIT 1',
    )) as Array<{ frameworkAnnotations?: unknown }>;
    const value = rows[0]?.frameworkAnnotations;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } finally {
    await adapter.closeLbug();
  }
}

async function readSpringConfigPropertyNames(repoPath: string): Promise<string[]> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      "MATCH (p:Property) WHERE p.filePath = 'src/main/resources/application.properties' " +
        'RETURN p.name AS name ORDER BY p.name',
    )) as Array<{ name?: unknown }>;
    return rows.map((row) => String(row.name));
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
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
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

/** Java DI fixture (#2200): `@Autowired List<IFoo>` + 2 implementers ⇒ exactly
 *  2 INJECTS edges (Consumer→FooA, Consumer→FooB). Same shapes as the
 *  spring-di-pipeline integration fixture. */
const JAVA_DI_FIXTURE: ReadonlyArray<readonly [string, string]> = [
  ['IFoo.java', 'package com.example;\n\npublic interface IFoo {}\n'],
  ['FooA.java', 'package com.example;\n\npublic class FooA implements IFoo {}\n'],
  ['FooB.java', 'package com.example;\n\npublic class FooB implements IFoo {}\n'],
  [
    'Consumer.java',
    'package com.example;\n' +
      'import java.util.List;\n' +
      'import org.springframework.beans.factory.annotation.Autowired;\n' +
      '\n' +
      'public class Consumer {\n' +
      '  @Autowired private List<IFoo> foos;\n' +
      '}\n',
  ],
];

describe('runFullAnalysis — incremental orchestration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('first run populates fileHashes + schemaVersion and clears incrementalInProgress on success', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);
      expect(meta!.fileHashes).toBeDefined();
      expect(Object.keys(meta!.fileHashes ?? {}).length).toBeGreaterThan(0);
      expect(meta!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
      });
      // Dirty flag MUST be cleared after a successful run.
      expect(meta!.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 180_000);

  it('second run on unchanged state takes the alreadyUpToDate fast path', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const first = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(first.alreadyUpToDate).toBeUndefined();

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // lastCommit==HEAD && working tree clean (mod GitNexus output) →
      // early-return fast path.
      expect(second.alreadyUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('a same-commit v8 index missing the global Class capability rebuilds before the fast path', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);

      await saveMeta(
        storagePath,
        withoutAnalysisFeature(meta!, CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id),
      );
      const logs: string[] = [];
      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      expect(logs.join('\n')).toContain(`missing:${CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id}`);
      expect((await loadMeta(storagePath))!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
      });
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('a JVM index missing Bean inventory evidence rebuilds and restores the scoped stamp', async () => {
    const repo = await setupKotlinSpringBeanIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_BEAN_INVENTORY_FEATURE.id]: SPRING_BEAN_INVENTORY_FEATURE.version,
      });

      await saveMeta(storagePath, withoutAnalysisFeature(meta!, SPRING_BEAN_INVENTORY_FEATURE.id));
      const logs: string[] = [];
      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      expect(logs.join('\n')).toContain(`missing:${SPRING_BEAN_INVENTORY_FEATURE.id}`);
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([SPRING_SERVICE]);
      expect((await loadMeta(storagePath))!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_BEAN_INVENTORY_FEATURE.id]: SPRING_BEAN_INVENTORY_FEATURE.version,
      });
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('a config-only index missing Spring config evidence rebuilds and restores the scoped stamp', async () => {
    const repo = await setupSpringConfigIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_CONFIG_BINDINGS_FEATURE.id]: SPRING_CONFIG_BINDINGS_FEATURE.version,
      });

      await saveMeta(storagePath, withoutAnalysisFeature(meta!, SPRING_CONFIG_BINDINGS_FEATURE.id));
      const logs: string[] = [];
      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      expect(logs.join('\n')).toContain(`missing:${SPRING_CONFIG_BINDINGS_FEATURE.id}`);
      expect(await readSpringConfigPropertyNames(repo.dbPath)).toEqual(['service.timeout']);
      expect((await loadMeta(storagePath))!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_CONFIG_BINDINGS_FEATURE.id]: SPRING_CONFIG_BINDINGS_FEATURE.version,
      });
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('adding the first JVM file re-evaluates capabilities after the pipeline and avoids a top-up', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      expect((await loadMeta(storagePath))!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
      });

      await writeFile(
        path.join(repo.dbPath, 'src', 'FirstBean.kt'),
        'import org.springframework.stereotype.Service\n\n@Service class FirstBean\n',
        'utf-8',
      );
      gitCommitAll(repo.dbPath, 'add first JVM source file');

      const logs: string[] = [];
      await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(logs.join('\n')).toContain(`missing:${SPRING_BEAN_INVENTORY_FEATURE.id}`);
      expect(logs.join('\n')).not.toContain('Incremental:');
      expect((await loadMeta(storagePath))!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_BEAN_INVENTORY_FEATURE.id]: SPRING_BEAN_INVENTORY_FEATURE.version,
      });
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('second run after a comment-only edit takes the incremental path, clears the dirty flag, and preserves graph stats exactly', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const firstMeta = await loadMeta(storagePath);

      // Modify a source file with a COMMENT-ONLY edit — by construction
      // this changes the content hash (driving the incremental code path)
      // without changing any symbol, scope binding, call edge, import,
      // or community membership. Therefore every graph-stat invariant
      // (files / nodes / edges / communities / processes) MUST be
      // bit-identical to the first run. Anything else is a regression.
      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const before = await readFile(target, 'utf-8');
      await writeFile(target, before + '\n// touched by test\n', 'utf-8');

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // The early-return alreadyUpToDate path must NOT fire (the dirty
      // tree should kick the run through to incremental writeback).
      expect(second.alreadyUpToDate).toBeUndefined();

      const secondMeta = await loadMeta(storagePath);
      expect(secondMeta).not.toBeNull();
      // Dirty flag must be cleared on success.
      expect(secondMeta!.incrementalInProgress).toBeUndefined();
      // fileHashes[logger.ts] must have rotated to the new content.
      expect(secondMeta!.fileHashes?.['src/logger.ts']).toBeDefined();
      expect(secondMeta!.fileHashes?.['src/logger.ts']).not.toBe(
        firstMeta!.fileHashes?.['src/logger.ts'],
      );
      // Exact-equality stats invariant. DoD §2.7: avoid bounds-only
      // assertions that would mask a regression dropping half the graph.
      expect(secondMeta!.stats?.files).toBe(firstMeta!.stats?.files);
      expect(secondMeta!.stats?.nodes).toBe(firstMeta!.stats?.nodes);
      expect(secondMeta!.stats?.edges).toBe(firstMeta!.stats?.edges);
      expect(secondMeta!.stats?.communities).toBe(firstMeta!.stats?.communities);
      expect(secondMeta!.stats?.processes).toBe(firstMeta!.stats?.processes);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('skips the framework annotation drift query when no Bean source changed', async () => {
    const repo = await setupMiniRepo();
    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const before = await readFile(target, 'utf-8');
      await writeFile(target, before + '\n// non-bean-source incremental touch\n', 'utf-8');

      const querySpy = vi.spyOn(adapter, 'executeQuery');
      try {
        const incremental = await runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {} },
        );
        expect(incremental.alreadyUpToDate).toBeUndefined();
        expect(
          querySpy.mock.calls.some(
            ([query]) =>
              typeof query === 'string' &&
              query.includes('RETURN c.id AS id, c.frameworkAnnotations AS frameworkAnnotations'),
          ),
        ).toBe(false);
      } finally {
        querySpy.mockRestore();
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('incremental output is byte-equivalent to a full rebuild (incremental ≡ --force on the same repo state)', async () => {
    // The central correctness contract of this PR: an incremental run
    // and a full rebuild from the same repo state must produce identical
    // graph stats. We exercise it end-to-end:
    //
    //   1. setup mini-repo + run analyze (populates the index)
    //   2. edit one source file (comment-only — same graph)
    //   3. run incremental analyze → record secondMeta
    //   4. run analyze --force from the same state → record forceMeta
    //   5. assert every stats invariant is exactly equal.
    //
    // Steps 3 and 4 share the same on-disk file contents, so any
    // divergence is purely an artifact of the writeback strategy. If
    // any invariant differs, the PR's load-bearing claim is violated.
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      // Step 1: initial index.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Step 2: comment-only edit, same as the test above.
      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const original = await readFile(target, 'utf-8');
      await writeFile(target, original + '\n// equivalence test touch\n', 'utf-8');

      // Step 3: incremental writeback for the edited file.
      const incremental = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(incremental.alreadyUpToDate).toBeUndefined();
      const { storagePath } = getStoragePaths(repo.dbPath);
      const secondMeta = await loadMeta(storagePath);
      expect(secondMeta).not.toBeNull();

      // Step 4: force a full rebuild from the SAME on-disk file state.
      const forced = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, force: true },
        { onProgress: () => {} },
      );
      expect(forced.alreadyUpToDate).toBeUndefined();
      const forceMeta = await loadMeta(storagePath);
      expect(forceMeta).not.toBeNull();

      // Step 5: exact-equality across every stat. `toEqual` would also
      // work but `toBe` per-field makes a failure pinpoint the field.
      expect(secondMeta!.stats?.files).toBe(forceMeta!.stats?.files);
      expect(secondMeta!.stats?.nodes).toBe(forceMeta!.stats?.nodes);
      expect(secondMeta!.stats?.edges).toBe(forceMeta!.stats?.edges);
      expect(secondMeta!.stats?.communities).toBe(forceMeta!.stats?.communities);
      expect(secondMeta!.stats?.processes).toBe(forceMeta!.stats?.processes);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('rewrites unchanged Spring bean metadata when same-package shadowing changes', async () => {
    const repo = await setupSpringBeanIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([SPRING_SERVICE]);

      const shadow = path.join(repo.dbPath, 'src', 'com', 'other', 'Service.java');
      await writeFile(shadow, 'package com.other;\npublic @interface Service {}\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'add same-package annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([]);

      await rm(shadow);
      gitCommitAll(repo.dbPath, 'remove same-package annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([SPRING_SERVICE]);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('rewrites unchanged Kotlin Spring bean metadata when same-package shadowing changes', async () => {
    const repo = await setupKotlinSpringBeanIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([SPRING_SERVICE]);

      const shadow = path.join(repo.dbPath, 'src', 'com', 'other', 'Service.kt');
      await writeFile(shadow, 'package com.other\nannotation class Service\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'add same-package Kotlin annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([]);

      await rm(shadow);
      gitCommitAll(repo.dbPath, 'remove same-package Kotlin annotation shadow');

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readWildcardServiceAnnotations(repo.dbPath)).toEqual([SPRING_SERVICE]);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  // #2409: a large-fraction effective write set must escalate to the full DB
  // write plan (wipe + bulk COPY of the already-built graph) instead of the
  // surgical per-file writeback — at that size the surgical plan measured
  // SLOWER than a full load and its delete storm is the write pattern behind
  // the reported native mid-writeback deaths. The escalated result must be
  // indistinguishable from a --force rebuild of the same state.
  it('a hub edit whose write set covers most of a large repo escalates to the full DB write plan (#2409)', async () => {
    const repo = await setupMiniRepo();
    try {
      // Grow the repo past INCREMENTAL_ESCALATION_MIN_FILES (50) with a hub
      // imported by every generated file: touching the hub pulls the whole
      // family into the importer closure → write fraction ≈ 100% > 50%.
      const src = path.join(repo.dbPath, 'src');
      await writeFile(
        path.join(src, 'hub.ts'),
        'export function hubValue(x: number): number {\n  return x + 1;\n}\n',
        'utf-8',
      );
      for (let i = 0; i < 60; i++) {
        await writeFile(
          path.join(src, `spoke-${String(i).padStart(3, '0')}.ts`),
          `import { hubValue } from './hub';\n\nexport function spoke${i}(): number {\n  return hubValue(${i});\n}\n`,
          'utf-8',
        );
      }
      gitCommitAll(repo.dbPath, 'add hub + spokes');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Touch the hub — comment-only, so graph stats must be preserved.
      const hub = path.join(src, 'hub.ts');
      await writeFile(hub, (await readFile(hub, 'utf-8')) + '// escalation touch\n', 'utf-8');

      const logs: string[] = [];
      const incremental = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );
      expect(incremental.alreadyUpToDate).toBeUndefined();
      const joined = logs.join('\n');
      // The importer expansion fired AND the valve rerouted the write plan.
      expect(joined).toContain('importer(s) added to writable set');
      expect(joined).toContain('switching to a full DB write');

      const { storagePath } = getStoragePaths(repo.dbPath);
      const escalatedMeta = await loadMeta(storagePath);
      expect(escalatedMeta).not.toBeNull();
      // Dirty flag cleared on success — the escalated plan converges on the
      // same meta-save as every other successful run.
      expect(escalatedMeta!.incrementalInProgress).toBeUndefined();

      // The escalated write must be indistinguishable from --force on the
      // same state: any stale surviving row would show up as a stats delta.
      await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, force: true },
        { onProgress: () => {} },
      );
      const forcedMeta = await loadMeta(storagePath);
      expect(escalatedMeta!.stats?.files).toBe(forcedMeta!.stats?.files);
      expect(escalatedMeta!.stats?.nodes).toBe(forcedMeta!.stats?.nodes);
      expect(escalatedMeta!.stats?.edges).toBe(forcedMeta!.stats?.edges);
      expect(escalatedMeta!.stats?.communities).toBe(forcedMeta!.stats?.communities);
      expect(escalatedMeta!.stats?.processes).toBe(forcedMeta!.stats?.processes);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  // U4 / KTD10 (tri-review 4669518496): a SURGICAL preserve-mode run (below
  // both valve gates) must keep embedding rows in lockstep with their files
  // now that deleteNodesForFiles really deletes embedding rows via the
  // nodeId join:
  //   - changed-file rows are deleted with their nodes and RESTORED from the
  //     cache (the old insert-all restore lost them when a surviving row's
  //     PK conflict aborted the rest of the batch),
  //   - deleted-file rows are gone (join-delete) and NOT resurrected by the
  //     restore (live-graph filter),
  //   - unchanged rows are untouched (restore-scope filter, no conflicts),
  //   - a LEGACY ORPHAN row — stranded while the embedding delete was a
  //     no-op, unreachable by the node join forever — is swept by exact id
  //     (this shipping review, FIX 3).
  it('surgical incremental run keeps embedding rows in lockstep: changed restored, deleted gone, unchanged intact, legacy orphan swept (tri-review 4669518496 KTD10 + FIX 3)', async () => {
    const repo = await setupMiniRepo();
    try {
      const CHANGED_FILE = 'src/logger.ts';
      const UNCHANGED_FILE = 'src/db.ts';
      const DELETED_FILE = 'src/formatter.ts';
      // A fabricated nodeId no graph will ever contain: the P2-1-era no-op
      // delete left rows like this stranded in real DBs (schema version
      // stays 6, so they are still out there).
      const LEGACY_ORPHAN_NODE_ID = 'Function:src/ghost.ts:ghost:1';

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      const { storagePath } = getStoragePaths(repo.dbPath);
      const idsByFile = await seedEmbeddingsForFiles(
        repo.dbPath,
        [CHANGED_FILE, UNCHANGED_FILE, DELETED_FILE],
        3,
      );
      for (const fp of [CHANGED_FILE, UNCHANGED_FILE, DELETED_FILE]) {
        expect((idsByFile.get(fp) ?? []).length).toBeGreaterThan(0);
      }
      await seedEmbeddingForNodeId(repo.dbPath, LEGACY_ORPHAN_NODE_ID);
      const seededTotal = [...idsByFile.values()].flat().length + 1;
      await stampEmbeddingCount(storagePath, seededTotal);

      // One file modified (comment-only, appended at EOF so node ids keep
      // their line numbers), one file deleted — committed so lastCommit moves.
      const target = path.join(repo.dbPath, CHANGED_FILE);
      await writeFile(
        target,
        (await readFile(target, 'utf-8')) + '\n// embeddings parity touch\n',
        'utf-8',
      );
      await rm(path.join(repo.dbPath, DELETED_FILE));
      gitCommitAll(repo.dbPath, 'modify logger + delete formatter');

      const logs: string[] = [];
      const run = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );
      expect(run.alreadyUpToDate).toBeUndefined();
      // 7-file repo — far below the 50-file valve floor: this MUST have been
      // the surgical write plan, or every assertion below is vacuously about
      // the escalated path instead.
      expect(logs.join('\n')).not.toContain('switching to a full DB write');

      // The surgical run swept the fabricated legacy orphan by exact id
      // (FIX 3). The logged count also includes DELETED_FILE's cached rows —
      // live-graph rejects whose DB rows were already join-deleted with the
      // file, so their exact-id DELETEs match nothing (documented no-op).
      const expectedSweepCount = 1 + (idsByFile.get(DELETED_FILE) ?? []).length;
      expect(logs.join('\n')).toContain(
        `Swept ${expectedSweepCount} cached embedding row(s) with no live owning node`,
      );

      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      const expectedSurvivors = [
        ...(idsByFile.get(CHANGED_FILE) ?? []),
        ...(idsByFile.get(UNCHANGED_FILE) ?? []),
      ];
      // stats.embeddings excludes both the deleted-file rows AND the swept
      // legacy orphan.
      expect(after!.stats?.embeddings).toBe(expectedSurvivors.length);
      // Exact surviving nodeId set — pins all four behaviors at once (a
      // batch-abort loss, a leaked deleted-file row, a dropped unchanged
      // row, or a lingering legacy orphan each break set equality).
      expect((await readEmbeddingNodeIds(repo.dbPath)).sort()).toEqual(
        [...expectedSurvivors].sort(),
      );
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  // #2409 defect 2 (dirty-flag recovery parks WAL/shadow sidecars before any
  // open) is covered in incremental-dirty-recovery.test.ts — its own file so
  // the cross-platform CI matrix runs it on windows-latest without pulling in
  // this whole suite.

  it('a stale incrementalInProgress flag at startup forces a full rebuild that clears it', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // First run lays down a normal index.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Manually corrupt meta.json with a stale dirty flag — simulates
      // a crashed previous incremental run.
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      const tampered: RepoMeta = {
        ...meta!,
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 3,
          phase: 'load-graph',
          importerExpansion: 153,
          effectiveWriteCount: 167,
          deleteCount: 169,
        },
      };
      await saveMeta(storagePath, tampered);
      const logs: string[] = [];

      // Next run must detect the flag, force a full rebuild (which
      // overwrites meta), and clear the flag.
      const recovered = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );
      // A full rebuild was taken — the alreadyUpToDate fast path
      // explicitly cannot fire because the dirty-flag check rewrote
      // `options.force` to true.
      expect(recovered.alreadyUpToDate).toBeUndefined();

      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      expect(logs.join('\n')).toContain(
        'last dirty state: phase=load-graph, toWrite=3, importerExpansion=153, effectiveWrite=167, deleteCount=169',
      );
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // A pre-current index must not take the alreadyUpToDate fast path. The
  // schema mismatch guard runs before lastCommit equality can short-circuit
  // the pipeline, so node-identity migrations receive a full rebuild.
  it('a pre-current schemaVersion stamp forces a full rebuild on an unchanged-commit re-analyze', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // First run stamps the current schema version (v8).
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);

      // Simulate a pre-v8 index at the same commit. Without the schema guard,
      // this would return alreadyUpToDate before the pipeline runs.
      const downgraded: RepoMeta = { ...meta!, schemaVersion: 7 };
      await saveMeta(storagePath, downgraded);

      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // Pipeline actually ran (schemaVersion mismatch → force=true).
      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      // And the meta is stamped back to v8 (the rebuild path runs saveMeta).
      const restamped = await loadMeta(storagePath);
      expect(restamped!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // #2331/#2339: mirrors the schemaVersion mismatch test above, but for the
  // CJK segmentation mode stamp. Uses a non-default mode ('bigram') rather
  // than 'none' — with the default, (undefined ?? 'none') !== 'none' is
  // false regardless of whether the stamp was ever actually written, so a
  // dropped-stamp bug would pass this test vacuously. 'bigram' makes an
  // omitted stamp manifest as a real comparator mismatch instead.
  it('a stale cjkSegmentation stamp forces a full rebuild on an unchanged-commit re-analyze', async () => {
    const repo = await setupMiniRepo();
    try {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.cjkSegmentation).toBe('bigram');

      // Simulate a repo indexed under 'none' (or a pre-#2339 build with no
      // stamp at all) that's now being served/re-analyzed with bigram mode.
      const downgraded: RepoMeta = { ...meta!, cjkSegmentation: 'none' };
      await saveMeta(storagePath, downgraded);

      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // Pipeline actually ran (cjkSegmentation mismatch → force=true).
      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      // And the meta is restamped to the live resolved mode.
      const restamped = await loadMeta(storagePath);
      expect(restamped!.cjkSegmentation).toBe('bigram');
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('first-ever analyze of a brand-new repo proceeds without a spurious CJK mode force-rebuild', async () => {
    const repo = await setupMiniRepo();
    try {
      const { storagePath } = getStoragePaths(repo.dbPath);
      // No meta.json exists yet — existingMeta is falsy, so the
      // cjkSegmentationModeMismatch guard is skipped entirely (never calls
      // the comparator), same as the pdg/schemaVersion guards above it.
      expect(await loadMeta(storagePath)).toBeNull();

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(result.alreadyUpToDate).toBeUndefined();

      const meta = await loadMeta(storagePath);
      expect(meta!.cjkSegmentation).toBe('none');
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // U7 (#2200): the INJECTS delete-before-writeback must be UNCONDITIONAL.
  // extractChangedSubgraph re-includes ALL INJECTS edges from the fresh graph
  // on every incremental run (isGraphWideRelType), and CodeRelation has no PK
  // and no read-side dedup — so a pdg-gated delete (literal TAINT_PATH
  // mirroring) would append without deleting on every non-pdg incremental
  // run: N runs = N copies of every INJECTS row. This test is the assertion
  // that catches exactly that mistake.
  it('incremental runs neither strand nor duplicate INJECTS edges (delete-all is not pdg-gated) (#2200)', async () => {
    const repo = await setupMiniRepo();
    try {
      const src = path.join(repo.dbPath, 'src');
      for (const [name, content] of JAVA_DI_FIXTURE) {
        await writeFile(path.join(src, name), content, 'utf-8');
      }
      gitCommitAll(repo.dbPath, 'add java di fixture');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      // Full index: Consumer.foos fans out to the two IFoo implementers.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await countInjects(repo.dbPath)).toBe(2);

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
      expect(run1.alreadyUpToDate).toBeUndefined();
      expect(await countInjects(repo.dbPath)).toBe(2);

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
      expect(run2.alreadyUpToDate).toBeUndefined();
      expect(await countInjects(repo.dbPath)).toBe(2);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);
});

/**
 * U3 (tri-review 4669518496 P1): the #2409 escalation valve wipes the DB
 * files — HNSW vector index included. The Phase 3.5 restore brought the
 * embedding ROWS back, but nothing recreated the index and meta still
 * stamped `vector-index`: semantic search on a >10k-embedding repo silently
 * lost its vector lane while meta certified otherwise. This suite pins the
 * fix end-to-end: escalated preserve-mode run → index recreated → meta honest.
 *
 * SEPARATE from the `--force` escalation parity test above (KTD9): seeding
 * embeddings there would make its force leg derive forceRegenerateEmbeddings
 * and boot a real embedder in CI. This run stays preserve-only (no force).
 *
 * Skip-gated on VECTOR availability (the lbug-vector-extension.test.ts
 * pattern): skipped only where the extension genuinely cannot load —
 * no platform is categorically excluded any more (#2623 follow-up) — and
 * where it cannot, the honest stamp is
 * 'exact-scan', which the unit-level wiring pin in
 * run-analyze-fts-repair.test.ts covers platform-independently.
 */
describe('runFullAnalysis — escalated wipe recreates the vector index (#2409, tri-review 4669518496 P1)', () => {
  let vectorAvailable = false;
  let skipWarned = false;
  beforeAll(async () => {
    // Probe VECTOR the way the analyze write path loads it. loadVectorExtension
    // needs an open connection, and this suite (unlike the withTestLbugDB
    // vector suites) has no ambient DB — probe against a scratch one.
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { resolveAnalyzeInstallPolicy } = await import('../../src/core/lbug/extension-loader.js');
    const tmp = await createTempDir('gitnexus-incr-orch-vector-probe-');
    try {
      await adapter.initLbug(path.join(tmp.dbPath, 'probe-lbug'));
      vectorAvailable = await adapter.loadVectorExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
    } finally {
      await adapter.closeLbug();
      await tmp.cleanup();
    }
  }, 120_000);
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[incremental-orchestration] Skipping vector-index recreation test — the ' +
            'LadybugDB VECTOR extension is unavailable (unsupported platform or ' +
            'could not be installed).',
        );
      }
      ctx.skip();
    }
  });

  it('recreates the HNSW index after an escalated wipe-and-restore and stamps meta honestly (tri-review 4669518496 P1)', async () => {
    const repo = await setupMiniRepo();
    try {
      // Hub+spokes repo shape VERBATIM from the escalation parity test above:
      // the escalated run must clear BOTH valve gates (deleteCount ≥ 50 AND
      // fraction > 0.5). A smaller fixture would silently take the surgical
      // path, whose surviving index makes every assertion below pass
      // vacuously.
      const src = path.join(repo.dbPath, 'src');
      await writeFile(
        path.join(src, 'hub.ts'),
        'export function hubValue(x: number): number {\n  return x + 1;\n}\n',
        'utf-8',
      );
      for (let i = 0; i < 60; i++) {
        await writeFile(
          path.join(src, `spoke-${String(i).padStart(3, '0')}.ts`),
          `import { hubValue } from './hub';\n\nexport function spoke${i}(): number {\n  return hubValue(${i});\n}\n`,
          'utf-8',
        );
      }
      gitCommitAll(repo.dbPath, 'add hub + spokes');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // 20 zero-vector embeddings on real Function nodes (one per spoke —
      // fabricated ids would be dropped by the Phase 3.5 live-graph filter)
      // + a stats stamp so deriveEmbeddingMode sees an embedded repo
      // (preserve mode — the run below passes NO force flag, so no embedder
      // ever fires; KTD9).
      const SEED_COUNT = 20;
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const seedFiles: string[] = [];
      for (let i = 0; i < SEED_COUNT; i++) {
        seedFiles.push(`src/spoke-${String(i).padStart(3, '0')}.ts`);
      }
      const idsByFile = await seedEmbeddingsForFiles(repo.dbPath, seedFiles, 1);
      expect([...idsByFile.values()].flat().length).toBe(SEED_COUNT);
      await stampEmbeddingCount(storagePath, SEED_COUNT);

      // Touch the hub — the importer closure covers the whole family, the
      // valve fires, and the DB (index included) is wiped mid-run.
      const hub = path.join(src, 'hub.ts');
      await writeFile(hub, (await readFile(hub, 'utf-8')) + '// index recreation touch\n', 'utf-8');

      const logs: string[] = [];
      const escalated = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );
      expect(escalated.alreadyUpToDate).toBeUndefined();
      // The valve rerouted the write plan — without this the index assertions
      // below test the surgical path's surviving index, not the recreation.
      expect(logs.join('\n')).toContain('switching to a full DB write');

      // Every cached row was restored across the wipe…
      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      expect(after!.stats?.embeddings).toBe(SEED_COUNT);
      // …meta stamps what the DB actually holds…
      expect(after!.capabilities?.vectorSearch.status).toBe('vector-index');
      // …and the DB really does hold a recreated HNSW index (SHOW_INDEXES
      // straight off the reopened store — the assertion that fails when the
      // wipe destroys the index and nothing rebuilds it).
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(lbugPath);
      try {
        const idxRows = (await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *')) as Array<{
          index_name?: string;
          index_type?: string;
        }>;
        const idx = idxRows.find((r) => r.index_name === 'code_embedding_idx');
        expect(idx).toBeDefined();
        expect(idx!.index_type).toBe('HNSW');
      } finally {
        await adapter.closeLbug();
      }
    } finally {
      await repo.cleanup();
    }
  }, 600_000);
});
