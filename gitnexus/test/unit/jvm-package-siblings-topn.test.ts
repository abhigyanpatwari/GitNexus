import type { ParsedFile, ScopeResolutionIndexes, BindingRef } from 'gitnexus-shared';
import { describe, expect, it, afterEach } from 'vitest';

/**
 * Regression tests for Top-N proximity-bounded sibling injection.
 *
 * The generic `createJvmPackageSiblingVisibility` evaluates
 * `MAX_INJECTED_SIBLINGS` at module load time via an IIFE. We use
 * `vi.resetModules()` + dynamic import to get a fresh module instance
 * under each env configuration, then verify that only the nearest N
 * siblings are injected and farther siblings are excluded.
 */

const GENERIC_MODULE = '../../src/core/ingestion/languages/jvm/package-siblings.js';

async function loadWithEnv(injectedCap: string | undefined, packageCap: string | undefined) {
  const { vi } = await import('vitest');
  vi.resetModules();

  if (injectedCap === undefined) {
    delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  } else {
    process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = injectedCap;
  }

  if (packageCap === undefined) {
    delete process.env.GITNEXUS_MAX_PACKAGE_FILES;
  } else {
    process.env.GITNEXUS_MAX_PACKAGE_FILES = packageCap;
  }

  return await import(GENERIC_MODULE);
}

/** Build a ParsedFile with a Module scope and a top-level Class scope. */
function makeFileWithClass(filePath: string, index: number, className: string): ParsedFile {
  const moduleId = `module:${index}`;
  return {
    filePath,
    scopes: [
      {
        id: moduleId,
        kind: 'Module',
        parent: undefined,
        typeBindings: new Map(),
        ownedDefs: [],
      },
      {
        id: `class:${index}`,
        kind: 'Class',
        parent: moduleId,
        typeBindings: new Map(),
        ownedDefs: [
          {
            nodeId: `node:${className}`,
            type: 'Class',
            qualifiedName: `com.example.${className}`,
          },
        ],
      },
    ],
  } as unknown as ParsedFile;
}

function emptyIndexes(): ScopeResolutionIndexes {
  return { bindingAugmentations: new Map() } as unknown as ScopeResolutionIndexes;
}

/** Build options compatible with createJvmPackageSiblingVisibility. */
function makeOptions() {
  const facts = new Map<string, { status: 'known'; packageName: string }>();
  const options = {
    languageLabel: 'Test',
    getPackageFact: (filePath: string) => facts.get(filePath),
  };
  return { options, facts };
}

describe('MAX_PACKAGE_FILES env override', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_MAX_PACKAGE_FILES;
    delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  });

  it('defaults to 500 when env var is not set', async () => {
    const mod = await loadWithEnv(undefined, undefined);
    expect(mod.MAX_PACKAGE_FILES).toBe(500);
  });

  it('respects a valid positive integer override', async () => {
    const mod = await loadWithEnv(undefined, '5000');
    expect(mod.MAX_PACKAGE_FILES).toBe(5000);
  });

  it('falls back to default for non-integer values', async () => {
    const mod = await loadWithEnv(undefined, 'abc');
    expect(mod.MAX_PACKAGE_FILES).toBe(500);
  });

  it('falls back to default for values below 1', async () => {
    const mod = await loadWithEnv(undefined, '0');
    expect(mod.MAX_PACKAGE_FILES).toBe(500);
  });
});

describe('MAX_INJECTED_SIBLINGS env override', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_MAX_PACKAGE_FILES;
    delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  });

  it('defaults to 200 when env var is not set', async () => {
    const mod = await loadWithEnv(undefined, undefined);
    expect(mod.MAX_INJECTED_SIBLINGS).toBe(200);
  });

  it('respects a valid positive integer override', async () => {
    const mod = await loadWithEnv('50', undefined);
    expect(mod.MAX_INJECTED_SIBLINGS).toBe(50);
  });

  it('falls back to default for non-integer values', async () => {
    const mod = await loadWithEnv('not-a-number', undefined);
    expect(mod.MAX_INJECTED_SIBLINGS).toBe(200);
  });

  it('falls back to default for values below 1', async () => {
    const mod = await loadWithEnv('-1', undefined);
    expect(mod.MAX_INJECTED_SIBLINGS).toBe(200);
  });
});

describe('Top-N proximity-bounded sibling injection', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_MAX_PACKAGE_FILES;
    delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  });

  it('injects only the nearest N siblings and excludes farther ones', async () => {
    // Use a small cap so we can verify exclusion with few files.
    const mod = await loadWithEnv('3', undefined);
    const { createJvmPackageSiblingVisibility } = mod;

    // Create 5 files in the same package, each with a unique class.
    // 3 "near" files share a long path prefix with the target file.
    // 2 "far" files share a shorter prefix.
    const files: ParsedFile[] = [
      makeFileWithClass('src/com/example/near/A', 0, 'A'),
      makeFileWithClass('src/com/example/near/B', 1, 'B'),
      makeFileWithClass('src/com/example/near/C', 2, 'C'),
      makeFileWithClass('src/com/example/near/D', 3, 'D'),
      makeFileWithClass('src/com/example/near/E', 4, 'E'),
      makeFileWithClass('src/com/other/far/F', 5, 'F'),
      makeFileWithClass('src/com/other/far/G', 6, 'G'),
    ];

    const opts = makeOptions();
    for (const f of files) {
      opts.facts.set(f.filePath, { status: 'known', packageName: 'com.example' });
    }

    const fileContents = new Map(files.map((f) => [f.filePath, 'class X {}']));

    const indexes = emptyIndexes();
    const visibility = createJvmPackageSiblingVisibility(opts.options);
    visibility.populateNamespaceSiblings(files, indexes, { fileContents });

    // Check module scope of file A (index 0).
    // File A shares 4 path segments with B,C,D,E (src/com/example/near/)
    // but only 2 with F,G (src/com/). So with cap=3, A gets B,C,D (nearest
    // 3 by proximity) but NOT E,F,G.
    const aug = indexes.bindingAugmentations as Map<string, Map<string, BindingRef[]>>;
    const moduleScopeId = 'module:0';
    const scopeBindings = aug.get(moduleScopeId);

    expect(scopeBindings).toBeDefined();
    // With cap=3, at most 3 sibling classes should be injected (B, C, D).
    // E is the 4th nearest and should be excluded.
    const injectedNames = new Set<string>();
    for (const bindings of scopeBindings!.values()) {
      for (const b of bindings) {
        if (b.def.qualifiedName) {
          injectedNames.add(b.def.qualifiedName);
        }
      }
    }
    // B, C, D are nearest (same dir, closest); E is 4th nearest; F, G are farthest.
    expect(injectedNames.has('com.example.B')).toBe(true);
    expect(injectedNames.has('com.example.C')).toBe(true);
    expect(injectedNames.has('com.example.D')).toBe(true);
    // E is the 4th nearest — exceeds cap=3 and must be excluded.
    expect(injectedNames.has('com.example.E')).toBe(false);
    // F, G are even farther.
    expect(injectedNames.has('com.example.F')).toBe(false);
    expect(injectedNames.has('com.example.G')).toBe(false);
  });

  it('does not cap when siblings are within the limit', async () => {
    // With cap=200 (default) and only 3 siblings, all should be injected.
    const mod = await loadWithEnv(undefined, undefined);
    const { createJvmPackageSiblingVisibility } = mod;

    const files: ParsedFile[] = [
      makeFileWithClass('src/com/example/A', 0, 'A'),
      makeFileWithClass('src/com/example/B', 1, 'B'),
      makeFileWithClass('src/com/example/C', 2, 'C'),
    ];

    const opts = makeOptions();
    for (const f of files) {
      opts.facts.set(f.filePath, { status: 'known', packageName: 'com.example' });
    }

    const fileContents = new Map(files.map((f) => [f.filePath, 'class X {}']));
    const indexes = emptyIndexes();
    const visibility = createJvmPackageSiblingVisibility(opts.options);
    visibility.populateNamespaceSiblings(files, indexes, { fileContents });

    const aug = indexes.bindingAugmentations as Map<string, Map<string, BindingRef[]>>;
    const scopeBindings = aug.get('module:0');
    expect(scopeBindings).toBeDefined();

    const injectedNames = new Set<string>();
    for (const bindings of scopeBindings!.values()) {
      for (const b of bindings) {
        if (b.def.qualifiedName) {
          injectedNames.add(b.def.qualifiedName);
        }
      }
    }
    expect(injectedNames.has('com.example.B')).toBe(true);
    expect(injectedNames.has('com.example.C')).toBe(true);
  });
});
