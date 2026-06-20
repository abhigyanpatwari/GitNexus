/**
 * U5 — CLI / consumer rendering for PDG (`mode:'pdg'`) impact results.
 *
 * Guards the KTD8 presentation contract: PDG results must render HONESTLY —
 *  - inter-procedural symbol reach under a neutral heading, NOT callgraph severity labels;
 *  - the unified PDG caveat (statement reach in affectedStatements, symbol reach in interproceduralByDepth/byDepth);
 *  - degradation → the "run analyze --pdg" remediation, NOT a zero blast radius;
 *  - no-body (KTD6) → the "not applicable to this symbol kind" caveat, NOT
 *    "isolated / no dependencies";
 *  - the callgraph DI/dynamic-dispatch epistemic copy is NEVER printed for PDG.
 *
 * And the standing interchangeability contract (KTD8): `mode:'callgraph'`
 * rendering stays byte-identical (regression guard).
 */
import { describe, expect, it } from 'vitest';
import { formatImpactResult, getNextStepHint } from '../../src/cli/eval-server.js';

// A representative PDG findings result, shaped exactly like
// `assemblePdgImpactResult` (pdg-impact.ts) emits.
function pdgFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const items = [
    {
      depth: 1,
      id: 'Function:src/svc.ts:applyDiscount',
      name: 'applyDiscount',
      type: 'Function',
      filePath: 'src/svc.ts',
      processes: [],
    },
    {
      depth: 1,
      id: 'Function:src/svc.ts:finalizeTotal',
      name: 'finalizeTotal',
      type: 'Function',
      filePath: 'src/svc.ts',
      processes: [],
    },
  ];
  return {
    mode: 'pdg',
    pdgResultVersion: 1,
    target: {
      id: 'Function:src/svc.ts:computeTotal',
      name: 'computeTotal',
      type: 'Function',
      filePath: 'src/svc.ts',
    },
    direction: 'downstream',
    impactedCount: 2,
    risk: 'UNKNOWN',
    epistemic: 'pdg-intra-procedural',
    note:
      "mode:'pdg' — intra-procedural Program Dependence Graph. 2 owning symbols reached via 4 " +
      'dependence blocks (downstream over CDG + REACHING_DEF). Inter-procedural symbol reach ' +
      'is included using the resolved symbol graph; statement-level PDG reach remains in affectedStatements.',
    reachableBlocks: ['b1', 'b2', 'b3', 'b4'],
    blockCount: 4,
    depthReached: 2,
    unresolvedBlockCount: 0,
    ambiguousProjectionCount: 0,
    summary: { direct: 2, processes_affected: 0, modules_affected: 0 },
    byDepthCounts: { 1: 2 },
    affected_processes: [],
    affected_modules: [],
    byDepth: { 1: items },
    ...overrides,
  };
}

describe('formatImpactResult — PDG (mode:pdg) rendering', () => {
  it('renders a PDG ambiguous target without fabricated zero blast-radius counts', () => {
    const out = formatImpactResult({
      status: 'ambiguous',
      mode: 'pdg',
      message:
        "Found 2 symbols matching 'login'. Disambiguate with target_uid for a single authoritative PDG result.",
      target: { name: 'login' },
      direction: 'upstream',
      totalCandidates: 2,
      impactedCount: 0,
      risk: 'UNKNOWN',
      candidates: [
        {
          uid: 'func:login:1',
          name: 'login',
          kind: 'Function',
          filePath: 'src/auth.ts',
          line: 5,
          score: 1,
        },
        {
          uid: 'func:login:2',
          name: 'login',
          kind: 'Function',
          filePath: 'src/admin/login.ts',
          line: 8,
          score: 0.91,
        },
      ],
    });

    expect(out).toContain('login: AMBIGUOUS');
    expect(out).toContain('PDG impact was not computed');
    expect(out).toContain('func:login:1');
    expect(out).not.toContain('Max blast radius 0');
    expect(out).not.toContain('[0 upstream');
  });

  it('renders unified PDG symbol reach without callgraph severity labels', () => {
    const out = formatImpactResult(pdgFindings());

    // PDG framing — NOT the callgraph "depth N / WILL BREAK (direct)" labels.
    expect(out).toContain('Inter-procedural symbol reach');
    expect(out).toContain('d=1 (2)');
    expect(out).not.toContain('WILL BREAK (direct)');
    expect(out).not.toContain('LIKELY AFFECTED');
    expect(out).not.toContain('MAY NEED TESTING');
    // The callgraph "Blast radius for ... will break if changed" headline must
    // not leak into PDG output.
    expect(out).not.toContain('Blast radius for');

    // The affected symbols are listed.
    expect(out).toContain('applyDiscount');
    expect(out).toContain('finalizeTotal');
    expect(out).toContain('src/svc.ts');

    // The unified contract is present.
    expect(out).toContain('statement-level PDG reach remains in affectedStatements');

    // The callgraph DI / dynamic-dispatch lower-bound copy must NEVER appear.
    expect(out).not.toContain('dynamic dispatch');
    expect(out).not.toContain('binding via DI');
  });

  it('carries the stable pdgResultVersion discriminator on the findings result', () => {
    // The PDG result family advertises a contract version (FIX #2) so external
    // MCP/agent consumers can version against future shape evolution. It is a
    // mode:'pdg'-only field — never on the default callgraph result.
    expect(pdgFindings()).toMatchObject({ mode: 'pdg', pdgResultVersion: 1 });
  });

  it('surfaces ambiguous-projection and unresolved block counts honestly', () => {
    const out = formatImpactResult(
      pdgFindings({
        ambiguousProjectionCount: 2,
        unresolvedBlockCount: 1,
        byDepth: {
          1: [
            {
              depth: 1,
              id: 'Function:src/svc.ts:applyDiscount',
              name: 'applyDiscount',
              type: 'Function',
              filePath: 'src/svc.ts',
              ambiguous: true,
              processes: [],
            },
            {
              depth: 1,
              id: null,
              name: '(top-level)',
              type: 'BasicBlock',
              filePath: 'src/svc.ts',
              unresolved: true,
              processes: [],
            },
          ],
        },
        byDepthCounts: { 1: 2 },
      }),
    );
    expect(out).toContain('2 block(s) could not be attributed');
    expect(out).toContain('1 dependence block(s) map to no owning');
    // The shadow / ambiguous rows carry their flags inline.
    expect(out).toContain('[ambiguous]');
    expect(out).toContain('[unresolved]');
  });

  it('flags truncation honestly', () => {
    const out = formatImpactResult(pdgFindings({ truncated: true, truncatedBy: 'depth' }));
    expect(out).toContain('Truncated');
    expect(out).toContain('by depth');
    expect(out).toContain('deeper PDG impacts may exist');
  });

  it('renders multiple truncation causes honestly', () => {
    const out = formatImpactResult(
      pdgFindings({
        truncated: true,
        truncatedBy: 'depth',
        truncatedByReasons: ['depth', 'limit'],
      }),
    );
    expect(out).toContain('Truncated');
    expect(out).toContain('by depth, limit');
  });

  it('renders the degradation note as remediation, not a zero/empty blast radius', () => {
    // Shaped like the `_impactImpl` pdgLayer-degradation early return.
    const out = formatImpactResult({
      mode: 'pdg',
      pdgLayer: 'no-layer',
      note: 'No PDG layer in this index. Run `gitnexus analyze --pdg` to build it.',
      target: { name: 'computeTotal' },
      direction: 'downstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
    });
    // The remediation guidance is present.
    expect(out).toContain('analyze --pdg');
    expect(out).toContain('no usable PDG layer');
    // It must NOT read as a confident "isolated / no dependencies / safe".
    expect(out).not.toContain('isolated');
    expect(out).not.toContain('No downstream dependencies found');
  });

  it('names the missing sub-layer in a partial-degradation note', () => {
    const out = formatImpactResult({
      mode: 'pdg',
      pdgLayer: 'sub-layer-missing',
      missingSubLayer: 'REACHING_DEF',
      note: 'CDG present but REACHING_DEF absent.',
      target: { name: 'computeTotal' },
      direction: 'downstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
    });
    expect(out).toContain('REACHING_DEF');
    expect(out).toContain('analyze --pdg');
    expect(out).not.toContain('isolated');
  });

  it('renders the no-body (KTD6) caveat, not "isolated / no dependencies"', () => {
    // Shaped like `_runImpactPDG`'s no-body early return.
    const out = formatImpactResult({
      mode: 'pdg',
      target: {
        id: 'Interface:src/types.ts:Card',
        name: 'Card',
        type: 'Interface',
        filePath: 'src/types.ts',
      },
      direction: 'downstream',
      reachableBlocks: [],
      blockCount: 0,
      truncated: false,
      depthReached: 0,
      epistemic: 'no-pdg-body',
      note:
        "'Card' has no PDG body — no BasicBlocks / control- or data-dependence edges exist for " +
        'this symbol (e.g. an interface, type alias, abstract/ambient member, or a one-line ' +
        'declaration with no CFG). This is NOT a confident "no impact": the local PDG ' +
        'statement slice cannot model this symbol kind. Inter-procedural symbol reach may still be attached.',
      impactedCount: 0,
      risk: 'UNKNOWN',
      byDepth: {},
      byDepthCounts: { 1: 0 },
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
    });
    expect(out).toContain('no PDG body');
    expect(out.toLowerCase()).toContain('not applicable');
    // NOT the false-safe callgraph "isolated" headline. (The note may DISCLAIM
    // "no impact", but the confident standalone "appears isolated." sentence
    // and the callgraph "No ... dependencies found." headline must be absent.)
    expect(out).not.toContain('appears isolated');
    expect(out).not.toContain('No downstream dependencies found');
  });

  it('renders whole-symbol-empty as not-isolated, steering the caller to line:<N>', () => {
    // `_runImpactPDG` reachableBlocks.length === 0 path WITHOUT a line (whole-
    // symbol seed). The note now frames it as a structurally-empty WHOLE-SYMBOL
    // slice and steers to `line:<N>` (the useful statement-anchored mode).
    const out = formatImpactResult({
      mode: 'pdg',
      target: {
        id: 'Function:src/svc.ts:noop',
        name: 'noop',
        type: 'Function',
        filePath: 'src/svc.ts',
      },
      direction: 'downstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      epistemic: 'pdg-intra-procedural',
      note:
        "'noop' has a PDG body but a WHOLE-SYMBOL downstream slice is empty: " +
        'intra-procedural dependence stays inside the function, so every reachable block ' +
        'is already part of the seed. Pass line:<N> to slice from a specific statement ' +
        '(what depends on the code at that line). Inter-procedural symbol reach is attached ' +
        'separately by the unified impact dispatcher.',
      reachableBlocks: [],
      blockCount: 0,
      affectedStatements: [],
      affectedStatementCount: 0,
      depthReached: 1,
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
      byDepth: {},
      byDepthCounts: { 1: 0 },
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
    });
    expect(out).toContain('no inter-procedural symbols reached');
    // The new note steers to the statement-anchored mode.
    expect(out).toContain('WHOLE-SYMBOL');
    expect(out).toMatch(/line:<N>/);
    // The caveat may reference the word "isolated" to disclaim it, but the
    // confident callgraph "appears isolated." headline must be absent.
    expect(out).not.toContain('appears isolated');
    expect(out).not.toContain('No downstream dependencies found');
    expect(out).toContain('Inter-procedural symbol reach is attached');
  });

  // ── Statement-anchored (mode:'pdg' + line) rendering ──────────────────────
  // A representative statement-mode result, shaped like `assemblePdgImpactResult`
  // emits when seeded on a line: criterionLine + affectedStatements + count.
  function pdgStatementSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mode: 'pdg',
      target: {
        id: 'Function:src/svc.ts:accum',
        name: 'accum',
        type: 'Function',
        filePath: 'src/svc.ts',
      },
      direction: 'downstream',
      criterionLine: 8,
      affectedStatements: [
        { line: 10, filePath: 'src/svc.ts', text: 'sum = sum + x;' },
        { line: 12, filePath: 'src/svc.ts', text: 'return sum;' },
      ],
      affectedStatementCount: 2,
      impactedCount: 0,
      risk: 'UNKNOWN',
      epistemic: 'pdg-intra-procedural',
      note:
        "mode:'pdg' — intra-procedural slice from line 8 of 'accum'. 2 statements are " +
        'downstream-dependent on it (over CDG + REACHING_DEF). Inter-procedural symbol reach ' +
        'is attached separately by the unified impact dispatcher.',
      reachableBlocks: ['b1', 'b2'],
      blockCount: 2,
      depthReached: 2,
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      byDepthCounts: {},
      affected_processes: [],
      affected_modules: [],
      byDepth: {},
      ...overrides,
    };
  }

  it('renders a statement slice as an L<line>: <text> list under the criterion-line heading', () => {
    const out = formatImpactResult(pdgStatementSlice());
    // Heading carries direction + file:criterionLine + count.
    expect(out).toContain('Statements downstream-dependent on src/svc.ts:8 (2):');
    // Each dependent statement renders as `  L<line>: <text>`.
    expect(out).toContain('  L10: sum = sum + x;');
    expect(out).toContain('  L12: return sum;');
    // It is the statement list; no inter-symbol section appears without byDepth reach.
    expect(out).not.toContain('Inter-procedural symbol reach (');
    // The unified PDG note still surfaces.
    expect(out).toContain('Inter-procedural symbol reach is attached');
  });

  it('renders statement slices with inter-procedural symbol reach when present', () => {
    const out = formatImpactResult(
      pdgStatementSlice({
        impactedCount: 1,
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        byDepthCounts: { 1: 1 },
        byDepth: {
          1: [
            {
              depth: 1,
              id: 'Function:src/caller.ts:caller',
              name: 'caller',
              type: 'Function',
              filePath: 'src/caller.ts',
              processes: [],
            },
          ],
        },
        pdgInterprocedural: { engine: 'symbol-graph', impactedCount: 1, byDepthCounts: { 1: 1 } },
      }),
    );

    expect(out).toContain('Statements downstream-dependent on src/svc.ts:8 (2):');
    expect(out).toContain('Inter-procedural symbol reach (1):');
    expect(out).toContain('Function caller → src/caller.ts');
  });

  it('flags slice truncation honestly', () => {
    const out = formatImpactResult(pdgStatementSlice({ truncated: true, truncatedBy: 'depth' }));
    expect(out).toContain('Truncated');
    expect(out).toContain('by depth');
  });

  it('flags truncated empty statement slices honestly', () => {
    const out = formatImpactResult(
      pdgStatementSlice({
        affectedStatements: [],
        affectedStatementCount: 0,
        truncated: true,
        truncatedBy: 'limit',
        note: 'Statement slice stopped at the configured result limit.',
      }),
    );

    expect(out).toContain('No statements downstream-dependent on src/svc.ts:8');
    expect(out).toContain('Truncated');
    expect(out).toContain('by limit');
    expect(out).toContain('Statement slice stopped at the configured result limit.');
  });

  it('renders a no-block-at-line result as the steering note, never an empty isolated headline', () => {
    // `_runImpactPDG` seedBlocks.length === 0 in statement mode.
    const out = formatImpactResult({
      mode: 'pdg',
      target: {
        id: 'Function:src/svc.ts:accum',
        name: 'accum',
        type: 'Function',
        filePath: 'src/svc.ts',
      },
      direction: 'downstream',
      criterionLine: 9,
      reachableBlocks: [],
      blockCount: 0,
      affectedStatements: [],
      affectedStatementCount: 0,
      truncated: false,
      depthReached: 0,
      epistemic: 'pdg-no-block-at-line',
      note:
        "No PDG statement block starts at line 9 within 'accum' (src/svc.ts). The line may be " +
        "blank, a comment, a brace, or outside the symbol's body. Pass a line that begins an " +
        'executable statement.',
      impactedCount: 0,
      risk: 'UNKNOWN',
      byDepth: {},
      byDepthCounts: { 1: 0 },
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
    });
    expect(out).toContain('No statements downstream-dependent on src/svc.ts:9');
    expect(out).toContain('No PDG statement block starts at line 9');
    expect(out).not.toContain('appears isolated');
    expect(out).not.toContain('PDG-dependent symbols');
  });

  it('suppresses callgraph next-step hints for PDG and failed impact results', () => {
    expect(getNextStepHint('impact')).toContain('Review d=1 items first');
    expect(getNextStepHint('impact', pdgStatementSlice())).toBe('');
    expect(getNextStepHint('impact', { mode: 'pdg', pdgLayer: 'no-layer' })).toBe('');
    expect(getNextStepHint('impact', { mode: 'pdg', status: 'ambiguous' })).toBe('');
    expect(getNextStepHint('impact', { error: 'Target not found' })).toBe('');
  });
});

describe('formatImpactResult — callgraph rendering is UNCHANGED (regression guard)', () => {
  // A known callgraph result. The exact rendered string is pinned: U5 must not
  // perturb the default-mode output by one byte (KTD8 interchangeability).
  const callgraphResult = {
    target: { kind: 'Function', name: 'computeTotal' },
    direction: 'upstream',
    impactedCount: 2,
    risk: 'MEDIUM',
    byDepthCounts: { 1: 1, 2: 1 },
    byDepth: {
      1: [
        {
          type: 'Function',
          name: 'callerA',
          filePath: 'src/a.ts',
          relationType: 'CALLS',
          confidence: 1,
        },
      ],
      2: [
        {
          type: 'Function',
          name: 'callerB',
          filePath: 'src/b.ts',
          relationType: 'CALLS',
          confidence: 0.8,
        },
      ],
    },
  };

  it('renders the callgraph result with the exact pre-U5 text (byte-identical)', () => {
    const expected = [
      'Blast radius for Function computeTotal (upstream): 2 symbol(s) depends on this (will break if changed)',
      '',
      'd=1: WILL BREAK (direct) (1)',
      '  Function callerA → src/a.ts [CALLS]',
      '',
      'd=2: LIKELY AFFECTED (indirect) (1)',
      '  Function callerB → src/b.ts [CALLS] (conf: 0.8)',
    ].join('\n');
    expect(formatImpactResult(callgraphResult)).toBe(expected);
  });

  it('does not apply any PDG framing to a callgraph result', () => {
    const out = formatImpactResult(callgraphResult);
    expect(out).not.toContain('PDG-dependent symbols');
    expect(out).not.toContain('intra-procedural');
    expect(out).not.toContain('analyze --pdg');
  });

  it('renders the callgraph summary-only branch unchanged', () => {
    const out = formatImpactResult({
      target: { kind: 'Function', name: 'foo' },
      direction: 'downstream',
      impactedCount: 3,
      risk: 'LOW',
      byDepthCounts: { 1: 2, 2: 1 },
      // no byDepth → summary-only branch
    });
    expect(out).toContain('(summary only — use summaryOnly: false to see symbol lists)');
    expect(out).toContain('d=1: WILL BREAK (direct) (2)');
    expect(out).not.toContain('PDG-dependent symbols');
  });

  it('renders the callgraph isolated / zero case unchanged', () => {
    const out = formatImpactResult({
      target: { name: 'lonely' },
      direction: 'downstream',
      impactedCount: 0,
      risk: 'LOW',
    });
    expect(out).toBe('lonely: No downstream dependencies found. This symbol appears isolated.');
  });

  it('renders the callgraph lower-bound (DI/dynamic-dispatch) copy unchanged', () => {
    const out = formatImpactResult({
      target: { name: 'viaInterface' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'UNKNOWN',
      epistemic: 'lower-bound',
      boundaries: ['interface PaymentGateway'],
    });
    expect(out).toContain('LOWER BOUND');
    expect(out).toContain('interface PaymentGateway');
    expect(out).not.toContain('PDG');
  });
});
