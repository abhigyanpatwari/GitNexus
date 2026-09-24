import type { ParsedFile, ScopeResolutionIndexes, SymbolDefinition } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { createJvmPackageSiblingVisibility } from '../../src/core/ingestion/languages/jvm/package-siblings.js';
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

// ─── sibling injection cap (#2732) ───────────────────────────────────
//
// Driven through the shared JVM factory rather than a language facade: the
// cap is language-agnostic, and a synthetic fixture can place candidates at
// chosen path distances without hand-writing hundreds of real sources.

function classDef(nodeId: string, filePath: string, qualifiedName: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Class', qualifiedName } as unknown as SymbolDefinition;
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
      typeBindings: new Map(moduleTypeBindings ?? []),
      ownedDefs: [],
    },
  ];
  if (def !== undefined) {
    scopes.push({
      id: `class:${index}`,
      kind: 'Class',
      parent: moduleId,
      typeBindings: new Map(),
      ownedDefs: [def],
    });
  }
  return { filePath, scopes } as unknown as ParsedFile;
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
    expect([...(injected?.keys() ?? [])].sort()).toEqual([
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
    expect(visibility.isVisibilityIncomplete(targetPath)).toBe(true);
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
    expect([...(targetModule?.typeBindings.keys() ?? [])].sort()).toEqual([
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

    expect(indexes.bindingAugmentations.get('module:0')?.size).toBe(10);
    expect(visibility.isVisibilityIncomplete(targetPath)).toBe(false);
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

    expect(indexes.bindingAugmentations.get('module:0')?.size).toBe(200);
    expect(visibility.isVisibilityIncomplete(targetPath)).toBe(true);
  });
});
