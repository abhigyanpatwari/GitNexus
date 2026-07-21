import { describe, expect, it } from 'vitest';
import {
  isMoveCompilerInputPath,
  moveAvailabilityRequiresFullRebuild,
} from '../../../src/core/move/constants.js';

describe('Move incremental safety', () => {
  it.each([
    'sources/coin.move',
    'packages/coin/Move.toml',
    'packages/coin/Move.lock',
    'packages\\coin\\sources\\coin.move',
  ])('treats %s as a package-wide compiler input', (filePath) => {
    expect(isMoveCompilerInputPath(filePath)).toBe(true);
  });

  it.each(['src/move.ts', 'packages/coin/move.toml', 'README.md'])(
    'does not classify %s as a Move compiler input',
    (filePath) => {
      expect(isMoveCompilerInputPath(filePath)).toBe(false);
    },
  );

  it('rebuilds only when a Move repo gains compiler availability', () => {
    expect(moveAvailabilityRequiresFullRebuild(true, true, undefined)).toBe(true);
    expect(moveAvailabilityRequiresFullRebuild(true, true, false)).toBe(true);
    expect(moveAvailabilityRequiresFullRebuild(true, true, true)).toBe(false);
    expect(moveAvailabilityRequiresFullRebuild(true, false, true)).toBe(false);
    expect(moveAvailabilityRequiresFullRebuild(false, true, undefined)).toBe(false);
  });
});
