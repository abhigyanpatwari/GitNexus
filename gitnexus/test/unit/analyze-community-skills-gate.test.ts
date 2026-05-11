import { describe, it, expect } from 'vitest';
import { shouldGenerateCommunitySkillFiles } from '../../src/cli/analyze.js';

describe('shouldGenerateCommunitySkillFiles (#742 / PR 1485)', () => {
  it('is false when --index-only is set even if --skills and pipelineResult are present', () => {
    expect(shouldGenerateCommunitySkillFiles({ skills: true, indexOnly: true }, { ok: true })).toBe(
      false,
    );
  });

  it('is false when pipelineResult is missing', () => {
    expect(shouldGenerateCommunitySkillFiles({ skills: true, indexOnly: false }, null)).toBe(false);
    expect(shouldGenerateCommunitySkillFiles({ skills: true }, undefined)).toBe(false);
  });

  it('is true when --skills is set, pipeline exists, and not index-only', () => {
    expect(
      shouldGenerateCommunitySkillFiles({ skills: true, indexOnly: false }, { communities: [] }),
    ).toBe(true);
    expect(shouldGenerateCommunitySkillFiles({ skills: true }, { x: 1 })).toBe(true);
  });

  it('is false when --skills is omitted', () => {
    expect(shouldGenerateCommunitySkillFiles({ indexOnly: false }, { x: 1 })).toBe(false);
    expect(shouldGenerateCommunitySkillFiles(undefined, { x: 1 })).toBe(false);
  });
});
