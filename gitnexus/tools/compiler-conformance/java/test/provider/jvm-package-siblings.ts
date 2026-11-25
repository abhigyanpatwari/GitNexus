import { compareCodeUnits } from '../../../compare.mjs';
import { createJvmPackageSiblingVisibility } from '../../../../../src/core/ingestion/languages/jvm/package-siblings.js';
import type { ScopeResolutionIndexes } from '../../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectJavaCaptureSideChannel } from '../../../../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';
import {
  isJavaPackageSiblingVisibilityIncomplete,
  populateJavaPackageSiblings,
} from '../../../../../src/core/ingestion/languages/java/package-siblings.js';
import { setJavaPackageFact } from '../../../../../src/core/ingestion/languages/java/package-facts.js';
import type { JvmPackageFact } from '../../../../../src/core/ingestion/languages/jvm/package-facts.js';

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
];

/** A file with only a module scope — `moduleWithClass` without the class half. */
function parsedFile(filePath: string, index: number): ParsedFile {
  return moduleWithClass(filePath, index);
}

function emptyIndexes(): ScopeResolutionIndexes {
  return { bindingAugmentations: new Map() } as unknown as ScopeResolutionIndexes;
}

for (const harness of harnesses) {
  describe(`${harness.label} JVM package facts`, () => {
    it('captures named/default packages and isolates package-header errors', () => {
      const namedPath = `src/Named${harness.extension}`;
      harness.emit(harness.namedSource, namedPath);
      assert.deepEqual(harness.collect(namedPath)?.packageFact, {
        status: 'known',
        packageName: 'com.example',
      });

      const defaultPath = `src/Default${harness.extension}`;
      harness.emit(harness.defaultSource, defaultPath);
      assert.deepEqual(harness.collect(defaultPath)?.packageFact, {
        status: 'known',
        packageName: '',
      });

      const malformedPath = `src/Malformed${harness.extension}`;
      harness.emit(harness.malformedSource, malformedPath);
      assert.deepEqual(harness.collect(malformedPath)?.packageFact, { status: 'unknown' });

      const brokenBodyPath = `src/BrokenBody${harness.extension}`;
      harness.emit(harness.brokenBodySource, brokenBodyPath);
      assert.deepEqual(harness.collect(brokenBodyPath)?.packageFact, {
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

      assert.equal(harness.isIncomplete(parsedFiles[0].filePath), true);
      assert.equal(harness.isIncomplete(`src/other/Complete${harness.extension}`), false);
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

      assert.equal(harness.isIncomplete(first.filePath), true);
      assert.equal(harness.isIncomplete(second.filePath), true);
    });
  });
}

function moduleWithClass(
  filePath: string,
  index: number,
  def?: SymbolDefinition,
  moduleTypeBindings?: ReadonlyMap<string, unknown>,
): ParsedFile {
  const moduleId = `module:${index}`;
  const scopes: Record<string, unknown>[] = [
    {
      id: moduleId,
      kind: 'Module',
      bindings: new Map(),
      typeBindings: new Map(moduleTypeBindings ?? []),
      ownedDefs: [],
    },
  ];
  if (def !== undefined) {
    scopes.push({
      id: `class:${index}`,
      kind: 'Class',
      parent: moduleId,
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [def],
    });
  }
  return { filePath, scopes } as unknown as ParsedFile;
}

function classDef(nodeId: string, filePath: string, qualifiedName: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Class', qualifiedName } as unknown as SymbolDefinition;
}

function jvmVisibility(facts: ReadonlyMap<string, JvmPackageFact>) {
  return createJvmPackageSiblingVisibility({
    languageLabel: 'JVM',
    getPackageFact: (filePath) => facts.get(filePath),
  });
}

/**
 * `count` siblings of `com.example`, interleaved near/far so the retained set
 * cannot be produced by simply truncating the input order: every odd index is
 * a distant `vendor/` file, every even index sits beside the target. A working
 * proximity sort keeps the near half; plain truncation would keep half of each.
 */
function interleavedPackage(
  targetPath: string,
  count: number,
  moduleBinding?: (siblingName: string) => ReadonlyMap<string, unknown>,
): { parsedFiles: ParsedFile[]; facts: Map<string, JvmPackageFact> } {
  const facts = new Map<string, JvmPackageFact>();
  facts.set(targetPath, { status: 'known', packageName: 'com.example' });
  const parsedFiles = [moduleWithClass(targetPath, 0)];
  for (let index = 0; index < count; index++) {
    const isFar = index % 2 === 1;
    const name = isFar ? `FarType${index}` : `NearType${index}`;
    const filePath = isFar ? `vendor/generated/${name}.java` : `src/com/example/near/${name}.java`;
    facts.set(filePath, { status: 'known', packageName: 'com.example' });
    parsedFiles.push(
      moduleWithClass(
        filePath,
        index + 1,
        classDef(`class:${index}`, filePath, `com.example.${name}`),
        moduleBinding?.(name),
      ),
    );
  }
  return { parsedFiles, facts };
}

function withMaxInjectedSiblings<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  if (value === undefined) delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  else process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
    else process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = previous;
  }
}

describe('JVM sibling injection cap (#2732)', () => {
  const targetPath = 'src/com/example/Target.java';

  it('keeps the nearest siblings, drops the rest, and injects exactly the cap', () => {
    const { parsedFiles, facts } = interleavedPackage(targetPath, 10);
    const visibility = jvmVisibility(facts);
    const indexes = emptyIndexes();

    withMaxInjectedSiblings('4', () =>
      visibility.populateNamespaceSiblings(parsedFiles, indexes, {
        fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
      }),
    );

    const injected = indexes.bindingAugmentations.get('module:0');
    assert.deepEqual([...(injected?.keys() ?? [])].sort(compareCodeUnits), [
      'NearType0',
      'NearType2',
      'NearType4',
      'NearType6',
    ]);
  });

  it('marks a file whose sibling set was truncated as visibility-incomplete', () => {
    const { parsedFiles, facts } = interleavedPackage(targetPath, 10);
    const visibility = jvmVisibility(facts);

    withMaxInjectedSiblings('4', () =>
      visibility.populateNamespaceSiblings(parsedFiles, emptyIndexes(), {
        fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
      }),
    );

    // Spring bean/DI/conditional attribution keys off this flag; a truncated
    // sibling set must never read as exact package visibility.
    assert.equal(visibility.isVisibilityIncomplete(targetPath), true);
  });

  it('bounds type bindings by the same sibling set it bounded bindings by', () => {
    // Each sibling module scope carries a type binding named after itself, so
    // the merged set names exactly which siblings were treated as visible.
    const { parsedFiles, facts } = interleavedPackage(
      targetPath,
      10,
      (name) => new Map([[`Binding_${name}`, { source: 'import' }]]),
    );
    const visibility = jvmVisibility(facts);

    withMaxInjectedSiblings('4', () =>
      visibility.populateNamespaceSiblings(parsedFiles, emptyIndexes(), {
        fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
      }),
    );

    const targetModule = parsedFiles[0].scopes.find((scope) => scope.kind === 'Module');
    assert.deepEqual([...(targetModule?.typeBindings.keys() ?? [])].sort(compareCodeUnits), [
      'Binding_NearType0',
      'Binding_NearType2',
      'Binding_NearType4',
      'Binding_NearType6',
    ]);
  });

  it('injects every sibling and stays complete when the cap is disabled', () => {
    const { parsedFiles, facts } = interleavedPackage(targetPath, 10);
    const visibility = jvmVisibility(facts);
    const indexes = emptyIndexes();

    withMaxInjectedSiblings('0', () =>
      visibility.populateNamespaceSiblings(parsedFiles, indexes, {
        fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
      }),
    );

    assert.equal(indexes.bindingAugmentations.get('module:0')?.size, 10);
    assert.equal(visibility.isVisibilityIncomplete(targetPath), false);
  });

  it('applies the documented default of 200 when the env var is unset', () => {
    const { parsedFiles, facts } = interleavedPackage(targetPath, 402);
    const visibility = jvmVisibility(facts);
    const indexes = emptyIndexes();

    withMaxInjectedSiblings(undefined, () =>
      visibility.populateNamespaceSiblings(parsedFiles, indexes, {
        fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
      }),
    );

    assert.equal(indexes.bindingAugmentations.get('module:0')?.size, 200);
    assert.equal(visibility.isVisibilityIncomplete(targetPath), true);
  });
});
