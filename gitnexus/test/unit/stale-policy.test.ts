import { describe, expect, it } from 'vitest';
import {
  applyStalePolicy,
  createStalePolicyOption,
  isBlockingStaleStatus,
  parseStalePolicy,
  type StalePolicy,
} from '../../src/cli/stale-policy.js';

const withStatus = (status: string) => ({
  hits: 1,
  staleness: { status, lastCommit: 'abc', indexedAt: '2026-01-01' },
});

describe('isBlockingStaleStatus', () => {
  it('only behind and diverged block', () => {
    expect(isBlockingStaleStatus('behind')).toBe(true);
    expect(isBlockingStaleStatus('diverged')).toBe(true);
    expect(isBlockingStaleStatus('current')).toBe(false);
    expect(isBlockingStaleStatus('unknown')).toBe(false);
  });
});

describe('parseStalePolicy', () => {
  it.each(['warn', 'ignore', 'error'] as const)('accepts %s', (policy) => {
    expect(parseStalePolicy(policy)).toBe(policy);
  });

  it('defaults unknown values to warn', () => {
    expect(parseStalePolicy(undefined)).toBe('warn');
    expect(parseStalePolicy('nope')).toBe('warn');
  });
});

describe('createStalePolicyOption', () => {
  it('registers choices and default warn', () => {
    const option = createStalePolicyOption();
    expect(option.flags).toBe('--stale-policy <policy>');
    expect(option.argChoices).toEqual(['warn', 'ignore', 'error']);
    expect(option.defaultValue).toBe('warn');
  });
});

describe('applyStalePolicy matrix', () => {
  const cases: Array<{
    status: string;
    policy: StalePolicy;
    violation: boolean;
    strips: boolean;
  }> = [
    { status: 'current', policy: 'warn', violation: false, strips: false },
    { status: 'current', policy: 'ignore', violation: false, strips: true },
    { status: 'current', policy: 'error', violation: false, strips: false },
    { status: 'behind', policy: 'warn', violation: false, strips: false },
    { status: 'behind', policy: 'ignore', violation: false, strips: true },
    { status: 'behind', policy: 'error', violation: true, strips: false },
    { status: 'diverged', policy: 'warn', violation: false, strips: false },
    { status: 'diverged', policy: 'ignore', violation: false, strips: true },
    { status: 'diverged', policy: 'error', violation: true, strips: false },
    { status: 'unknown', policy: 'warn', violation: false, strips: false },
    { status: 'unknown', policy: 'ignore', violation: false, strips: true },
    { status: 'unknown', policy: 'error', violation: false, strips: false },
  ];

  it.each(cases)(
    '$policy + $status → violation=$violation strips=$strips',
    ({ status, policy, violation, strips }) => {
      const input = withStatus(status);
      const { result, staleViolation, blockingStatus } = applyStalePolicy(input, policy);
      expect(staleViolation).toBe(violation);
      if (violation) {
        expect(blockingStatus === 'behind' || blockingStatus === 'diverged').toBe(true);
      }
      if (strips) {
        expect(result).not.toHaveProperty('staleness');
        expect(result.hits).toBe(1);
      } else {
        expect(result).toEqual(input);
      }
    },
  );

  it('error treats fail-open diverged (isStale false) as a violation via status', () => {
    // Core may attach status=diverged with isStale=false when rev-list fails.
    // Policy must key off status, not isStale.
    const input = {
      ok: true,
      staleness: { status: 'diverged', hint: 'not at HEAD', lastCommit: 'abc' },
    };
    const { staleViolation } = applyStalePolicy(input, 'error');
    expect(staleViolation).toBe(true);
  });

  it('error does not fail when staleness is absent', () => {
    expect(applyStalePolicy({ ok: true }, 'error').staleViolation).toBe(false);
    expect(applyStalePolicy([{ row: 1 }], 'error').staleViolation).toBe(false);
  });

  it('error fails when any per_repo member is behind/diverged', () => {
    const input = {
      per_repo: [
        { repo: '/a', staleness: { status: 'current' } },
        { repo: '/b', staleness: { status: 'behind', commitsBehind: 2 } },
      ],
    };
    expect(applyStalePolicy(input, 'error').staleViolation).toBe(true);
    const stripped = applyStalePolicy(input, 'ignore').result as typeof input;
    expect(stripped.per_repo.every((e) => !('staleness' in e))).toBe(true);
  });
});
