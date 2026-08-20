import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldIgnorePath } from '../../src/config/ignore-service.js';

/**
 * Emitted build output must not be indexed as source (#3007).
 *
 * `.next` (the build cache) was listed but `_next` (the emitted output) was
 * not, so a Capacitor/Cordova shell that copies a Next.js bundle into
 * `<platform>/app/src/main/assets/public/_next/static/` had 40% of its indexed
 * files come from minified chunks — and every `Route` node the repo produced
 * pointed at a webpack bundle instead of source.
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

  it('ignores public/build, which never matched while it sat in the name set', () => {
    // A slash-containing member of DEFAULT_IGNORE_LIST can never equal a single
    // path segment, so this entry matched nothing at all before #3007.
    expect(shouldIgnorePath('public/build/entry.client.js')).toBe(true);
    expect(shouldIgnorePath('apps/web/public/build/manifest.js')).toBe(true);
  });

  it('does not ignore public/ or build/-adjacent source outside that pair', () => {
    expect(shouldIgnorePath('public/favicon-loader.ts')).toBe(false);
    expect(shouldIgnorePath('src/public/api.ts')).toBe(false);
  });

  it('keeps the name set free of slashes so a fragment cannot silently die', () => {
    // The invariant that makes the bug above impossible to reintroduce: entries
    // needing a slash belong in DEFAULT_IGNORED_PATH_FRAGMENTS.
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
    const block = source.slice(
      source.indexOf('const DEFAULT_IGNORE_LIST = new Set(['),
      source.indexOf(']);', source.indexOf('const DEFAULT_IGNORE_LIST = new Set([')),
    );
    // Parse ENTRY LINES only. Scanning the raw block would also read prose in
    // the comments (an apostrophe in "Next.js's" opens a spurious quote).
    const entries = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith("'"))
      .map((line) => line.slice(1, line.indexOf("'", 1)));
    expect(entries.length).toBeGreaterThan(20); // parsed something real
    expect(entries.filter((e) => e.includes('/'))).toEqual([]);
  });
});
