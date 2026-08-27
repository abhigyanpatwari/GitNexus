import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHardcodedIgnoredDirectory, shouldIgnorePath } from '../../src/config/ignore-service.js';
import { hasRuntimeAdd, setEntries } from '../helpers/ignore-set-source.js';

/**
 * Emitted build output must not be indexed as source (#3007).
 *
 * `.next` (the build cache) was listed but `_next` (the emitted output) was
 * not, so a Capacitor/Cordova shell that copies a Next.js bundle into
 * `<platform>/app/src/main/assets/public/_next/static/` had its shipped bundle
 * indexed as source — and every `Route` node the repo produced pointed at a
 * webpack bundle instead of code anyone wrote.
 */

describe('build-output ignores', () => {
  it('ignores emitted _next output, including the Capacitor/Cordova copy', () => {
    expect(shouldIgnorePath('_next/static/chunks/main.js')).toBe(true);
    expect(shouldIgnorePath('.next/server/app/page.js')).toBe(true);
    expect(
      shouldIgnorePath(
        'android/app/src/main/assets/public/_next/static/chunks/6862-9d1cdcb99f169a06.js',
      ),
    ).toBe(true);
    expect(shouldIgnorePath('ios/App/App/public/_next/static/chunks/framework-abc123.js')).toBe(
      true,
    );
  });

  it('does not ignore ordinary source that merely mentions next', () => {
    expect(shouldIgnorePath('src/next-steps.ts')).toBe(false);
    expect(shouldIgnorePath('src/nextConfig/index.ts')).toBe(false);
    expect(shouldIgnorePath('packages/next-auth/src/index.ts')).toBe(false);
  });

  it('matches _next as a whole segment, not as a substring', () => {
    // Without these, `normalizedPath.includes('_next')` would satisfy every
    // other assertion in this file — the suite could not tell a segment rule
    // from a substring rule, and a substring rule would eat real source.
    expect(shouldIgnorePath('src/_nextgen/index.ts')).toBe(false);
    expect(shouldIgnorePath('packages/my_next/src/index.ts')).toBe(false);
    expect(shouldIgnorePath('src/prefix_next.ts')).toBe(false);
  });

  it('keeps public/build ignored after the inert name-set entry was removed', () => {
    // NOT a regression test for new behavior — it pins that DELETING the inert
    // `'public/build'` entry changed nothing, because bare `'build'` matches
    // these as an ordinary segment and always did. Green on both sides of the
    // change by design; that is the point.
    expect(shouldIgnorePath('public/build/entry.client.js')).toBe(true);
    expect(shouldIgnorePath('apps/web/public/build/manifest.js')).toBe(true);
  });

  it('does not ignore public/ or build/-adjacent source outside that pair', () => {
    expect(shouldIgnorePath('public/favicon-loader.ts')).toBe(false);
    expect(shouldIgnorePath('src/public/api.ts')).toBe(false);
  });

  describe('single-component set guards', () => {
    const source = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'src',
        'config',
        'ignore-service.ts',
      ),
      'utf8',
    );

    // Every one of these sets is compared against a single path component, so a
    // member containing `/` is dead on arrival — the defect that left
    // `'public/build'` inert. Counts are pinned exactly rather than floored: a
    // floor cannot protect a two-member set, and it hides a partial parse.
    const SETS = [
      { marker: 'const DEFAULT_IGNORE_LIST = new Set([', name: 'DEFAULT_IGNORE_LIST', size: 76 },
      { marker: 'const IGNORED_FILES = new Set([', name: 'IGNORED_FILES', size: 33 },
      {
        marker: 'const ROOT_ARTIFACT_DIRECTORIES = new Set([',
        name: 'ROOT_ARTIFACT_DIRECTORIES',
        size: 2,
      },
      { marker: 'const IGNORED_EXTENSIONS = new Set([', name: 'IGNORED_EXTENSIONS', size: 104 },
    ] as const;

    it.each(SETS)('$name holds no slash-bearing member', ({ marker }) => {
      expect(setEntries(source, marker).filter((entry) => entry.includes('/'))).toEqual([]);
    });

    it.each(SETS)('$name parses to its pinned size', ({ marker, size }) => {
      expect(setEntries(source, marker)).toHaveLength(size);
    });

    it.each(SETS)('$name holds no duplicate member', ({ marker }) => {
      const entries = setEntries(source, marker);
      expect(new Set(entries).size).toBe(entries.length);
    });

    it.each(SETS)('$name is never mutated by .add() after construction', ({ name }) => {
      expect(hasRuntimeAdd(source, name)).toBe(false);
    });

    it('every IGNORED_EXTENSIONS member starts with a dot', () => {
      const entries = setEntries(source, 'const IGNORED_EXTENSIONS = new Set([');
      expect(entries.filter((entry) => !entry.startsWith('.'))).toEqual([]);
    });

    it('reads entries the declaration holds, not text the comments quote', () => {
      // The comments in DEFAULT_IGNORE_LIST quote paths and carry an apostrophe
      // (`Next.js's`). Matching literals before stripping them yields phantom
      // entries, several slash-bearing, which would fail the slash assertion on
      // correct source.
      const entries = setEntries(source, 'const DEFAULT_IGNORE_LIST = new Set([');
      expect(entries).toContain('_next');
      expect(entries).not.toContain('public/build');
      expect(entries).not.toContain('env/');
      expect(entries).not.toContain('packages');
    });

    it('agrees with the runtime set it claims to describe', () => {
      // Catches parser drift without exporting the set: every name the parser
      // reports must actually be ignored by the module's own predicate.
      const entries = setEntries(source, 'const DEFAULT_IGNORE_LIST = new Set([');
      expect(entries.filter((entry) => !isHardcodedIgnoredDirectory(entry))).toEqual([]);
    });

    it('fails loudly when the marker no longer matches', () => {
      expect(() => setEntries(source, 'const NOT_A_REAL_SET = new Set([')).toThrow(
        /not found in ignore-service\.ts/,
      );
    });

    it('fails loudly rather than under-reporting an unresolvable declaration', () => {
      // A spread, an interpolation, or a concatenation resolves at runtime, not
      // in source text. Parsing fewer members and passing is the failure mode
      // these guards exist to prevent, so the parser refuses instead.
      const poisoned = source.replace(
        'const ROOT_ARTIFACT_DIRECTORIES = new Set([',
        'const ROOT_ARTIFACT_DIRECTORIES = new Set([...OTHER_NAMES,',
      );
      expect(() => setEntries(poisoned, 'const ROOT_ARTIFACT_DIRECTORIES = new Set([')).toThrow(
        /cannot resolve/,
      );
    });
  });
});
