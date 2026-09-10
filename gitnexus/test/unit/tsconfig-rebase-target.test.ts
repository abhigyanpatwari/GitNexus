/**
 * `rebaseTarget` — `paths` target rebasing, across both path flavours.
 *
 * The fixture suite (`tsconfig-index.test.ts`) builds real directories, so it
 * only ever sees the HOST separator: its `…/*` assertions are green on Ubuntu
 * whatever `rebaseTarget` does with a backslash, and only the windows-latest
 * lane can fail them. That is how the alias bug survived a green CI in the
 * first place. Injecting `pathApi` — the seam `isInside` and the `\\?\` prefix
 * guard already use — makes both platform branches assertable from any runner,
 * so deleting the separator normalisation fails here on Ubuntu too.
 *
 * Two behaviours are pinned:
 *
 *   - `path.resolve` emits `C:\repo\src\*` on Windows, so the `endsWith('/*')`
 *     check never matched, the bare-`*` branch ate the trailing separator, and
 *     every alias target came back as `src*` — `substituteStar` then produced
 *     `srclib/date`, which matches no file, so the common Vite/shadcn
 *     `"@/*": ["./src/*"]` resolved to nothing on Windows.
 *   - a repo-ROOT target (`"*": ["./*"]` under `baseUrl: "."`) rebases to an
 *     EMPTY prefix, and `${''}${'/*'}` is `/*`. `substituteStar('/*', 'lib/date')`
 *     yields `/lib/date`, and `resolveFile` matches repo-relative keys without
 *     a leading slash, so the alias went external. The bare `*` is the encoding
 *     that substitutes correctly, on both platforms.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { _rebaseTargetForTests as rebaseTarget } from '../../src/core/ingestion/languages/typescript/tsconfig.js';

describe('rebaseTarget — Windows separator normalisation', () => {
  it('rebases the Vite/shadcn `@/*` target to `src/*`, not `src*`', () => {
    // What `path.win32.resolve('C:\\repo', './src/*')` hands the rebaser.
    expect(rebaseTarget('C:\\repo', 'C:\\repo\\src\\*', path.win32)).toBe('src/*');
  });

  it('rebases a nested monorepo target', () => {
    expect(rebaseTarget('C:\\repo', 'C:\\repo\\packages\\ui\\src\\*', path.win32)).toBe(
      'packages/ui/src/*',
    );
  });

  it('leaves a starless target alone', () => {
    expect(rebaseTarget('C:\\repo', 'C:\\repo\\src\\exact.ts', path.win32)).toBe('src/exact.ts');
  });

  it('produces the identical result on POSIX', () => {
    // The normalisation is a no-op here — `split('/').join('/')` is identity —
    // so these are the OLD values as much as the new ones. Pinning them keeps
    // the Windows fix from being paid for with a POSIX regression.
    expect(rebaseTarget('/repo', '/repo/src/*', path.posix)).toBe('src/*');
    expect(rebaseTarget('/repo', '/repo/packages/ui/src/*', path.posix)).toBe('packages/ui/src/*');
    expect(rebaseTarget('/repo', '/repo/src/exact.ts', path.posix)).toBe('src/exact.ts');
  });

  it('defaults to the platform-bound path module', () => {
    const root = path.resolve('repo');
    expect(rebaseTarget(root, path.resolve(root, './src/*'))).toBe('src/*');
  });
});

describe('rebaseTarget — repo-root wildcard', () => {
  it('emits a bare `*` rather than `/*` for a root target', () => {
    // `"baseUrl": "."` with `"*": ["./*"]` — the target resolves to the repo
    // root itself, so the repo-relative prefix is empty and only the suffix is
    // left. `/*` substitutes to `/lib/date`, which no indexed key matches.
    expect(rebaseTarget('/repo', '/repo/*', path.posix)).toBe('*');
    expect(rebaseTarget('C:\\repo', 'C:\\repo\\*', path.win32)).toBe('*');
  });

  it('still emits `/*` once the target is one directory in', () => {
    // The bare `*` is the empty-prefix case ONLY; a real prefix keeps its
    // separator or `src*` comes back, which is the bug above wearing a
    // different hat.
    expect(rebaseTarget('/repo', '/repo/src/*', path.posix)).toBe('src/*');
    expect(rebaseTarget('C:\\repo', 'C:\\repo\\src\\*', path.win32)).toBe('src/*');
  });

  it('leaves a starless root target as the empty prefix', () => {
    // `resolveFile('')` is `null`, which is the honest answer for a target
    // naming the repo root and no file. Unchanged by the wildcard rule.
    expect(rebaseTarget('/repo', '/repo', path.posix)).toBe('');
    expect(rebaseTarget('C:\\repo', 'C:\\repo', path.win32)).toBe('');
  });
});
