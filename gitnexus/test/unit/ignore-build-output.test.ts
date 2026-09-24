import { describe, it, expect } from 'vitest';
import { isHardcodedIgnoredDirectory, shouldIgnorePath } from '../../src/config/ignore-service.js';
import {
  IGNORE_SERVICE_PATH,
  hasRuntimeAdd,
  readSource,
  setEntries,
} from '../helpers/ignore-set-source.js';

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
    const source = readSource(IGNORE_SERVICE_PATH);

    // Every one of these sets is compared against a single path component, so a
    // member containing `/` is dead on arrival — the defect that left
    // `'public/build'` inert.
    const SET_NAMES = [
      'DEFAULT_IGNORE_LIST',
      'IGNORED_FILES',
      'ROOT_ARTIFACT_DIRECTORIES',
      'IGNORED_EXTENSIONS',
    ] as const;

    it.each(SET_NAMES)('%s holds no slash-bearing member', (setName) => {
      expect(setEntries(source, setName).filter((entry) => entry.includes('/'))).toEqual([]);
    });

    it.each(SET_NAMES)('%s holds no duplicate member', (setName) => {
      const entries = setEntries(source, setName);
      expect(new Set(entries).size).toBe(entries.length);
    });

    it.each(SET_NAMES)('%s is never mutated by .add() after construction', (setName) => {
      expect(hasRuntimeAdd(source, setName)).toBe(false);
    });

    it('every IGNORED_EXTENSIONS member starts with a dot', () => {
      const entries = setEntries(source, 'IGNORED_EXTENSIONS');
      expect(entries.filter((entry) => !entry.startsWith('.'))).toEqual([]);
    });

    it('reads entries the declaration holds, not text the comments quote', () => {
      // The comments in DEFAULT_IGNORE_LIST quote paths and carry an apostrophe
      // (`Next.js's`), so a text scanner reads phantom entries out of them —
      // several slash-bearing, which would fail the assertion above on correct
      // source. Parsing the declaration cannot see comments at all.
      const entries = setEntries(source, 'DEFAULT_IGNORE_LIST');
      expect(entries).toContain('_next');
      expect(entries).not.toContain('public/build');
      expect(entries).not.toContain('env/');
    });

    it('agrees with the runtime set it claims to describe', () => {
      // Catches drift between what the guard reads and what the module does,
      // without exporting the set.
      const entries = setEntries(source, 'DEFAULT_IGNORE_LIST');
      expect(entries.filter((entry) => !isHardcodedIgnoredDirectory(entry))).toEqual([]);
    });

    it('fails loudly when a set is no longer declared as a Set of literals', () => {
      expect(() => setEntries(source, 'NOT_A_REAL_SET')).toThrow(/update this test/);
    });

    it('refuses a declaration whose members it cannot resolve', () => {
      // A spread, an interpolation, or a concatenation resolves at runtime, not
      // in source. Reading the resolvable members and passing is the failure mode
      // these guards exist to prevent, so the reader refuses instead.
      const poisoned = source.replace(
        'const ROOT_ARTIFACT_DIRECTORIES = new Set([',
        'const ROOT_ARTIFACT_DIRECTORIES = new Set([...OTHER_NAMES,',
      );
      expect(() => setEntries(poisoned, 'ROOT_ARTIFACT_DIRECTORIES')).toThrow(/not plain string/);
    });
  });
});
