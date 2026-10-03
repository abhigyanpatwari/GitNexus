/**
 * The index column of `gitnexus group status` (#3256).
 *
 * `group/service.ts` reports a repo with no recorded commit as
 * `{ indexStale: true, commitsBehind: -1 }`. The CLI rendered that with
 * `commitsBehind ?? '?'`, and `??` only falls back on `null` / `undefined`, so
 * the command printed `STALE (-1 commits behind)`. Nothing covered it, because
 * the cell lived inside a Commander action that only runs against a real group.
 */
import { describe, expect, it } from 'vitest';
import { formatIndexStatusCell } from '../../src/cli/group-status-format.js';

describe('formatIndexStatusCell', () => {
  it('renders the no-recorded-commit sentinel as ?, not -1', () => {
    expect(formatIndexStatusCell({ indexStale: true, commitsBehind: -1 })).toBe(
      'STALE     (? commits behind)',
    );
  });

  it('renders a missing count as ?', () => {
    expect(formatIndexStatusCell({ indexStale: true })).toBe('STALE     (? commits behind)');
  });

  it('renders a counted gap unchanged', () => {
    expect(formatIndexStatusCell({ indexStale: true, commitsBehind: 3 })).toBe(
      'STALE     (3 commits behind)',
    );
  });

  it.each([0, 3])(
    'renders a stale diverged row without a commits-behind count of %i',
    (commitsBehind) => {
      const row = { indexStale: true, commitsBehind, status: 'diverged' as const };
      expect(formatIndexStatusCell(row)).toBe('STALE     (index differs from HEAD)');
    },
  );

  it('renders an explicit behind status with its counted gap', () => {
    const row = { indexStale: true, commitsBehind: 3, status: 'behind' as const };
    expect(formatIndexStatusCell(row)).toBe('STALE     (3 commits behind)');
  });

  it('renders an explicit current status as OK', () => {
    const row = { indexStale: false, commitsBehind: 0, status: 'current' as const };
    expect(formatIndexStatusCell(row)).toBe('OK        ');
  });

  it('preserves the fail-open cell when a diverged probe did not confirm staleness', () => {
    const row = { indexStale: false, commitsBehind: 0, status: 'diverged' as const };
    expect(formatIndexStatusCell(row)).toBe('OK        ');
  });

  it('keeps the OK cell byte-identical, padding included', () => {
    expect(formatIndexStatusCell({ indexStale: false, commitsBehind: 0 })).toBe('OK        ');
  });
});
