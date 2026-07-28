import type { ParsedFile, ScopeResolutionIndexes, SymbolDefinition } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import {
  createJvmPackageSiblingVisibility,
  type JvmPackageFact,
  type JvmPackageSiblingVisibility,
} from '../../src/core/ingestion/languages/jvm/package-siblings.js';

function parsedFile(filePath: string, index: number, classDef?: SymbolDefinition): ParsedFile {
  const moduleId = `module:${index}`;
  const scopes: Record<string, unknown>[] = [
    {
      id: moduleId,
      kind: 'Module',
      typeBindings: new Map(),
      ownedDefs: [],
    },
  ];
  if (classDef !== undefined) {
    scopes.push({
      id: `class:${index}`,
      kind: 'Class',
      parent: moduleId,
      typeBindings: new Map(),
      ownedDefs: [classDef],
    });
  }
  return { filePath, scopes } as unknown as ParsedFile;
}

function classDef(nodeId: string, filePath: string, name: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Class', qualifiedName: name };
}

function emptyIndexes(): ScopeResolutionIndexes {
  return { bindingAugmentations: new Map() } as unknown as ScopeResolutionIndexes;
}

function makeVisibility(facts: ReadonlyMap<string, JvmPackageFact>): JvmPackageSiblingVisibility {
  return createJvmPackageSiblingVisibility({
    languageLabel: 'JVM',
    getPackageFact: (filePath) => facts.get(filePath),
  });
}

describe('JVM package sibling visibility', () => {
  it('marks a capped package incomplete without affecting other package names', () => {
    const facts = new Map<string, JvmPackageFact>();
    const parsedFiles = Array.from({ length: 501 }, (_, index) => {
      const filePath = `src/com/capped/Type${index}.java`;
      facts.set(filePath, { status: 'known', packageName: 'com.capped' });
      return parsedFile(filePath, index);
    });
    const visibility = makeVisibility(facts);

    visibility.populateNamespaceSiblings(parsedFiles, emptyIndexes(), {
      fileContents: new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}'])),
    });

    expect(visibility.isVisibilityIncomplete(parsedFiles[0].filePath)).toBe(true);
    expect(visibility.isVisibilityIncomplete('src/other/Complete.java')).toBe(false);
  });

  it('caps injected siblings by proximity while allowing an unbounded override', () => {
    const facts = new Map<string, JvmPackageFact>();
    const targetPath = 'src/com/example/Target.java';
    const candidateCount = 201;
    const parsedFiles = [
      parsedFile(targetPath, 0),
      ...Array.from({ length: candidateCount }, (_, index) => {
        const isFar = index === candidateCount - 1;
        const filePath = isFar
          ? 'vendor/FarType.java'
          : `src/com/example/near/NearType${index}.java`;
        const name = isFar ? 'FarType' : `NearType${index}`;
        facts.set(filePath, { status: 'known', packageName: 'com.example' });
        return parsedFile(
          filePath,
          index + 1,
          classDef(`class:${index}`, filePath, `com.example.${name}`),
        );
      }),
    ];
    facts.set(targetPath, { status: 'known', packageName: 'com.example' });
    const fileContents = new Map(parsedFiles.map((parsed) => [parsed.filePath, 'class Type {}']));
    const visibility = makeVisibility(facts);
    const previous = process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;

    try {
      delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
      const cappedIndexes = emptyIndexes();
      visibility.populateNamespaceSiblings(parsedFiles, cappedIndexes, { fileContents });
      const capped = cappedIndexes.bindingAugmentations.get('module:0');
      expect(capped?.get('NearType0')).toBeDefined();
      expect(capped?.get('FarType')).toBeUndefined();

      process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = '0';
      const unboundedIndexes = emptyIndexes();
      visibility.populateNamespaceSiblings(parsedFiles, unboundedIndexes, { fileContents });
      expect(unboundedIndexes.bindingAugmentations.get('module:0')?.get('FarType')).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
      else process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = previous;
    }
  });

  it('fails wildcard visibility closed when a source file produced no ParsedFile', () => {
    const first = parsedFile('src/A.java', 1);
    const second = parsedFile('src/B.java', 2);
    const facts = new Map<string, JvmPackageFact>([
      [first.filePath, { status: 'known', packageName: 'com.example' }],
      [second.filePath, { status: 'known', packageName: 'com.example' }],
    ]);
    const visibility = makeVisibility(facts);

    visibility.populateNamespaceSiblings([first, second], emptyIndexes(), {
      fileContents: new Map([
        [first.filePath, 'class A {}'],
        [second.filePath, 'class B {}'],
        ['src/Skipped.java', 'package ;'],
      ]),
    });

    expect(visibility.isVisibilityIncomplete(first.filePath)).toBe(true);
    expect(visibility.isVisibilityIncomplete(second.filePath)).toBe(true);
  });
});
