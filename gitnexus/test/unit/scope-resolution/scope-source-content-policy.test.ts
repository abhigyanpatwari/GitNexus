import { describe, expect, it } from 'vitest';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { selectScopeSourcePathsToRead } from '../../../src/core/ingestion/scope-resolution/pipeline/phase.js';
import { kotlinScopeResolver } from '../../../src/core/ingestion/languages/kotlin/scope-resolver.js';
import { dartScopeResolver } from '../../../src/core/ingestion/languages/dart/scope-resolver.js';

const FILES = ['src/Cached.kt', 'src/Fresh.kt'] as const;
const PRE_EXTRACTED = new Set<string>([FILES[0]]);

describe('scope-resolution source content policy', () => {
  it('reloads only legacy Dart package source, respecting nested package boundaries', () => {
    const files = ['old.dart', 'nested/new.dart', 'plain/current.dart'];
    const config = {
      packages: new Map(),
      manifestsByName: new Map(),
      languageVersionsByDirectory: new Map([
        ['', '3.6'],
        ['nested', '3.7'],
        ['plain', null],
      ]),
    };
    expect(selectScopeSourcePathsToRead(dartScopeResolver, files, new Set(files), config)).toEqual([
      'old.dart',
    ]);
    expect(selectScopeSourcePathsToRead(dartScopeResolver, files, new Set(files))).toEqual([]);
  });
  it('keeps all-file loading as the default for content-capable hooks', () => {
    const defaultPolicyResolver = {
      ...kotlinScopeResolver,
      postExtractSourceTextPolicy: undefined,
    } as ScopeResolver;

    expect(selectScopeSourcePathsToRead(defaultPolicyResolver, FILES, PRE_EXTRACTED)).toEqual(
      FILES,
    );
  });

  it('lets Kotlin reuse side-channel facts without loading cached source text', () => {
    expect(selectScopeSourcePathsToRead(kotlinScopeResolver, FILES, PRE_EXTRACTED)).toEqual([
      FILES[1],
    ]);
  });

  it('still reads uncached files when no post-extraction hook needs source text', () => {
    const hooklessResolver = {
      ...kotlinScopeResolver,
      populateWorkspaceReferences: undefined,
      populateNamespaceSiblings: undefined,
      emitPostResolutionEdges: undefined,
      postExtractSourceTextPolicy: undefined,
    } as ScopeResolver;

    expect(selectScopeSourcePathsToRead(hooklessResolver, FILES, PRE_EXTRACTED)).toEqual([
      FILES[1],
    ]);
  });
});
