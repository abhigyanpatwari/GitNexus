import { describe, expect, it } from 'vitest';
import {
  isMoveCompilerInputPath,
  moveCompilerRequiresFullRebuild,
  persistedMoveGraphRequiresCompiler,
  shouldProvisionMoveFlowBeforeFastPath,
  type MoveCompilerIdentity,
  type MoveFlowReleaseSelection,
} from '../../../src/core/move/constants.js';

const compiler = (
  version = '2.0.0',
  source: MoveCompilerIdentity['source'] = 'release',
  fingerprint = 'sha-2.0.0',
): MoveCompilerIdentity => ({ version, source, fingerprint });

const release = (
  version = '2.0.0',
  repository = 'aptos-labs/aptos-ai',
  tag = `move-flow-v${version}`,
): MoveFlowReleaseSelection => ({
  version,
  repository,
  tag,
  assetName: `${tag}-aarch64-apple-darwin.zip`,
});

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

  it('rebuilds when compiler-backed facts are missing or their producer changes', () => {
    expect(moveCompilerRequiresFullRebuild(true, compiler(), undefined, undefined)).toBe(true);
    expect(moveCompilerRequiresFullRebuild(true, compiler(), false, undefined)).toBe(true);
    expect(moveCompilerRequiresFullRebuild(true, compiler(), true, undefined)).toBe(true);
    expect(moveCompilerRequiresFullRebuild(true, compiler(), true, compiler())).toBe(false);
    expect(moveCompilerRequiresFullRebuild(true, compiler('2.1.0'), true, compiler())).toBe(true);
    expect(
      moveCompilerRequiresFullRebuild(true, compiler('2.0.0', 'explicit'), true, compiler()),
    ).toBe(true);
    expect(
      moveCompilerRequiresFullRebuild(
        true,
        compiler('2.0.0', 'release', 'new-binary'),
        true,
        compiler(),
      ),
    ).toBe(true);
    expect(moveCompilerRequiresFullRebuild(true, undefined, true, compiler())).toBe(false);
    expect(moveCompilerRequiresFullRebuild(false, compiler(), undefined, undefined)).toBe(false);
  });

  it('recognizes compiler-backed legacy metadata from recorded Move inputs', () => {
    expect(persistedMoveGraphRequiresCompiler(true, undefined)).toBe(true);
    expect(persistedMoveGraphRequiresCompiler(false, { 'Move.toml': 'hash' })).toBe(false);
    expect(persistedMoveGraphRequiresCompiler(undefined, { 'Move.toml': 'hash' })).toBe(true);
    expect(persistedMoveGraphRequiresCompiler(undefined, { 'src/main.ts': 'hash' })).toBe(false);
  });

  it('provisions before the fast path when a managed release selection changes', () => {
    const current = release();
    expect(shouldProvisionMoveFlowBeforeFastPath(true, true, compiler(), current, current)).toBe(
      false,
    );
    expect(
      shouldProvisionMoveFlowBeforeFastPath(true, true, compiler(), current, release('2.1.0')),
    ).toBe(true);
    expect(
      shouldProvisionMoveFlowBeforeFastPath(
        true,
        true,
        compiler(),
        current,
        release('2.0.0', 'fork/move-flow', 'custom-v2'),
      ),
    ).toBe(true);
    expect(
      shouldProvisionMoveFlowBeforeFastPath(
        true,
        true,
        compiler('2.0.0', 'explicit'),
        undefined,
        current,
      ),
    ).toBe(false);
  });
});
