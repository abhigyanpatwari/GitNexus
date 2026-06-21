import { describe, expect, it } from 'vitest';
import { CALLEES_TRUNCATED_SENTINEL, calleesOfBlock } from '../../src/core/ingestion/cfg/emit.js';
import { DEFAULT_PDG_MAX_SITES_PER_STATEMENT } from '../../src/core/ingestion/cfg/visitors/call-site-harvest.js';
import type { BasicBlockData, SiteRecord } from '../../src/core/ingestion/cfg/types.js';

const callSite = (callee: string): SiteRecord => ({ kind: 'call', callee });

const block = (statements: BasicBlockData['statements']): BasicBlockData => ({
  index: 0,
  startLine: 1,
  endLine: 1,
  text: '',
  kind: 'normal',
  statements,
});

describe('calleesOfBlock', () => {
  it('emits sorted, de-duplicated leaf callee names (dotted paths reduced to the leaf)', () => {
    const result = calleesOfBlock(
      block([
        { line: 1, defs: [], uses: [], sites: [callSite('child_process.exec'), callSite('foo')] },
        { line: 2, defs: [], uses: [], sites: [callSite('a.b.bar'), callSite('foo')] },
      ]),
    );
    expect(result).toBe('bar exec foo');
  });

  it('ignores member-read sites and sites without a callee', () => {
    const result = calleesOfBlock(
      block([
        {
          line: 1,
          defs: [],
          uses: [],
          sites: [{ kind: 'member-read', property: 'body' }, { kind: 'call' }, callSite('only')],
        },
      ]),
    );
    expect(result).toBe('only');
  });

  it('flags a block callee-unknown with the sentinel when a statement hits the site cap', () => {
    const cappedSites: SiteRecord[] = Array.from(
      { length: DEFAULT_PDG_MAX_SITES_PER_STATEMENT },
      () => callSite('foo'),
    );
    const result = calleesOfBlock(block([{ line: 1, defs: [], uses: [], sites: cappedSites }]));
    // The sentinel sorts first ('*' < letters) and rides alongside the real names.
    expect(result.split(' ')).toContain(CALLEES_TRUNCATED_SENTINEL);
    expect(result.split(' ')).toContain('foo');
  });

  it('returns an empty string for a block with no call sites', () => {
    expect(calleesOfBlock(block([{ line: 1, defs: [], uses: [] }]))).toBe('');
    expect(calleesOfBlock(block(undefined))).toBe('');
  });
});
