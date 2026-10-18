/**
 * R rename: leading-dot names. The engine reads a definition's simple name as the text after the
 * last `.` of its qualified name, so `.helper` arrived as `helper` and the graph symbol `.helper`
 * did not match it (a misleading `stale_graph`). The R provider's `canonicalName` keeps a
 * one-word leading-dot name whole and leaves dotted S3-style names as they were; R's own hook
 * functions (`.onLoad`, ...) are refused because R calls them by name.
 */
import { describe, expect, it } from 'vitest';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const canonical = (name: string, qualifiedName: string): string =>
  rRenameProvider.canonicalName!(name, { definition: { qualifiedName } } as never);

describe('R rename: canonicalName of leading-dot names', () => {
  it('maps the engine simple name of a one-word leading-dot function back to the whole name', () => {
    expect(canonical('helper', '.helper')).toBe('.helper');
    expect(canonical('.helper', '.helper')).toBe('.helper');
    expect(canonical('.helper', '`.helper`')).toBe('.helper');
  });

  it('leaves dotted S3-style names and plain names as they were', () => {
    expect(canonical('circle', 'area.circle')).toBe('circle');
    expect(canonical('foo', '.helper.foo')).toBe('foo');
    expect(canonical('helper', 'helper')).toBe('helper');
    expect(rRenameProvider.canonicalName!('`odd`')).toBe('odd');
  });

  it('does not rewrite an unrelated simple name', () => {
    expect(canonical('other', '.helper')).toBe('other');
  });
});

describe('R rename: functions R calls by name', () => {
  it.each(['.onLoad', '.onAttach', '.onUnload', '.onDetach', '.First', '.Last'])(
    'refuses %s',
    (name) => {
      const issue = rRenameProvider.checkSafety?.({
        target: { type: 'Function', qualifiedName: name, filePath: 'R/zzz.R' },
        newName: 'renamed',
        files: new Map(),
        graph: undefined,
      } as never);
      expect(issue?.code).toBe('unsupported_occurrence');
      expect(issue?.message).toMatch(/hook/);
    },
  );
});
