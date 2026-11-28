import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStalePolicy,
  applyStalePolicyProbed,
  reportStalePolicy,
} from '../../src/cli/stale-policy.js';
import {
  DEFAULT_STALE_POLICY,
  STALE_POLICIES,
  type StalePolicy,
} from '../../src/cli/stale-policy-choices.js';
import { setCliLanguage } from '../../src/cli/i18n/index.js';

const ref = {
  branch: 'main',
  lastCommit: 'abc123',
  indexedAt: '2026-11-01T00:00:00.000Z',
  measuredAgainst: 'HEAD',
};

const behind = {
  results: [{ name: 'login' }],
  staleness: {
    status: 'behind',
    ...ref,
    commitsBehind: 1,
    hint: '⚠️ Index is 1 commit behind HEAD. Run the CLI command `npx gitnexus analyze` from the repository directory to update.',
  },
};

const diverged = {
  results: [],
  staleness: { status: 'diverged', ...ref, hint: '⚠️ Index is not at HEAD.' },
};

const current = { results: [], staleness: { status: 'current', ...ref } };
const unknown = { results: [], staleness: { status: 'unknown', lastCommit: '', indexedAt: '' } };
const noField = { results: [] };

describe('stale-policy choices', () => {
  it('offers warn, ignore and error, with warn the default', () => {
    expect(STALE_POLICIES).toEqual(['warn', 'ignore', 'error']);
    expect(DEFAULT_STALE_POLICY).toBe('warn');
  });
});

describe('applyStalePolicy', () => {
  it('warn returns the very same object for a stale index', () => {
    const outcome = applyStalePolicy(behind, 'warn');
    expect(outcome.result).toBe(behind);
    expect(outcome.failure).toBeUndefined();
  });

  it('defaults to warn when no policy is given', () => {
    const outcome = applyStalePolicy(behind);
    expect(outcome.result).toBe(behind);
    expect(outcome.failure).toBeUndefined();
  });

  it('ignore drops only the hint and keeps status, the ref fields and the count', () => {
    const outcome = applyStalePolicy(behind, 'ignore');
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result).toEqual({
      results: behind.results,
      staleness: { status: 'behind', ...ref, commitsBehind: 1 },
    });
    // The input is not mutated.
    expect(behind.staleness.hint).toBeDefined();
  });

  it('ignore drops the hint of a diverged index too', () => {
    const outcome = applyStalePolicy(diverged, 'ignore');
    expect(outcome.result).toEqual({ results: [], staleness: { status: 'diverged', ...ref } });
  });

  it('error keeps the result unchanged and reports the commit count', () => {
    const outcome = applyStalePolicy(behind, 'error');
    expect(outcome.result).toBe(behind);
    expect(outcome.failure).toEqual({ commitsBehind: 1 });
  });

  it('error reports a diverged index, which has no count', () => {
    const outcome = applyStalePolicy(diverged, 'error');
    expect(outcome.result).toBe(diverged);
    expect(outcome.failure).toEqual({});
  });

  it.each(STALE_POLICIES.map((policy) => [policy] as [StalePolicy]))(
    'passes a fresh, unknown or unmeasured result through untouched under %s',
    (policy) => {
      for (const result of [current, unknown, noField, [1, 2], 'text', null]) {
        const outcome = applyStalePolicy(result, policy);
        expect(outcome.result).toBe(result);
        expect(outcome.failure).toBeUndefined();
      }
    },
  );
});

describe('multi-repository results', () => {
  const group = { per_repo: [unknown, behind, diverged] };

  it('fails on a confirmed stale member and preserves the complete result', async () => {
    const locate = vi.fn();
    const outcome = await applyStalePolicyProbed(group, 'error', locate);
    expect(outcome.result).toBe(group);
    expect(outcome.failure).toEqual({ commitsBehind: 1 });
    expect(locate).not.toHaveBeenCalled();
  });

  it('keeps an existing partial-result failure without issuing another repository probe', async () => {
    const result = { partial: true, warnings: ['Only part of the result was available'] };
    const locate = vi.fn();
    expect(await applyStalePolicyProbed(result, 'error', locate)).toEqual({ result });
    expect(locate).not.toHaveBeenCalled();
  });

  it('keeps unknown or missing member freshness non-blocking', async () => {
    const locate = vi.fn();
    const result = { per_repo: [unknown, noField, current] };
    expect(await applyStalePolicyProbed(result, 'error', locate)).toEqual({ result });
    expect(locate).not.toHaveBeenCalled();
  });

  it('suppresses member warnings while retaining the repository and index metadata', () => {
    const outcome = applyStalePolicy(group, 'ignore');
    expect(outcome.result.per_repo[1].staleness).not.toHaveProperty('hint');
    expect(outcome.result.per_repo[1].staleness).toMatchObject({ status: 'behind', ...ref });
    expect(behind.staleness.hint).toBeTruthy();
  });
});

describe('reportStalePolicy', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCliLanguage('en');
    process.exitCode = undefined;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    setCliLanguage(null);
    process.exitCode = undefined;
  });

  it('writes one line with the count and fails the command', () => {
    reportStalePolicy(applyStalePolicy(behind, 'error'));
    expect(stderr).toHaveBeenCalledWith('Index is 1 commit behind HEAD\n');
    expect(process.exitCode).toBe(1);
  });

  it('names a diverged index', () => {
    reportStalePolicy(applyStalePolicy(diverged, 'error'));
    expect(stderr).toHaveBeenCalledWith('Index is not at HEAD (diverged)\n');
    expect(process.exitCode).toBe(1);
  });

  it('localizes the reason for zh-CN', () => {
    setCliLanguage('zh-CN');
    reportStalePolicy(
      applyStalePolicy({ staleness: { status: 'behind', commitsBehind: 3 } }, 'error'),
    );
    expect(stderr).toHaveBeenCalledWith('索引落后 HEAD 3 个提交\n');
  });

  it('does nothing without a failure', () => {
    reportStalePolicy(applyStalePolicy(behind, 'warn'));
    reportStalePolicy(applyStalePolicy(behind, 'ignore'));
    reportStalePolicy(applyStalePolicy(unknown, 'error'));
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
