import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureDartPackageConfig,
  dartSdkLowerBoundLanguageVersion,
  type DartPackageConfig,
} from '../../../src/core/ingestion/languages/dart/package-config.js';
import { requiresDartPackageSource } from '../../../src/core/ingestion/languages/dart/package-language-version.js';

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
