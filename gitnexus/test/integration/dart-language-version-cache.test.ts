/**
 * A Dart package's language version comes from metadata (the pubspec SDK lower
 * bound, the nearest enclosing manifest), which can change while every source
 * file stays byte-identical and cached. The only capture difference between
 * the two language modes is how a parameter or local named `_` binds, so:
 *
 *  - only files that recorded such a binder at capture time are read and
 *    captured again on the main thread, and only inside a pre-3.7 package;
 *  - after every metadata-only change, a warm run over the saved cache builds
 *    the same graph as a cold run of the same tree.
 *
 * Work is asserted through counters (which files were captured again, which
 * had source text materialized), never through wall time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  /** Every capture made in this process (worker captures are not seen here). */
  captures: [] as { filePath: string; languageVersion: string | undefined }[],
  /** Files whose source text was resident when the Dart hook ran. */
  sourcesHeld: [] as string[],
}));
vi.mock('../../src/core/ingestion/languages/dart/captures.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/core/ingestion/languages/dart/captures.js')>();
  return {
    ...real,
    emitDartScopeCaptures: (...args: Parameters<typeof real.emitDartScopeCaptures>) => {
      probe.captures.push({ filePath: args[1], languageVersion: args[4] });
      return real.emitDartScopeCaptures(...args);
    },
  };
});
vi.mock(
  '../../src/core/ingestion/languages/dart/package-language-version.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../src/core/ingestion/languages/dart/package-language-version.js')
      >();
    return {
      ...real,
      applyDartPackageLanguageVersions: (
        ...args: Parameters<typeof real.applyDartPackageLanguageVersions>
      ) => {
        const [files, ctx] = args;
        probe.sourcesHeld.push(
          ...files
            .map((file) => file.filePath)
            .filter((filePath) => (ctx.fileContents.get(filePath) ?? '') !== ''),
        );
        return real.applyDartPackageLanguageVersions(...args);
      },
    };
  },
);

import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { emptyParseCache, loadParseCache, saveParseCache } from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import { graphIdentity, type GraphIdentity } from '../helpers/graph-identity.js';
import { writeFixtureRepo, getRelationships } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const LEGACY_PUBSPEC = "name: app\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n";
const MODERN_PUBSPEC = 'name: app\nenvironment:\n  sdk: ^3.7.0\n';
const OVERRIDE_BODY = "import 'models.dart';\nvoid o(Other _) { _.save(); }\n";

/** Eight Dart files; four have a `_` parameter or local (K = 4). */
const FILES: Record<string, string> = {
  'pubspec.yaml': LEGACY_PUBSPEC,
  'lib/models.dart': 'class Other { void save() {} }\nclass User { void save() {} }\n',
  // Legacy: the parameter `_` is an Other. Modern: `_` reads the field, a User.
  'lib/param.dart':
    "import 'models.dart';\nclass Holder {\n  final _ = User();\n  void f(Other _) { _.save(); }\n}\n",
  // Legacy: the local `_` is an Other. Modern: `_` names nothing.
  'lib/local.dart': "import 'models.dart';\nvoid g() { final _ = Other(); _.save(); }\n",
  'lib/override.dart': OVERRIDE_BODY,
  'lib/plain.dart': "import 'models.dart';\nvoid h(User u) { u.save(); }\n",
  'lib/plain2.dart': "import 'models.dart';\nvoid h2(Other o) { o.save(); }\n",
  'lib/pattern.dart': 'int p(Object o) => switch (o) { _ => 0 };\n',
  'packages/inner/lib/inner.dart':
    'class Inner { void save() {} }\nclass Decoy { void save() {} }\nvoid i(Inner _) { _.save(); }\n',
};

const INNER = 'packages/inner/lib/inner.dart';
const LOCAL = 'lib/local.dart';
const OVERRIDE = 'lib/override.dart';
const PARAM = 'lib/param.dart';

interface Step {
  readonly name: string;
  readonly mutate: (repo: string) => void;
  /** Files captured again on the main thread, cold and warm alike. */
  readonly recaptured: readonly string[];
  /** Source files whose bytes changed in this step. */
  readonly reparsed: number;
}

const write = (relative: string, content: string) => (repo: string) =>
  writeFixtureRepo(repo, { [relative]: content });
const remove = (relative: string) => (repo: string) => fs.rmSync(path.join(repo, relative));

const STEPS: readonly Step[] = [
  {
    name: 'unchanged tree',
    mutate: () => {},
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 0,
  },
  {
    name: 'SDK lower bound raised to 3.7',
    mutate: write('pubspec.yaml', MODERN_PUBSPEC),
    recaptured: [],
    reparsed: 0,
  },
  {
    name: 'SDK lower bound lowered to a pre-release 3.6 bound',
    mutate: write('pubspec.yaml', 'name: app\nenvironment:\n  sdk: ^3.6.0-0\n'),
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 0,
  },
  { name: 'pubspec removed', mutate: remove('pubspec.yaml'), recaptured: [], reparsed: 0 },
  {
    name: 'pubspec added',
    mutate: write('pubspec.yaml', LEGACY_PUBSPEC),
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 0,
  },
  {
    name: 'nested modern pubspec added',
    mutate: write('packages/inner/pubspec.yaml', 'name: inner\nenvironment:\n  sdk: ^3.8.0\n'),
    recaptured: [LOCAL, OVERRIDE, PARAM],
    reparsed: 0,
  },
  {
    name: 'nested pubspec given a rejected name',
    mutate: write('packages/inner/pubspec.yaml', 'name: Inner-App\nenvironment:\n  sdk: ^3.8.0\n'),
    recaptured: [LOCAL, OVERRIDE, PARAM],
    reparsed: 0,
  },
  {
    name: 'nested pubspec renamed away',
    mutate: (repo) =>
      fs.renameSync(
        path.join(repo, 'packages/inner/pubspec.yaml'),
        path.join(repo, 'packages/inner/pubspec.disabled'),
      ),
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 0,
  },
  {
    name: 'nested pubspec without a version added',
    mutate: write('packages/inner/pubspec.yaml', 'name: inner\n'),
    recaptured: [LOCAL, OVERRIDE, PARAM],
    reparsed: 0,
  },
  {
    name: 'nested pubspec removed',
    mutate: remove('packages/inner/pubspec.yaml'),
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 0,
  },
  {
    name: 'modern file override added in the legacy package',
    mutate: write(OVERRIDE, `// @dart=3.8\n${OVERRIDE_BODY}`),
    recaptured: [LOCAL, PARAM, INNER],
    reparsed: 1,
  },
  {
    name: 'file override removed',
    mutate: write(OVERRIDE, OVERRIDE_BODY),
    recaptured: [LOCAL, OVERRIDE, PARAM, INNER],
    reparsed: 1,
  },
  {
    name: 'legacy file override added, then the package raised to 3.7',
    mutate: (repo) =>
      writeFixtureRepo(repo, {
        [OVERRIDE]: `// @dart=3.5\n${OVERRIDE_BODY}`,
        'pubspec.yaml': MODERN_PUBSPEC,
      }),
    recaptured: [],
    reparsed: 1,
  },
];

interface Observation {
  readonly graph: GraphIdentity;
  readonly result: PipelineResult;
  /** Files captured in this process with a package language version. */
  readonly recaptured: readonly string[];
  /** Every capture made in this process. */
  readonly mainThreadCaptures: number;
  readonly sourcesHeld: readonly string[];
}

const saveCalls = (result: PipelineResult): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.target === 'save')
    .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
    .sort();

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))(
  'Dart package language version through the durable parse cache',
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-language-version-cache-'));
    const repo = path.join(temp, 'repo');
    const storage = path.join(temp, 'cache');
    const warm = new Map<string, Observation>();
    const cold = new Map<string, Observation>();
    let initial: Observation;

    const observe = async (
      options: Parameters<typeof runPipelineFromRepo>[2],
    ): Promise<Observation> => {
      probe.captures.length = 0;
      probe.sourcesHeld.length = 0;
      const result = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 2,
        ...options,
      });
      return {
        graph: graphIdentity(result.graph),
        result,
        recaptured: probe.captures
          .filter((capture) => capture.languageVersion !== undefined)
          .map((capture) => capture.filePath)
          .sort(),
        mainThreadCaptures: probe.captures.length,
        sourcesHeld: [...probe.sourcesHeld].sort(),
      };
    };

    beforeAll(async () => {
      fs.mkdirSync(storage);
      writeFixtureRepo(repo, FILES);
      const identity = await runtimeParseIdentity();
      // The cache is saved after every run, as an analysis does.
      const cached = async (
        cache: Awaited<ReturnType<typeof loadParseCache>>,
      ): Promise<Observation> => {
        const observation = await observe({ parseCache: cache });
        const keys = await saveParseCache(storage, cache);
        await mergeStagedDurableParsedFileStore(storage, storage, identity.base, new Set(keys));
        return observation;
      };
      initial = await cached(
        emptyParseCache(identity, { storagePath: storage, writeStoragePath: storage }),
      );
      for (const step of STEPS) {
        step.mutate(repo);
        warm.set(step.name, await cached(await loadParseCache(storage, identity, storage)));
        cold.set(step.name, await observe({}));
      }
    }, 540000);
    afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

    const at = (runs: Map<string, Observation>, name: string): Observation => {
      const observation = runs.get(name);
      if (observation === undefined) throw new Error(`step did not run: ${name}`);
      return observation;
    };

    it('captures again only the K files with a _ parameter or local on the first, uncached run', () => {
      expect(initial.result.reparsedFileCount).toBe(8);
      expect(initial.recaptured).toEqual([LOCAL, OVERRIDE, PARAM, INNER].sort());
      expect(initial.mainThreadCaptures).toBe(4);
      expect(initial.sourcesHeld).toEqual(initial.recaptured);
    });

    it.each(STEPS.map((step) => [step.name, step] as const))(
      'warm graph equals cold graph after: %s',
      (name) => {
        expect(at(warm, name).result.scopeExtractionFailures).toEqual([]);
        expect(at(warm, name).graph).toEqual(at(cold, name).graph);
      },
    );

    it.each(STEPS.map((step) => [step.name, step] as const))(
      'warm run reads and captures again only version-sensitive legacy files after: %s',
      (name, step) => {
        const observation = at(warm, name);
        const expected = [...step.recaptured].sort();
        expect(observation.result.reparsedFileCount).toBe(step.reparsed);
        expect(observation.result.parseCacheHitFileCount).toBe(8 - step.reparsed);
        expect(observation.recaptured).toEqual(expected);
        expect(observation.mainThreadCaptures).toBe(expected.length);
        expect(observation.sourcesHeld).toEqual(expected);
      },
    );

    it.each(STEPS.map((step) => [step.name, step] as const))(
      'cold run captures again only version-sensitive legacy files after: %s',
      (name, step) => {
        const observation = at(cold, name);
        const expected = [...step.recaptured].sort();
        expect(observation.recaptured).toEqual(expected);
        expect(observation.mainThreadCaptures).toBe(expected.length);
        expect(observation.sourcesHeld).toEqual(expected);
      },
    );

    it('binds _ as a parameter or local in the pre-3.7 package', () => {
      expect(saveCalls(at(warm, 'unchanged tree').result)).toEqual([
        'Function:lib/local.dart:g -> Method:lib/models.dart:Other.save#0',
        'Function:lib/override.dart:o -> Method:lib/models.dart:Other.save#0',
        'Function:lib/plain.dart:h -> Method:lib/models.dart:User.save#0',
        'Function:lib/plain2.dart:h2 -> Method:lib/models.dart:Other.save#0',
        'Function:packages/inner/lib/inner.dart:i -> Method:packages/inner/lib/inner.dart:Inner.save#0',
        'Method:lib/param.dart:Holder.f#1 -> Method:lib/models.dart:Other.save#0',
      ]);
    });

    it('treats _ as a wildcard once the SDK lower bound reaches 3.7', () => {
      expect(saveCalls(at(warm, 'SDK lower bound raised to 3.7').result)).toEqual([
        'Function:lib/plain.dart:h -> Method:lib/models.dart:User.save#0',
        'Function:lib/plain2.dart:h2 -> Method:lib/models.dart:Other.save#0',
        'Method:lib/param.dart:Holder.f#1 -> Method:lib/models.dart:User.save#0',
      ]);
    });

    it('honours a pre-release lower bound as a pre-3.7 package', () => {
      expect(
        saveCalls(at(warm, 'SDK lower bound lowered to a pre-release 3.6 bound').result),
      ).toEqual(saveCalls(at(warm, 'unchanged tree').result));
    });

    it('stops at a nested manifest even when its name is rejected', () => {
      const expected = saveCalls(at(warm, 'unchanged tree').result).filter(
        (edge) => !edge.startsWith('Function:packages/inner/'),
      );
      expect(saveCalls(at(warm, 'nested modern pubspec added').result)).toEqual(expected);
      expect(saveCalls(at(warm, 'nested pubspec given a rejected name').result)).toEqual(expected);
      expect(saveCalls(at(warm, 'nested pubspec without a version added').result)).toEqual(
        expected,
      );
    });

    it('lets a leading @dart override win over the package in both directions', () => {
      expect(
        saveCalls(at(warm, 'modern file override added in the legacy package').result),
      ).not.toContain('Function:lib/override.dart:o -> Method:lib/models.dart:Other.save#0');
      expect(
        saveCalls(at(warm, 'legacy file override added, then the package raised to 3.7').result),
      ).toEqual([
        'Function:lib/override.dart:o -> Method:lib/models.dart:Other.save#0',
        'Function:lib/plain.dart:h -> Method:lib/models.dart:User.save#0',
        'Function:lib/plain2.dart:h2 -> Method:lib/models.dart:Other.save#0',
        'Method:lib/param.dart:Holder.f#1 -> Method:lib/models.dart:User.save#0',
      ]);
    });
  },
);
