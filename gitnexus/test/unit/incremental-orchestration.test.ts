/** Incremental reindexing of Spring configuration, Kotlin beans, and Dart packages. */
import { execSync } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { getStoragePaths, saveMeta, loadMeta } from '../../src/storage/repo-manager.js';
import {
  gitCommitAll,
  withoutAnalysisFeature,
  readWildcardServiceAnnotations,
} from '../helpers/incremental-test-repo.js';
import { createTempDir } from '../helpers/test-db.js';

import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { DART_PACKAGE_IDENTITY_REASON } from '../../src/core/ingestion/languages/dart/package-dependencies.js';
import {
  SPRING_AOP_FEATURE,
  SPRING_BEAN_INVENTORY_FEATURE,
  SPRING_CONDITIONALS_FEATURE,
  SPRING_NON_HTTP_HANDLERS_FEATURE,
  SPRING_ROUTE_BINDINGS_FEATURE,
} from '../../src/core/ingestion/frameworks/spring/analysis-features.js';
import { SPRING_CONFIG_BINDINGS_FEATURE } from '../../src/core/ingestion/languages/java/analysis-features.js';

const SPRING_SERVICE = 'org.springframework.stereotype.Service';
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

async function setupKotlinSpringConfigConsumerIncrementalRepo() {
  const repo = await setupSpringConfigIncrementalRepo();
  const kotlin = path.join(repo.dbPath, 'src', 'main', 'kotlin', 'com', 'example');
  await mkdir(kotlin, { recursive: true });
  await writeFile(
    path.join(kotlin, 'ConfigConsumer.kt'),
    'package com.example\n' +
      'import org.springframework.beans.factory.annotation.Value\n\n' +
      'class ConfigConsumer {\n' +
      '  @Value("\\${service.timeout}")\n' +
      '  var timeout: Int = 0\n' +
      '}\n',
    'utf-8',
  );
  gitCommitAll(repo.dbPath, 'add Kotlin Spring config consumer');
  return repo;
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

async function readKotlinConfigConsumerState(repoPath: string): Promise<{
  description: string;
  bindingCount: number;
}> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      "MATCH (p:Property) WHERE p.name = 'timeout' " +
        'RETURN p.description AS description LIMIT 1',
    )) as Array<{ description?: unknown }>;
    const bindings = (await adapter.executeQuery(
      "MATCH (p:Property {name: 'timeout'})-[r:CodeRelation]->(c:Property) " +
        "WHERE r.type = 'USES' AND r.reason STARTS WITH 'spring-config:' " +
        'RETURN count(r) AS count',
    )) as Array<{ count?: number | bigint }>;
    return {
      description: String(rows[0]?.description ?? ''),
      bindingCount: Number(bindings[0]?.count ?? 0),
    };
  } finally {
    await adapter.closeLbug();
  }
}

describe('runFullAnalysis — incremental orchestration', () => {
  it('a JVM index missing Bean inventory evidence rebuilds and restores the scoped stamp', async () => {
    const repo = await setupKotlinSpringBeanIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta!.analysisFeatures).toEqual({
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        [SPRING_AOP_FEATURE.id]: SPRING_AOP_FEATURE.version,
        [SPRING_BEAN_INVENTORY_FEATURE.id]: SPRING_BEAN_INVENTORY_FEATURE.version,
        [SPRING_CONDITIONALS_FEATURE.id]: SPRING_CONDITIONALS_FEATURE.version,
        [SPRING_CONFIG_BINDINGS_FEATURE.id]: SPRING_CONFIG_BINDINGS_FEATURE.version,
        [SPRING_NON_HTTP_HANDLERS_FEATURE.id]: SPRING_NON_HTTP_HANDLERS_FEATURE.version,
        [SPRING_ROUTE_BINDINGS_FEATURE.id]: SPRING_ROUTE_BINDINGS_FEATURE.version,
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
        [SPRING_AOP_FEATURE.id]: SPRING_AOP_FEATURE.version,
        [SPRING_BEAN_INVENTORY_FEATURE.id]: SPRING_BEAN_INVENTORY_FEATURE.version,
        [SPRING_CONDITIONALS_FEATURE.id]: SPRING_CONDITIONALS_FEATURE.version,
        [SPRING_CONFIG_BINDINGS_FEATURE.id]: SPRING_CONFIG_BINDINGS_FEATURE.version,
        [SPRING_NON_HTTP_HANDLERS_FEATURE.id]: SPRING_NON_HTTP_HANDLERS_FEATURE.version,
        [SPRING_ROUTE_BINDINGS_FEATURE.id]: SPRING_ROUTE_BINDINGS_FEATURE.version,
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

  it('persists Kotlin unresolved markers when a Spring config key is deleted incrementally', async () => {
    const repo = await setupKotlinSpringConfigConsumerIncrementalRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await readKotlinConfigConsumerState(repo.dbPath)).toEqual({
        description: '',
        bindingCount: 1,
      });

      const configPath = path.join(
        repo.dbPath,
        'src',
        'main',
        'resources',
        'application.properties',
      );
      await writeFile(configPath, '', 'utf-8');
      gitCommitAll(repo.dbPath, 'delete Spring config key');

      const logs: string[] = [];
      await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(logs.join('\n')).toContain('Spring config consumer property drift');
      expect(await readKotlinConfigConsumerState(repo.dbPath)).toEqual({
        description: 'Spring config unresolved: service.timeout',
        bindingCount: 0,
      });
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

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
});
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

describe.skipIf(!dartAvailable)('Dart pubspec-only incremental persistence (#2963)', () => {
  it.each([
    {
      name: 'rename',
      initial: 'name: app',
      next: 'name: renamed',
      file: 'pubspec.yaml',
      nextResolves: false,
    },
    {
      name: 'addition',
      initial: null,
      next: 'name: app',
      file: 'pubspec.yaml',
      nextResolves: true,
    },
    {
      name: 'duplicate',
      initial: 'name: app',
      next: 'name: app',
      file: 'nested/pubspec.yaml',
      nextResolves: false,
    },
    {
      name: 'repair',
      initial: 'name: [invalid',
      next: 'name: app',
      file: 'pubspec.yaml',
      nextResolves: true,
    },
  ])(
    'persists $name and its reversal with forced-rebuild parity',
    async ({ initial, next, file, nextResolves }) => {
      const repo = await createTempDir();
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const options = { skipAgentsMd: true, skipFts: true };
      const progress = { onProgress: () => {} };
      const readEdges = async () => {
        await adapter.initLbug(getStoragePaths(repo.dbPath).lbugPath, { skipFts: true });
        try {
          return await adapter.executeQuery(
            `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN ['IMPORTS', 'CALLS'] ` +
              `RETURN a.id AS source, b.id AS target, r.type AS type, r.reason AS reason, ` +
              `a.filePath AS sourceFile, b.filePath AS targetFile, b.name AS targetName ` +
              `ORDER BY source, target, type, reason`,
          );
        } finally {
          await adapter.closeLbug();
        }
      };
      try {
        await mkdir(path.join(repo.dbPath, 'lib'), { recursive: true });
        await mkdir(path.join(repo.dbPath, 'nested'), { recursive: true });
        await writeFile(path.join(repo.dbPath, '.gitignore'), '.gitnexus/\n');
        await writeFile(
          path.join(repo.dbPath, 'lib/model.dart'),
          'class Model { void save() {} }\n',
        );
        await writeFile(
          path.join(repo.dbPath, 'lib/bridge.dart'),
          "import 'package:app/model.dart';\nModel buildModel() => Model();\n",
        );
        await writeFile(
          path.join(repo.dbPath, 'lib/main.dart'),
          "import './bridge.dart';\nvoid run() { buildModel().save(); }\n",
        );
        await writeFile(
          path.join(repo.dbPath, 'nested/decoy.dart'),
          'class Model { void save() {} }\n',
        );
        if (initial !== null) await writeFile(path.join(repo.dbPath, 'pubspec.yaml'), initial);
        execSync('git init -q', { cwd: repo.dbPath, stdio: 'pipe' });
        gitCommitAll(repo.dbPath, 'Dart package fixture');
        await runFullAnalysis(repo.dbPath, options, progress);
        const initialEdges = await readEdges();
        expect(
          initialEdges.filter(
            (edge) =>
              edge.type === 'IMPORTS' &&
              edge.source === 'File:lib/bridge.dart' &&
              edge.target === 'File:lib/model.dart',
          ),
        ).toHaveLength(initial === 'name: app' ? 1 : 0);

        for (const [content, resolves] of [
          [next, nextResolves],
          [file === 'pubspec.yaml' ? initial : null, initial === 'name: app'],
        ] as const) {
          const target = path.join(repo.dbPath, file);
          if (content === null) await rm(target);
          else await writeFile(target, content);
          gitCommitAll(repo.dbPath, 'Update package identity');
          const incremental = await runFullAnalysis(repo.dbPath, options, progress);
          expect(incremental.incrementalStats?.writeMode).toBe('incremental');
          const incrementalEdges = await readEdges();
          const imports = incrementalEdges.filter(
            (edge) =>
              edge.type === 'IMPORTS' &&
              edge.source === 'File:lib/bridge.dart' &&
              edge.target === 'File:lib/model.dart',
          );
          expect(imports).toHaveLength(resolves ? 1 : 0);
          expect(
            incrementalEdges.filter(
              (edge) =>
                edge.type === 'CALLS' &&
                edge.sourceFile === 'lib/main.dart' &&
                edge.targetFile === 'lib/model.dart' &&
                edge.targetName === 'save',
            ),
          ).toHaveLength(resolves ? 1 : 0);
          const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
          expect(Object.hasOwn(meta?.fileHashes ?? {}, file)).toBe(content !== null);
          const identityToFile = incrementalEdges.filter(
            (edge) =>
              edge.type === 'IMPORTS' &&
              edge.reason === DART_PACKAGE_IDENTITY_REASON &&
              edge.source === 'File:lib/main.dart' &&
              edge.target === `File:${file}`,
          );
          if (content === 'name: app') {
            expect(identityToFile).toEqual([
              {
                source: 'File:lib/main.dart',
                target: `File:${file}`,
                type: 'IMPORTS',
                reason: DART_PACKAGE_IDENTITY_REASON,
                sourceFile: 'lib/main.dart',
                targetFile: file,
                targetName: 'pubspec.yaml',
              },
            ]);
          } else {
            // Rename and deletion must drop the identity edge. A stale edge
            // would keep rewriting importers after the package name is gone.
            expect(identityToFile).toEqual([]);
          }
          await runFullAnalysis(repo.dbPath, { ...options, force: true }, progress);
          expect(await readEdges()).toEqual(incrementalEdges);
        }
      } finally {
        await adapter.closeLbug();
        await repo.cleanup();
      }
    },
    300_000,
  );
});
