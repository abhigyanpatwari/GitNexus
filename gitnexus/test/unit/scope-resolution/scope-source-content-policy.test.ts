import { describe, expect, it } from 'vitest';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { selectScopeSourcePathsToRead } from '../../../src/core/ingestion/scope-resolution/pipeline/phase.js';
import { kotlinScopeResolver } from '../../../src/core/ingestion/languages/kotlin/scope-resolver.js';

const FILES = ['src/Cached.kt', 'src/Fresh.kt'] as const;
const PRE_EXTRACTED = new Set<string>([FILES[0]]);

describe('scope-resolution source content policy', () => {
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
      populateNamespaceSiblings: undefined,
      emitPostResolutionEdges: undefined,
      postExtractSourceTextPolicy: undefined,
    } as ScopeResolver;

    expect(selectScopeSourcePathsToRead(hooklessResolver, FILES, PRE_EXTRACTED)).toEqual([
      FILES[1],
    ]);
  });
});
