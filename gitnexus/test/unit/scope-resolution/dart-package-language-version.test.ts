import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';

/** Counts captures made in this process and lets one path fail on demand. */
const captureProbe = vi.hoisted(() => ({
  calls: [] as { filePath: string; languageVersion: string | undefined }[],
  failFor: new Set<string>(),
}));
vi.mock('../../../src/core/ingestion/languages/dart/captures.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../src/core/ingestion/languages/dart/captures.js')>();
  return {
    ...real,
    emitDartScopeCaptures: (...args: Parameters<typeof real.emitDartScopeCaptures>) => {
      captureProbe.calls.push({ filePath: args[1], languageVersion: args[4] });
      if (captureProbe.failFor.has(args[1])) throw new Error('capture probe failure');
      return real.emitDartScopeCaptures(...args);
    },
  };
});

import { _captureLogger } from '../../../src/core/logger.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { dartProvider } from '../../../src/core/ingestion/languages/dart.js';
import { dartScopeResolver } from '../../../src/core/ingestion/languages/dart/scope-resolver.js';
import {
  captureDartPackageConfig,
  dartSdkLowerBoundLanguageVersion,
  type DartPackageConfig,
} from '../../../src/core/ingestion/languages/dart/package-config.js';
import {
  applyDartPackageLanguageVersions,
  requiresDartPackageSource,
} from '../../../src/core/ingestion/languages/dart/package-language-version.js';
import { selectScopeSourcePathsToRead } from '../../../src/core/ingestion/scope-resolution/pipeline/phase.js';

const MODELS = 'class Other { void save() {} }\nclass User { void save() {} }\n';

/** The capture the parse worker produces: default rules plus the side channel. */
function workerParsedFile(filePath: string, source: string): ParsedFile {
  const parsed = extractParsedFile(dartProvider, source, filePath);
  if (parsed === undefined) throw new Error(`fixture did not extract: ${filePath}`);
  // Same order as the parse worker: capture, then collect for that file.
  return { ...parsed, captureSideChannel: dartProvider.collectCaptureSideChannel?.(filePath) };
}

function packageConfig(versions: readonly (readonly [string, string | null])[]): DartPackageConfig {
  return {
    packages: new Map(),
    manifestsByName: new Map(),
    languageVersionsByDirectory: new Map(versions),
  };
}

describe('Dart SDK constraint lower bound', () => {
  it.each([
    ['>=3.0.0 <4.0.0', '3.0'],
    ['^3.6.0', '3.6'],
    ['3.6.0', '3.6'],
    ['^3.7.0', '3.7'],
    ['^3.10.2', '3.10'],
    ['>3.6.0', '3.6'],
    ['>3.5.0 <4.0.0', '3.5'],
    ['>=2.12.0-0 <3.0.0', '2.12'],
    ['^3.6.0-0', '3.6'],
    ['>=3.0.0-417.0.dev <4.0.0', '3.0'],
    ['>=2.0.0-dev.68.0 <3.0.0', '2.0'],
    ['>=3.0.0<4.0.0', '3.0'],
    ['<4.0.0 >=3.0.0', '3.0'],
    ['<=4.0.0 >3.4.1', '3.4'],
    ['  >=  3.2.0   <  4.0.0  ', '3.2'],
    ['>=3.1.0+build.5 <4.0.0', '3.1'],
    ['>=3.3.0-1.2.beta+exp.sha <4.0.0', '3.3'],
    ['>=2.19.0', '2.19'],
    ['>=3.0.0 >=3.5.0 <4.0.0', '3.5'],
    ['any', null],
    ['', null],
    ['   ', null],
    ['<4.0.0', null],
    ['<=3.6.0', null],
    ['latest', null],
    ['>=3.0.0 or newer', null],
    // pub has no `||`: `VersionConstraint.parse` rejects it as unknown text.
    ['>=3.0.0 <3.5.0 || >=3.7.0 <4.0.0', null],
    ['^three', null],
  ] as const)('reads the language version of %j as %j', (constraint, expected) => {
    expect(dartSdkLowerBoundLanguageVersion(constraint)).toBe(expected);
  });
});

describe('Dart package language-version boundaries', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dart-language-version-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const capture = async (manifests: Record<string, string>): Promise<DartPackageConfig> => {
    for (const [relative, content] of Object.entries(manifests)) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    }
    return captureDartPackageConfig(root, Object.keys(manifests));
  };

  it('registers a boundary for every readable manifest, named or not', async () => {
    const config = await capture({
      'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ^3.7.0\n',
      'rejected/pubspec.yaml': 'name: Inner-App\nenvironment:\n  sdk: ^3.6.0\n',
      'nameless/pubspec.yaml': "environment:\n  sdk: '>=3.0.0-0 <4.0.0'\n",
      'unversioned/pubspec.yaml': 'description: no name and no environment\n',
      'named/pubspec.yaml': "name: named\nenvironment:\n  sdk: '>3.5.0 <4.0.0'\n",
    });
    expect(config.languageVersionsByDirectory).toEqual(
      new Map([
        ['', '3.7'],
        ['rejected', '3.6'],
        ['nameless', '3.0'],
        ['unversioned', null],
        ['named', '3.5'],
      ]),
    );
    expect([...config.packages.keys()].sort()).toEqual(['app', 'named']);
  });

  it('keeps a nested package without a valid name from inheriting the enclosing version', async () => {
    const modernRoot = await capture({
      'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ^3.7.0\n',
      'rejected/pubspec.yaml': 'name: Inner-App\nenvironment:\n  sdk: ^3.6.0\n',
    });
    expect(requiresDartPackageSource('rejected/lib/a.dart', modernRoot)).toBe(true);
    expect(requiresDartPackageSource('lib/a.dart', modernRoot)).toBe(false);
  });

  it('keeps a nested package without a version from inheriting a legacy enclosing version', async () => {
    const legacyRoot = await capture({
      'pubspec.yaml': "name: app\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      'unversioned/pubspec.yaml': 'description: no name and no environment\n',
    });
    expect(requiresDartPackageSource('unversioned/lib/a.dart', legacyRoot)).toBe(false);
    expect(requiresDartPackageSource('lib/a.dart', legacyRoot)).toBe(true);
  });
});

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))(
  'Dart capture-time language-version sensitivity',
  () => {
    beforeEach(() => {
      captureProbe.calls.length = 0;
      captureProbe.failFor.clear();
    });

    const SENSITIVE = { kind: 'dart', packageLanguageVersionSensitive: true } as const;
    it.each([
      ['a parameter named _', 'void f(Other _) { _.save(); }\n', SENSITIVE, true],
      ['a local named _', 'void f() { final _ = Other(); _.save(); }\n', SENSITIVE, true],
      [
        'a closure parameter named _',
        'void f(List<Other> xs) { xs.forEach((_) {}); }\n',
        SENSITIVE,
        true,
      ],
      [
        'a binder named _ after a declaration-level @dart comment, which Dart ignores',
        "import 'models.dart';\n// @dart=3.5\nvoid f(Other _) { _.save(); }\n",
        SENSITIVE,
        true,
      ],
      ['no _ binder', 'void f(Other o) { o.save(); }\n', undefined, false],
      ['a _ read without a binder', 'class A { void f() { _.save(); } }\n', undefined, false],
      [
        'only pattern wildcards',
        'int f(Object o) { final (_, b) = (1, 2); return switch (o) { _ => b }; }\n',
        undefined,
        false,
      ],
      [
        'a _ binder under a legacy file override',
        '// @dart=3.5\nvoid f(Other _) { _.save(); }\n',
        undefined,
        false,
      ],
      [
        'a _ binder under a modern file override',
        '// @dart = 3.8\nvoid f(Other _) { _.save(); }\n',
        undefined,
        false,
      ],
      [
        'a _ binder under an override that follows a licence comment',
        '// Copyright\n// @dart=3.5\nvoid f(Other _) { _.save(); }\n',
        undefined,
        false,
      ],
    ] as const)(
      'records whether the capture depends on the package version: %s',
      (_title, source, sideChannel, sensitive) => {
        const parsed = workerParsedFile('lib/a.dart', source);
        expect(parsed.captureSideChannel).toEqual(sideChannel);
        expect(requiresDartPackageSource('lib/a.dart', packageConfig([['', '3.0']]), parsed)).toBe(
          sensitive,
        );
        expect(requiresDartPackageSource('lib/a.dart', packageConfig([['', '3.7']]), parsed)).toBe(
          false,
        );
      },
    );

    it('does not let one capture answer for another file', () => {
      workerParsedFile('lib/sensitive.dart', 'void f(Other _) {}\n');
      expect(dartProvider.collectCaptureSideChannel?.('lib/other.dart')).toBeUndefined();
      workerParsedFile('lib/plain.dart', 'void f(Other o) {}\n');
      expect(dartProvider.collectCaptureSideChannel?.('lib/sensitive.dart')).toBeUndefined();
    });

    describe('with N reused files of which K have a _ parameter or local', () => {
      const sources: Record<string, string> = {
        'lib/models.dart': MODELS,
        'lib/param.dart':
          "import 'models.dart';\nclass Holder {\n  final _ = User();\n  void f(Other _) { _.save(); }\n}\n",
        'lib/local.dart': "import 'models.dart';\nvoid g() { final _ = Other(); _.save(); }\n",
        'lib/plain.dart': "import 'models.dart';\nvoid h(User u) { u.save(); }\n",
        'lib/pattern.dart': 'int p(Object o) => switch (o) { _ => 0 };\n',
        'lib/override.dart': "// @dart=3.5\nimport 'models.dart';\nvoid o(Other _) { _.save(); }\n",
        'modern/lib/param.dart': 'class M {}\nvoid m(M _) {}\n',
      };
      const paths = Object.keys(sources);
      const legacy = packageConfig([
        ['', '3.0'],
        ['modern', '3.7'],
      ]);
      const reused = (): Map<string, ParsedFile> =>
        new Map(paths.map((filePath) => [filePath, workerParsedFile(filePath, sources[filePath])]));

      it('reads source for exactly the K sensitive files of the legacy package', () => {
        const preExtracted = reused();
        expect(
          selectScopeSourcePathsToRead(dartScopeResolver, paths, preExtracted, legacy),
        ).toEqual(['lib/param.dart', 'lib/local.dart']);
        expect(
          selectScopeSourcePathsToRead(
            dartScopeResolver,
            paths,
            preExtracted,
            packageConfig([['', '3.7']]),
          ),
        ).toEqual([]);
        expect(selectScopeSourcePathsToRead(dartScopeResolver, paths, preExtracted)).toEqual([]);
      });

      it('still reads a file that has no reused record', () => {
        const preExtracted = reused();
        preExtracted.delete('lib/plain.dart');
        expect(
          selectScopeSourcePathsToRead(dartScopeResolver, paths, preExtracted, legacy),
        ).toEqual(['lib/param.dart', 'lib/local.dart', 'lib/plain.dart']);
      });

      it('captures again exactly the K sensitive files and keeps every other record', () => {
        const preExtracted = reused();
        const files = paths.map((filePath) => preExtracted.get(filePath) as ParsedFile);
        const before = [...files];
        captureProbe.calls.length = 0;
        applyDartPackageLanguageVersions(files, {
          fileContents: new Map(Object.entries(sources)),
          resolutionConfig: legacy,
        });
        expect(captureProbe.calls).toEqual([
          { filePath: 'lib/param.dart', languageVersion: '3.0' },
          { filePath: 'lib/local.dart', languageVersion: '3.0' },
        ]);
        expect(files.map((file, index) => file === before[index])).toEqual([
          true,
          false,
          false,
          true,
          true,
          true,
          true,
        ]);
        expect(files.map((file) => file.filePath)).toEqual(paths);
        // The replacement keeps the record that selects it on the next run.
        expect(files[1].captureSideChannel).toEqual(before[1].captureSideChannel);
      });

      it('captures nothing again when the package is modern or has no manifest', () => {
        const preExtracted = reused();
        const files = paths.map((filePath) => preExtracted.get(filePath) as ParsedFile);
        const before = [...files];
        captureProbe.calls.length = 0;
        applyDartPackageLanguageVersions(files, {
          fileContents: new Map(Object.entries(sources)),
          resolutionConfig: packageConfig([['', '3.7']]),
        });
        applyDartPackageLanguageVersions(files, { fileContents: new Map(Object.entries(sources)) });
        expect(captureProbe.calls).toEqual([]);
        expect(files).toEqual(before);
      });

      it.each([
        [
          'is missing from the pass',
          (contents: Map<string, string>) => contents.delete('lib/param.dart'),
        ],
        ['is empty', (contents: Map<string, string>) => contents.set('lib/param.dart', '')],
        [
          'is whitespace only',
          (contents: Map<string, string>) => contents.set('lib/param.dart', ' \n\t\n'),
        ],
      ] as const)('keeps the reused record of a file whose source %s', (_title, damage) => {
        const preExtracted = reused();
        const files = paths.map((filePath) => preExtracted.get(filePath) as ParsedFile);
        const before = [...files];
        const contents = new Map(Object.entries(sources));
        damage(contents);
        captureProbe.calls.length = 0;
        const log = _captureLogger();
        try {
          expect(() =>
            applyDartPackageLanguageVersions(files, {
              fileContents: contents,
              resolutionConfig: legacy,
            }),
          ).not.toThrow();
          expect(log.records()).toEqual([
            expect.objectContaining({
              level: 40,
              reason: 'source-unavailable',
              count: 1,
              relativePaths: ['lib/param.dart'],
            }),
          ]);
        } finally {
          log.restore();
        }
        // The readable sensitive file is still captured again.
        expect(captureProbe.calls).toEqual([
          { filePath: 'lib/local.dart', languageVersion: '3.0' },
        ]);
        expect(files.map((file, index) => file === before[index])).toEqual([
          true,
          true,
          false,
          true,
          true,
          true,
          true,
        ]);
      });

      it('logs one warning for all files whose source is unavailable', () => {
        const preExtracted = reused();
        const files = paths.map((filePath) => preExtracted.get(filePath) as ParsedFile);
        const before = [...files];
        const contents = new Map(Object.entries(sources));
        contents.delete('lib/param.dart');
        contents.set('lib/local.dart', '');
        captureProbe.calls.length = 0;
        const log = _captureLogger();
        try {
          expect(() =>
            applyDartPackageLanguageVersions(files, {
              fileContents: contents,
              resolutionConfig: legacy,
            }),
          ).not.toThrow();
          expect(log.records()).toEqual([
            expect.objectContaining({
              level: 40,
              reason: 'source-unavailable',
              count: 2,
              relativePaths: ['lib/param.dart', 'lib/local.dart'],
            }),
          ]);
        } finally {
          log.restore();
        }
        expect(captureProbe.calls).toEqual([]);
        expect(files.map((file, index) => file === before[index])).toEqual(paths.map(() => true));
      });

      it('keeps the reused record when extraction yields nothing', () => {
        const preExtracted = reused();
        const files = paths.map((filePath) => preExtracted.get(filePath) as ParsedFile);
        const before = [...files];
        captureProbe.failFor.add('lib/param.dart');
        const log = _captureLogger();
        try {
          expect(() =>
            applyDartPackageLanguageVersions(files, {
              fileContents: new Map(Object.entries(sources)),
              resolutionConfig: legacy,
            }),
          ).not.toThrow();
          expect(log.records()).toContainEqual(
            expect.objectContaining({
              level: 40,
              reason: 'extraction-failed',
              count: 1,
              relativePaths: ['lib/param.dart'],
            }),
          );
        } finally {
          log.restore();
        }
        expect(files.map((file, index) => file === before[index])).toEqual([
          true,
          true,
          false,
          true,
          true,
          true,
          true,
        ]);
      });
    });
  },
);
