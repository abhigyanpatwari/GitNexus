import { describe, it, expect } from 'vitest';
import { generateGitNexusContent } from '../../src/cli/ai-context.js';

// Regression guard for #3076. The Explore/Use Always-Do lines were advisory, so
// read-only sessions had no MUST to call query/context/impact. The replacement
// bullet is not hasPdg-gated (unlike pdg_query) and is not nested in an
// edit/commit/rename-only sentence.
describe('generateGitNexusContent emits a read-path MUST (#3076)', () => {
  const stats = { nodes: 50, edges: 100, processes: 5 };
  const mustLead =
    'MUST use `query({search_query: "concept"})`, `context({name: "symbolName"})`, or `impact` for read-only questions about callers, dependencies, imports, blast radius, or execution flow.';

  it.each([true, false])('renders the MUST and drops Explore/Use bullets when hasPdg=%s', (hasPdg) => {
    const content = generateGitNexusContent('ReadPathProject', stats, { hasPdg });

    expect(content).toContain(mustLead);
    expect(content).toContain('Prefer graph edges to grep strings');
    expect(content).toContain('use text search to confirm gaps or literals');
    expect(content).not.toContain('Explore with');
    expect(content).not.toContain('Use `context({name: "symbolName"})` for callers, callees, and flows.');
    expect(content).toContain('query({search_query: "concept"})');
    expect(content).toContain('context({name: "symbolName"})');
  });

  it('keeps pdg_query gated on hasPdg while the read-path MUST stays always-emitted', () => {
    const withoutPdg = generateGitNexusContent('PlainProject', stats);
    expect(withoutPdg).toContain(mustLead);
    expect(withoutPdg).not.toContain('pdg_query');
  });
});
