import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  computeFixtureTaint,
  TAINT_FIXTURE_FILES,
  type FixtureFunctionTaint,
} from '../../helpers/taint-fixture.js';

// #2083 M3 U7 acceptance: a committed snapshot of the taint findings/kills on
// the pdg-repo fixture battery (vuln.ts + taint-cases.ts, with sample.ts as
// the zero-match control), mirroring reaching-defs-snapshot. The pure path —
// collect → match → computeReachingDefs → computeTaintFlows — is the SAME
// per-function pipeline the in-phase emit driver runs, so any model/matcher/
// propagation behavior change shows as a reviewable snapshot diff, never
// silent drift. The fixture battery covers the plan's six shapes: direct
// source→sink (rule-b AND the reassignment form), multi-hop chain, sanitized
// variant (must-def kill suppresses), conditional-sanitizer variant (finding
// survives), loop-carried taint, and through-call (viaCall hop).

const FIXTURE = path.join(__dirname, 'fixtures', 'pdg-repo');

/**
 * Deterministic rendering. Findings: `var@line[*]->…->var@line[*]:kind`
 * (source-first hop order; `*` marks a viaCall hop — taint passed through an
 * unmodeled call). Kills: `binding@defLine<-sanLine:kind[,kind]`.
 */
function serialize(fn: FixtureFunctionTaint): Record<string, unknown> {
  const bindings = fn.cfg.bindings ?? [];
  const bName = (idx: number): string => bindings[idx]?.name ?? `#${idx}`;
  return {
    file: fn.file,
    startLine: fn.startLine,
    status: fn.status,
    findings: (fn.flows?.findings ?? []).map(
      (f) =>
        f.hops.map((h) => `${h.name}@${h.point.line}${h.viaCall === true ? '*' : ''}`).join('->') +
        `:${f.sinkKind}` +
        (f.hopsTruncated === true ? ' (truncated)' : ''),
    ),
    kills: (fn.flows?.kills ?? []).map(
      (k) =>
        `${bName(k.bindingIdx)}@${k.killedDef.line}<-${k.sanitizer.line}:${k.neutralized.join(',')}`,
    ),
    dropped: fn.flows?.droppedFindings ?? 0,
  };
}

describe('U7 — taint findings/kills snapshot on the pdg-repo fixture battery', () => {
  const results = computeFixtureTaint(FIXTURE);
  const blockText = (fn: FixtureFunctionTaint, needle: string): boolean =>
    fn.cfg.blocks.some((b) => b.text.includes(needle));

  it('matches the committed findings/kills for every fixture function', () => {
    // Every fixture file contributes at least one function; the battery shape
    // is pinned so a fixture edit that drops a case fails loudly here, not
    // silently in the snapshot.
    for (const file of TAINT_FIXTURE_FILES) {
      expect(results.some((r) => r.file === file)).toBe(true);
    }
    expect(results.map(serialize)).toMatchSnapshot();
  });

  it('every matched fixture function computes (no coverage gaps, no unsafe sites)', () => {
    for (const fn of results) {
      expect(['computed', 'no-match']).toContain(fn.status);
      if (fn.flows) expect(fn.flows.droppedFindings).toBe(0);
    }
    // sample.ts is the zero-match control: no sources/sinks → fast path.
    for (const fn of results.filter((r) => r.file === 'sample.ts')) {
      expect(fn.status).toBe('no-match');
    }
  });

  it('AE1 — the source→sink flow IS found; the sanitized variant yields no finding and ≥1 kill', () => {
    // vuln.ts runUserCommand: req.body → cmd → exec(cmd).
    const vulnerable = results.find((r) => r.file === 'vuln.ts' && blockText(r, 'exec(cmd)'))!;
    expect(vulnerable).toBeDefined();
    expect(vulnerable.status).toBe('computed');
    expect(vulnerable.flows!.findings).toHaveLength(1);
    expect(vulnerable.flows!.findings[0].sinkKind).toBe('command-injection');

    // vuln.ts sendEncoded: the must-def encodeURIComponent kill suppresses
    // the xss finding entirely; the kill IS the persisted safety evidence.
    const sanitized = results.find(
      (r) => r.file === 'vuln.ts' && blockText(r, 'encodeURIComponent'),
    )!;
    expect(sanitized).toBeDefined();
    expect(sanitized.status).toBe('computed');
    expect(sanitized.flows!.findings).toHaveLength(0);
    expect(sanitized.flows!.kills.length).toBeGreaterThanOrEqual(1);
    expect(sanitized.flows!.kills[0].neutralized).toContain('xss');
  });

  it('AE1 — the conditional-sanitizer variant survives (may-def leg) with the kill recorded', () => {
    const conditional = results.find(
      (r) => r.file === 'taint-cases.ts' && blockText(r, 'res.send(text)'),
    )!;
    expect(conditional).toBeDefined();
    expect(conditional.flows!.findings).toHaveLength(1);
    expect(conditional.flows!.findings[0].sinkKind).toBe('xss');
    expect(conditional.flows!.kills.length).toBeGreaterThanOrEqual(1);
  });

  it('AE3 shape — hops are ordered source-first with a variable on every hop', () => {
    // Every finding in the battery carries non-empty variables on all hops.
    for (const fn of results) {
      for (const f of fn.flows?.findings ?? []) {
        expect(f.hops.length).toBeGreaterThan(0);
        for (const h of f.hops) {
          expect(h.name.length).toBeGreaterThan(0);
          expect(h.point.line).toBeGreaterThan(0);
        }
      }
    }
    // The multi-hop chain (a → b → c → exec(c)): 3+ hops, source-first order.
    const chain = results.find((r) => r.file === 'taint-cases.ts' && blockText(r, 'const c = b'))!;
    expect(chain).toBeDefined();
    const hops = chain.flows!.findings[0].hops;
    expect(hops.length).toBeGreaterThanOrEqual(4);
    expect(hops.map((h) => h.name)).toEqual(['a', 'b', 'c', 'c']);
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i].point.line).toBeGreaterThanOrEqual(hops[i - 1].point.line);
    }
  });

  it('loop-carried taint reaches a fixpoint and the sink (terminates, one finding)', () => {
    const loop = results.find(
      (r) => r.file === 'taint-cases.ts' && blockText(r, 'cmd = cmd + part'),
    )!;
    expect(loop).toBeDefined();
    expect(loop.status).toBe('computed');
    expect(loop.flows!.findings).toHaveLength(1);
    expect(loop.flows!.findings[0].sinkKind).toBe('command-injection');
  });

  it('through-call taint propagates with the viaCall hop mark (KTD5)', () => {
    const through = results.find(
      (r) => r.file === 'taint-cases.ts' && blockText(r, 'decorate(raw)'),
    )!;
    expect(through).toBeDefined();
    expect(through.flows!.findings).toHaveLength(1);
    expect(through.flows!.findings[0].hops.some((h) => h.viaCall === true)).toBe(true);
  });
});
