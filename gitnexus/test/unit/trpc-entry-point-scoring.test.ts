import { describe, it, expect } from 'vitest';
import { calculateEntryPointScore } from '../../src/core/ingestion/entry-point-scoring.js';

describe('tRPC entry-point scoring', () => {
  it('scores a T3 router procedure higher than the same name on a utility file', () => {
    const t3 = calculateEntryPointScore(
      'setSettings',
      'typescript',
      true,
      0,
      3,
      'src/server/api/routers/settings.ts',
    );
    const util = calculateEntryPointScore(
      'setSettings',
      'typescript',
      true,
      0,
      3,
      'src/lib/utils.ts',
    );
    expect(t3.score).toBeGreaterThan(util.score);
    expect(t3.reasons).toContain('framework:trpc-router');
    expect(t3.reasons).not.toContain('utility-pattern');
    expect(util.reasons).toContain('utility-pattern');
  });

  it('still applies utility-pattern to non-accessor helpers in a T3 router file', () => {
    const routerPath = 'src/server/api/routers/settings.ts';
    for (const name of ['formatDate', '_internal', 'parseInput'] as const) {
      const result = calculateEntryPointScore(name, 'typescript', true, 0, 3, routerPath);
      expect(result.reasons).toContain('utility-pattern');
      expect(result.reasons).toContain('framework:trpc-router');
    }
  });

  it('skips utility-pattern for accessor procedures on a T3 JavaScript router', () => {
    const result = calculateEntryPointScore(
      'setSettings',
      'javascript',
      true,
      0,
      3,
      'src/server/api/routers/settings.js',
    );
    expect(result.reasons).toContain('framework:trpc-router');
    expect(result.reasons).not.toContain('utility-pattern');
  });

  it('still applies utility-pattern to non-accessor helpers on a T3 JavaScript router', () => {
    const result = calculateEntryPointScore(
      'formatDate',
      'javascript',
      true,
      0,
      3,
      'src/server/api/routers/settings.js',
    );
    expect(result.reasons).toContain('utility-pattern');
    expect(result.reasons).toContain('framework:trpc-router');
  });

  it('does not crash on a .js router path whose framework detection returns null', () => {
    const jsResult = calculateEntryPointScore(
      'settingsRouter',
      'javascript',
      true,
      0,
      3,
      'src/server/routers/settings.js',
    );
    expect(Number.isFinite(jsResult.score)).toBe(true);
  });
});
