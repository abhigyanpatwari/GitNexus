import { describe, expect, it } from 'vitest';
import { memberOwnerPrefix } from '../../src/core/ingestion/workers/callable-id.js';
import { QUALIFIED_MEMBER_IDS_FEATURE } from '../../src/core/ingestion/class-extractors/analysis-features.js';
import { ANALYSIS_FEATURES } from '../../src/core/analysis-feature-registry.js';
import { resolveAnalysisFeatureVersions } from '../../src/core/analysis-features.js';
import { cppClassConfig } from '../../src/core/ingestion/class-extractors/configs/c-cpp.js';
import { rubyClassConfig } from '../../src/core/ingestion/class-extractors/configs/ruby.js';
import { typescriptClassConfig } from '../../src/core/ingestion/class-extractors/configs/typescript-javascript.js';
import { createClassExtractor } from '../../src/core/ingestion/class-extractors/generic.js';

describe('memberOwnerPrefix (#2874)', () => {
  const nested = { className: 'Box', qualifiedClassName: 'N.Box' };

  it('keeps the immediate owner name unless the language opts in', () => {
    expect(memberOwnerPrefix(nested, false)).toBe('Box');
  });

  it('uses the qualified owner path when the language opts in', () => {
    expect(memberOwnerPrefix(nested, true)).toBe('N.Box');
  });

  it('leaves a top-level owner unchanged (no qualified path is recorded for it)', () => {
    expect(memberOwnerPrefix({ className: 'Box' }, true)).toBe('Box');
  });

  it('keeps template arguments, so specializations stay distinct', () => {
    expect(
      memberOwnerPrefix({ className: 'Box<bool>', qualifiedClassName: 'N.Box<bool>' }, true),
    ).toBe('N.Box<bool>');
  });

  it('drops the byte offset of an anonymous namespace from the member prefix', () => {
    const at = (offset: number) =>
      memberOwnerPrefix({ className: 'Cell', qualifiedClassName: `@anon${offset}.Cell` }, true);
    expect(at(10)).toBe('@anon.Cell');
    expect(at(10)).toBe(at(4096));
  });
});

describe('qualifiedMemberIds opt-in (#2874)', () => {
  it('is on for C++ and Ruby and off for every other qualifiedNodeId language', () => {
    expect(createClassExtractor(cppClassConfig).qualifiedMemberIds).toBe(true);
    expect(createClassExtractor(rubyClassConfig).qualifiedMemberIds).toBe(true);
    // TypeScript/JavaScript also key types by qualified path; their member ids
    // must not move.
    const ts = createClassExtractor(typescriptClassConfig);
    expect(ts.qualifiedNodeId).toBe(true);
    expect(ts.qualifiedMemberIds).toBe(false);
  });

  it('cannot be on without qualifiedNodeId', () => {
    const extractor = createClassExtractor({
      ...cppClassConfig,
      qualifiedNodeId: false,
      qualifiedMemberIds: true,
    });
    expect(extractor.qualifiedMemberIds).toBe(false);
  });
});

describe('graph.qualified-member-ids analysis feature (#2874)', () => {
  it('is stamped only for repositories with C++ or Ruby files', () => {
    const resolve = (files: string[]) => resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, files);
    expect(resolve(['src/a.cpp'])['graph.qualified-member-ids']).toBe(1);
    expect(resolve(['lib/a.rb'])['graph.qualified-member-ids']).toBe(1);
    expect(resolve(['src/a.ts', 'README.md'])['graph.qualified-member-ids']).toBeUndefined();
  });

  it('is registered', () => {
    expect(ANALYSIS_FEATURES).toContain(QUALIFIED_MEMBER_IDS_FEATURE);
  });
});
