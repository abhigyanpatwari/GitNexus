import type { ParsedFile, ScopeResolutionIndexes } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import {
  isJavaPackageSiblingVisibilityIncomplete,
  populateJavaPackageSiblings,
} from '../../src/core/ingestion/languages/java/package-siblings.js';
import { setJavaPackageFact } from '../../src/core/ingestion/languages/java/package-facts.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import {
  isKotlinPackageSiblingVisibilityIncomplete,
  populateKotlinPackageSiblings,
} from '../../src/core/ingestion/languages/kotlin/package-siblings.js';
import { setKotlinPackageFact } from '../../src/core/ingestion/languages/kotlin/package-facts.js';
import type { JvmPackageFact } from '../../src/core/ingestion/languages/jvm/package-facts.js';

interface LanguagePackageHarness {
  readonly label: string;
  readonly extension: string;
  readonly namedSource: string;
  readonly defaultSource: string;
  readonly malformedSource: string;
  readonly brokenBodySource: string;
  readonly emit: (source: string, filePath: string) => unknown;
  readonly collect: (filePath: string) => { packageFact: JvmPackageFact } | undefined;
  readonly setFact: (filePath: string, fact: JvmPackageFact) => void;
  readonly populate: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    context: { fileContents: ReadonlyMap<string, string> },
  ) => void;
  readonly isIncomplete: (filePath: string) => boolean;
}

const harnesses: readonly LanguagePackageHarness[] = [
  {
    label: 'Java',
    extension: '.java',
    namedSource: 'package com.example;\nclass Named {}',
    defaultSource: 'class Default {}',
    malformedSource: 'package ;\nclass Malformed {}',
    brokenBodySource: 'package com.valid;\nclass Broken { void f( }',
    emit: emitJavaScopeCaptures,
    collect: collectJavaCaptureSideChannel,
    setFact: setJavaPackageFact,
    populate: populateJavaPackageSiblings,
    isIncomplete: isJavaPackageSiblingVisibilityIncomplete,
  },
  {
    label: 'Kotlin',
    extension: '.kt',
    namedSource: 'package com.example\nclass Named',
    defaultSource: 'class Default',
    malformedSource: 'package ;\nclass Malformed',
    brokenBodySource: 'package com.valid\nclass Broken { fun f( }',
    emit: emitKotlinScopeCaptures,
    collect: collectKotlinCaptureSideChannel,
    setFact: setKotlinPackageFact,
    populate: populateKotlinPackageSiblings,
    isIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
  },
];

function parsedFile(filePath: string, index: number): ParsedFile {
  return {
    filePath,
    scopes: [
      {
        id: `module:${index}`,
        kind: 'Module',
        typeBindings: new Map(),
        ownedDefs: [],
      },
    ],
  } as unknown as ParsedFile;
}

function emptyIndexes(): ScopeResolutionIndexes {
  return { bindingAugmentations: new Map() } as unknown as ScopeResolutionIndexes;
}

for (const harness of harnesses) {
  describe(`${harness.label} JVM package facts`, () => {
    it('captures named/default packages and isolates package-header errors', () => {
      const namedPath = `src/Named${harness.extension}`;
      harness.emit(harness.namedSource, namedPath);
      expect(harness.collect(namedPath)?.packageFact).toEqual({
        status: 'known',
        packageName: 'com.example',
      });

      const defaultPath = `src/Default${harness.extension}`;
      harness.emit(harness.defaultSource, defaultPath);
      expect(harness.collect(defaultPath)?.packageFact).toEqual({
        status: 'known',
        packageName: '',
      });

      const malformedPath = `src/Malformed${harness.extension}`;
      harness.emit(harness.malformedSource, malformedPath);
      expect(harness.collect(malformedPath)?.packageFact).toEqual({ status: 'unknown' });

      const brokenBodyPath = `src/BrokenBody${harness.extension}`;
      harness.emit(harness.brokenBodySource, brokenBodyPath);
      expect(harness.collect(brokenBodyPath)?.packageFact).toEqual({
        status: 'known',
        packageName: 'com.valid',
      });
    });

    it('marks a capped package incomplete without affecting other package names', () => {
      const source = harness.namedSource;
      const parsedFiles = Array.from({ length: 501 }, (_, index) => {
        const filePath = `src/com/capped/Type${index}${harness.extension}`;
        harness.setFact(filePath, { status: 'known', packageName: 'com.capped' });
        return parsedFile(filePath, index);
      });
      const fileContents = new Map(parsedFiles.map((parsed) => [parsed.filePath, source]));

      harness.populate(parsedFiles, emptyIndexes(), { fileContents });

      expect(harness.isIncomplete(parsedFiles[0].filePath)).toBe(true);
      expect(harness.isIncomplete(`src/other/Complete${harness.extension}`)).toBe(false);
    });

    it('fails wildcard visibility closed when a source file produced no ParsedFile', () => {
      const first = parsedFile(`src/A${harness.extension}`, 1);
      const second = parsedFile(`src/B${harness.extension}`, 2);
      harness.setFact(first.filePath, { status: 'known', packageName: 'com.example' });
      harness.setFact(second.filePath, { status: 'known', packageName: 'com.example' });
      const skippedPath = `src/Skipped${harness.extension}`;
      const fileContents = new Map([
        [first.filePath, harness.namedSource],
        [second.filePath, harness.namedSource],
        [skippedPath, harness.malformedSource],
      ]);

      harness.populate([first, second], emptyIndexes(), { fileContents });

      expect(harness.isIncomplete(first.filePath)).toBe(true);
      expect(harness.isIncomplete(second.filePath)).toBe(true);
    });
  });
}
