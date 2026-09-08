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
 * The behaviour pinned below: `path.resolve` emits `C:\repo\src\*` on Windows,
 * so the `endsWith('/*')` check never matched, the bare-`*` branch ate the
 * trailing separator, and every alias target came back as `src*` —
 * `substituteStar` then produced `srclib/date`, which matches no file, so the
 * common Vite/shadcn `"@/*": ["./src/*"]` resolved to nothing on Windows.
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
