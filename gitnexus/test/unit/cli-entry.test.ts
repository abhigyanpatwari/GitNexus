/**
 * Locks the CLI-spawn entry-point resolution used by every e2e/integration suite
 * (test/helpers/cli-entry.ts). The branch logic decides whether tests exercise the
 * built `dist/cli/index.js` or tsx-on-source, so a regression here silently changes
 * what every spawn-based test actually runs — worth a direct, env-free unit test.
 */
import { describe, it, expect } from 'vitest';
import { computeSpawnPrefix, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

const DIST = '/repo/dist/cli/index.js';
const SRC = '/repo/src/cli/index.ts';
const TSX = 'file:///repo/node_modules/tsx/dist/loader.mjs';

describe('computeSpawnPrefix', () => {
  it('selects the built dist entry when mode=dist and dist exists', () => {
    expect(
      computeSpawnPrefix({
        mode: 'dist',
        distEntry: DIST,
        srcEntry: SRC,
        distExists: true,
        tsxLoaderUrl: TSX,
      }),
    ).toEqual([DIST]);
  });

  it('throws an actionable "run npm run build" error when mode=dist but dist is missing', () => {
    expect(() =>
      computeSpawnPrefix({
        mode: 'dist',
        distEntry: DIST,
        srcEntry: SRC,
        distExists: false,
        tsxLoaderUrl: TSX,
      }),
    ).toThrow(/run `npm run build`/);
  });

  it('falls back to tsx-on-source when mode is unset (the local default)', () => {
    expect(
      computeSpawnPrefix({
        mode: undefined,
        distEntry: DIST,
        srcEntry: SRC,
        distExists: false,
        tsxLoaderUrl: TSX,
      }),
    ).toEqual(['--import', TSX, SRC]);
  });

  it('forces tsx-on-source when mode=src even if dist exists', () => {
    expect(
      computeSpawnPrefix({
        mode: 'src',
        distEntry: DIST,
        srcEntry: SRC,
        distExists: true,
        tsxLoaderUrl: TSX,
      }),
    ).toEqual(['--import', TSX, SRC]);
  });

  it('throws on an unknown mode — never dist without opt-in, never a silent tsx fallback', () => {
    expect(() =>
      computeSpawnPrefix({
        mode: 'production',
        distEntry: DIST,
        srcEntry: SRC,
        distExists: true,
        tsxLoaderUrl: TSX,
      }),
    ).toThrow(/Unknown GITNEXUS_E2E_CLI/);
  });

  it('ignores distExists off the dist branch (mode unset, dist present) — still tsx', () => {
    expect(
      computeSpawnPrefix({
        mode: undefined,
        distEntry: DIST,
        srcEntry: SRC,
        distExists: true,
        tsxLoaderUrl: TSX,
      }),
    ).toEqual(['--import', TSX, SRC]);
  });
});

describe('CLI_SPAWN_PREFIX (resolved from the current environment)', () => {
  it('is a non-empty argv prefix ending at a gitnexus CLI entry point', () => {
    expect(CLI_SPAWN_PREFIX.length).toBeGreaterThan(0);
    expect(CLI_SPAWN_PREFIX[CLI_SPAWN_PREFIX.length - 1]).toMatch(/cli[/\\]index\.(ts|js)$/);
  });
});
