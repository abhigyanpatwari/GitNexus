import { describe, it, expect } from 'vitest';
import { generateGitNexusContent } from '../../src/cli/ai-context.js';

// #3976: the generated impact MUST bound documentation-only edits, which the
// block cannot be hand-edited to say because `analyze` regenerates it.
describe('generateGitNexusContent scopes the impact MUST (#3976)', () => {
  const stats = { nodes: 50, edges: 100, processes: 5 };

  it.each([true, false])('exempts documentation-only edits when hasPdg=%s', (hasPdg) => {
    const content = generateGitNexusContent('ScopeProject', stats, { hasPdg });
    const alwaysDo = content.slice(content.indexOf('## Always Do'), content.indexOf('## Never Do'));

    expect(alwaysDo).toContain('**MUST run impact before editing code, config, or tests.**');
    expect(alwaysDo).toContain('Docs-only edits');
    expect(alwaysDo).toContain('**MUST analyze changes before commit.**');
  });
});
