import { describe, it, expect } from 'vitest';
import { generateGitNexusContent } from '../../src/cli/ai-context.js';

// Regression guard for #3076. The Explore/Use Always-Do lines were advisory, so
// read-only sessions had no MUST to call query/context/impact. The replacement
// bullet is not hasPdg-gated (unlike pdg_query) and is not nested in an
// edit/commit/rename-only sentence.
describe('generateGitNexusContent emits a read-path MUST (#3076)', () => {
  const stats = { nodes: 50, edges: 100, processes: 5 };
  const mustBullet =
    '- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.';

  function alwaysDoSection(content: string): string {
    return content.slice(content.indexOf('## Always Do'), content.indexOf('## Never Do'));
  }

  function assertNoAdvisoryExploreUse(content: string): void {
    expect(content).not.toMatch(/Explore\s+with/);
    expect(content).not.toMatch(/Use\s+`context\(\{name:/);
    expect(alwaysDoSection(content)).not.toMatch(/^- [^\n]*Explore/m);
  }

  it.each([true, false])(
    'renders the MUST and drops Explore/Use bullets when hasPdg=%s',
    (hasPdg) => {
      const content = generateGitNexusContent('ReadPathProject', stats, { hasPdg });
      expect(alwaysDoSection(content)).toContain(`\n${mustBullet}\n`);
      assertNoAdvisoryExploreUse(content);
      if (hasPdg) {
        expect(content).toContain('pdg_query');
      }
    },
  );

  it('keeps the MUST beside the Spring Actuator Always-Do line', () => {
    const content = generateGitNexusContent('SpringProject', stats, { hasSpringActuator: true });
    expect(alwaysDoSection(content)).toContain(
      `${mustBullet}\n- Spring Actuator runtime evidence is enabled`,
    );
    assertNoAdvisoryExploreUse(content);
  });

  it('keeps pdg_query gated on hasPdg while the read-path MUST stays always-emitted', () => {
    const withoutPdg = generateGitNexusContent('PlainProject', stats);
    expect(alwaysDoSection(withoutPdg)).toContain(`\n${mustBullet}\n`);
    expect(withoutPdg).not.toContain('pdg_query');
  });
});
