import { describe, it, expect } from 'vitest';
import { generateGitNexusContent } from '../../src/cli/ai-context.js';

// Regression guard for #2899. The `risk: UNKNOWN` Always-Do bullet and its
// Never-Do clause describe `impact`'s risk semantics, which are not
// PDG-dependent — unlike the `pdg_query` bullet (gated on `hasPdg`, see
// ai-context.test.ts's "gates the pdg_query line on hasPdg" test), these two
// must render in the generated <!-- gitnexus:start --> block regardless of
// hasPdg.
//
// They were previously hand-added INSIDE the machine-managed block of the
// committed AGENTS.md/CLAUDE.md instead of living in this template, so every
// real `gitnexus analyze` run silently deleted them on regeneration — twice
// (#2856's 8f8261021, then #2899's own 9e602aef0, which piggybacked an
// unrelated fetch-parsing fix and also regressed the checked-in index stats
// 248612/565510/918 -> 42853/135955/758, itself evidence the docs had been
// regenerated from a stale local index rather than hand-edited). Moving the
// two lines into generateGitNexusContent (src/cli/ai-context.ts) is the
// actual fix; this test is what keeps them there. A second, independent
// guard reads the committed AGENTS.md/CLAUDE.md docs directly — see
// "root AGENTS.md / CLAUDE.md managed block keeps the risk: UNKNOWN policy
// (#2899)" in shipped-skills-sync.test.ts — so a hand-revert or a stale
// generator binary is caught even if this template-level test somehow isn't.
describe('generateGitNexusContent keeps the risk: UNKNOWN policy unconditional (#2899)', () => {
  const stats = { nodes: 50, edges: 100, processes: 5 };

  it.each([true, false])(
    'renders both the Always-Do bullet and Never-Do clause when hasPdg=%s',
    (hasPdg) => {
      const content = generateGitNexusContent('UnknownRiskProject', stats, { hasPdg });

      expect(content).toContain('MUST treat `risk: UNKNOWN` as unresolved, not as low.');
      expect(content).toContain('never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning');
      expect(content).toContain(
        'callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls)',
      );
      expect(content).toContain('`impact` pairs `UNKNOWN` with a `riskNote` saying so');

      expect(content).toContain('never read `UNKNOWN` as an all-clear');
      expect(content).toContain(
        'it means the walk could not answer, which is the one verdict that requires confirming by other means',
      );
    },
  );

  it('keeps the pdg_query bullet correctly gated on hasPdg while the UNKNOWN policy stays unconditional', () => {
    // Guards against a fix that accidentally moves the UNKNOWN policy inside
    // the hasPdg branch instead of leaving it unconditional.
    const withoutPdg = generateGitNexusContent('PlainProject', stats);
    expect(withoutPdg).toContain('MUST treat `risk: UNKNOWN` as unresolved, not as low.');
    expect(withoutPdg).not.toContain('pdg_query');
  });
});
