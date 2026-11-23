import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../src/core/tree-sitter/parser-loader.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  emptyParseCache,
  loadParseCache,
  loadParseCacheFiles,
  saveParseCache,
} from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import { graphIdentity } from '../helpers/graph-identity.js';
import { writeFixtureRepo, getRelationships } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// isLanguageAvailable only says the grammar module loaded; probe the parser so
// a grammar that fails in setLanguage skips the suite instead of failing it.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

describe.skipIf(!dartAvailable)(
  // Skipped when the Dart parser cannot be initialised (probe above).
  'review follow-ups through the durable parse cache',
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cache-'));
    const repo = path.join(temp, 'repo');
    const storage = path.join(temp, 'cache');
    let cold: PipelineResult;
    let warm: PipelineResult;
    let facts: Awaited<ReturnType<typeof loadParseCacheFiles>>;

    beforeAll(async () => {
      fs.mkdirSync(storage);
      writeFixtureRepo(repo, {
        'pubspec.yaml': 'name: cache_fixture\nenvironment:\n  sdk: ^3.6.0\n',
        'legacy.dart':
          'class Versioned { void versionSave() {} }\nvoid versioned() { final _ = Versioned(); _.versionSave(); }\n',
        'leaf.dart': 'class User { void save() {} }\nUser make() => User();\n',
        'facade.dart': "export 'leaf.dart' show User, make;\n",
        'app.dart': "import 'facade.dart' deferred as api;\nvoid run() { api.make().save(); }\n",
        'host.rb':
          'class User\n def save; end\nend\nclass Host\n def run\n user = User.new\n user.save\n end\nend\n',
      });
      const identity = await runtimeParseIdentity();
      const cache = emptyParseCache(identity, { storagePath: storage, writeStoragePath: storage });
      cold = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 2,
        parseCache: cache,
      });
      const keys = await saveParseCache(storage, cache);
      await mergeStagedDurableParsedFileStore(storage, storage, identity.base, new Set(keys));
      const restored = await loadParseCache(storage, identity, storage);
      facts = await loadParseCacheFiles(
        restored,
        [...restored.fileResults!.live!.records.values()],
        storage,
      );
      warm = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: await loadParseCache(storage, identity, storage),
      });
    }, 120000);
    afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

    it('preserves per-file relationship origins on disk but never publishes that private metadata', () => {
      expect(facts.size).toBe(5);
      const relationships = [...facts.values()].flatMap((file) => file.relationships);
      expect(relationships.length).toBeGreaterThan(0);
      for (const rel of relationships) expect(rel.originFilePath).toMatch(/\.(dart|rb)$/);
      for (const rel of cold.graph.iterRelationships())
        expect(rel).not.toHaveProperty('originFilePath');
    });

    it('reconstructs every graph fact and the exported producer owner without workers', () => {
      expect(cold.usedWorkerPool).toBe(true);
      expect(warm.usedWorkerPool).toBe(false);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(5);
      expect(cold.scopeExtractionFailures).toEqual([]);
      expect(warm.scopeExtractionFailures).toEqual([]);
      expect(graphIdentity(warm.graph)).toEqual(graphIdentity(cold.graph));
      expect(
        getRelationships(warm, 'CALLS')
          .filter((edge) => edge.sourceFilePath === 'app.dart' && edge.target === 'save')
          .map((edge) => edge.rel.targetId),
      ).toEqual(['Method:leaf.dart:User.save#0']);
    });

    it('reinterprets unchanged cached source when the package SDK lower bound changes', async () => {
      const identity = await runtimeParseIdentity();
      const versionCalls = (result: PipelineResult) =>
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.target === 'versionSave')
          .map((edge) => edge.rel.targetId);
      expect(versionCalls(cold)).toEqual(['Method:legacy.dart:Versioned.versionSave#0']);
      expect(versionCalls(warm)).toEqual(versionCalls(cold));
      fs.writeFileSync(
        path.join(repo, 'pubspec.yaml'),
        'name: cache_fixture\nenvironment:\n  sdk: ^3.7.0\n',
      );
      const modern = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        parseCache: await loadParseCache(storage, identity, storage),
      });
      expect(modern.reparsedFileCount).toBe(0);
      expect(versionCalls(modern)).toEqual([]);
      fs.writeFileSync(
        path.join(repo, 'pubspec.yaml'),
        'name: cache_fixture\nenvironment:\n  sdk: ^3.6.0\n',
      );
      const legacy = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        parseCache: await loadParseCache(storage, identity, storage),
      });
      expect(legacy.reparsedFileCount).toBe(0);
      expect(versionCalls(legacy)).toEqual(versionCalls(cold));
      expect(graphIdentity(legacy.graph)).toEqual(graphIdentity(cold.graph));
    }, 120000);
  },
);
