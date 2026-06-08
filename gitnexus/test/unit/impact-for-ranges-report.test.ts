import { describe, expect, it } from 'vitest';
import {
  renderImpactForRangesMarkdown,
  type ImpactForRangesReport,
} from '../../src/core/pr-impact/impact-for-ranges-report.js';

describe('impact-for-ranges markdown renderer', () => {
  it('renders a deterministic direct-composition report', () => {
    const report: ImpactForRangesReport = {
      schema_version: 'impact-for-ranges.v1alpha1',
      repo: {
        name: 'gitnexus-local-features',
        indexed_commit: 'abc123',
      },
      summary: {
        input_ranges: 2,
        matched_symbols: 1,
        unmatched_ranges: 1,
        deleted_symbols: 0,
        symbols_with_processes: 1,
        unmapped_symbols: 0,
        unknown_symbols: 0,
        affected_processes: 1,
      },
      symbols: [
        {
          id: 'Function:src/app.ts:mapped',
          name: 'mapped',
          type: 'Function',
          filePath: 'src/app.ts',
          change_types: ['modified'],
          matched_ranges: [
            {
              filePath: 'src/app.ts',
              startLine: 2,
              endLine: 4,
              side: 'new',
              change_type: 'modified',
            },
          ],
          processes: [
            {
              id: 'Process:login-flow',
              name: 'LoginFlow',
              process_type: 'entry_point',
              step_index: 2,
              step_count: 5,
            },
          ],
        },
      ],
      unmapped_symbols: [],
      unknown_symbols: [],
      unmatched_ranges: [
        {
          filePath: 'src/loose.ts',
          startLine: 9,
          endLine: 9,
          reason: 'No indexed symbol overlapped this changed range',
        },
      ],
      affected_processes: [
        {
          id: 'Process:login-flow',
          name: 'LoginFlow',
          process_type: 'entry_point',
          step_count: 5,
          matched_symbols: 1,
        },
      ],
      caveats: [
        'Direct process membership only; no caller traversal or risk scoring is included.',
        'No API impact or graph-derived test signal is included in this composed surface.',
      ],
    };

    const markdown = renderImpactForRangesMarkdown(report);

    expect(markdown).toContain('# GitNexus Impact For Ranges');
    expect(markdown).toContain('## Affected Processes');
    expect(markdown).toContain('## Symbols With Direct Process Evidence');
    expect(markdown).toContain('## Unmatched Ranges');
    expect(markdown).toContain('## Caveats');
    expect(markdown).toContain('LoginFlow (2/5)');
    expect(markdown).toContain('src/app.ts:2-4');
  });
});
