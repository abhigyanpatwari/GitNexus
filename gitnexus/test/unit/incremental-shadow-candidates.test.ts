import { describe, it, expect } from 'vitest';
import { shadowCandidatesFor } from '../../src/core/incremental/shadow-candidates.js';

describe('shadowCandidatesFor', () => {
  it('returns an empty list when the input has no recognised module extension', () => {
    expect(shadowCandidatesFor('README.md')).toEqual([]);
    expect(shadowCandidatesFor('src/foo')).toEqual([]);
    expect(shadowCandidatesFor('binary.so')).toEqual([]);
  });

  it('enumerates same-basename / different-extension candidates (pattern a)', () => {
    const out = shadowCandidatesFor('src/foo/bar.ts');
    // All non-.ts module extensions on the same path should appear.
    expect(out).toContain('src/foo/bar.tsx');
    expect(out).toContain('src/foo/bar.js');
    expect(out).toContain('src/foo/bar.jsx');
    expect(out).toContain('src/foo/bar.mjs');
    expect(out).toContain('src/foo/bar.cjs');
    expect(out).toContain('src/foo/bar.d.ts');
    // ...but NOT the same .ts (you can't shadow yourself).
    expect(out).not.toContain('src/foo/bar.ts');
  });

  it('enumerates directory-style index candidates (pattern b) for both path separators', () => {
    const out = shadowCandidatesFor('src/foo/bar.ts');
    // POSIX form
    expect(out).toContain('src/foo/bar/index.ts');
    expect(out).toContain('src/foo/bar/index.tsx');
    expect(out).toContain('src/foo/bar/index.js');
    // Windows form
    expect(out).toContain('src/foo/bar\\index.ts');
    expect(out).toContain('src/foo/bar\\index.js');
  });

  it('enumerates bare-file shadows when the added file is a directory index (pattern c)', () => {
    const out = shadowCandidatesFor('src/foo/index.ts');
    // Adding foo/index.ts can shadow foo.{ext} (rare but real — converting
    // a single-file module into a directory module).
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('src/foo.tsx');
    expect(out).toContain('src/foo.js');
    expect(out).toContain('src/foo.jsx');
    expect(out).toContain('src/foo.mjs');
    expect(out).toContain('src/foo.cjs');
  });

  it('also handles the Windows-separator form of `foo\\index.ts`', () => {
    const out = shadowCandidatesFor('src\\foo\\index.ts');
    expect(out).toContain('src\\foo.ts');
    expect(out).toContain('src\\foo.tsx');
    expect(out).toContain('src\\foo.js');
  });

  it('handles `.d.ts` as a single extension token (not `.ts`)', () => {
    // The longest-match scan in shadowCandidatesFor puts `.d.ts` first.
    // For `foo.d.ts`, the noExt portion is "foo" (not "foo.d"), so the
    // pattern (a) candidates should be the non-.d.ts module variants.
    const out = shadowCandidatesFor('types/foo.d.ts');
    expect(out).toContain('types/foo.ts');
    expect(out).toContain('types/foo.tsx');
    expect(out).toContain('types/foo.js');
    // Not the .d.ts itself.
    expect(out).not.toContain('types/foo.d.ts');
  });

  it('deduplicates output (no candidate appears twice)', () => {
    const out = shadowCandidatesFor('src/foo/bar.ts');
    expect(out.length).toBe(new Set(out).size);
  });

  it('never includes the input path itself', () => {
    const input = 'src/foo/bar.ts';
    expect(shadowCandidatesFor(input)).not.toContain(input);
  });
});
