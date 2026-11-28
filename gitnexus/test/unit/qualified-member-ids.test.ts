import { describe, expect, it } from 'vitest';
import { cppClassConfig } from '../../src/core/ingestion/class-extractors/configs/c-cpp.js';
import { rubyClassConfig } from '../../src/core/ingestion/class-extractors/configs/ruby.js';
import { typescriptClassConfig } from '../../src/core/ingestion/class-extractors/configs/typescript-javascript.js';
import { createClassExtractor } from '../../src/core/ingestion/class-extractors/generic.js';

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
