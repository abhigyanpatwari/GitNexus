/**
 * Unit Tests: scripts/flow-fate.ts (WI-4 — #170 delta + flow-fate analysis)
 *
 * Decision table (per WI-4 Tests block):
 *
 *   | case                              | before | after  | expected fate(s)                          |
 *   |-----------------------------------|--------|--------|-------------------------------------------|
 *   | in both, same key, same label     | [a→b]  | [a→b]  | stable                                    |
 *   | before-only                       | [a→b]  | []     | removed                                   |
 *   | after-only                        | []     | [a→b]  | added                                     |
 *   | label changed + key unchanged     | [a→b/l1] | [a→b/l2] | label-changed                          |
 *   | key changed + label same          | [a→b/l] | [c→b/l] | removed (a→b) + added (c→b)             |
 *   | duplicate labels, distinct keys   | [a→b/l, c→d/l] | [a→b/l, c→d/l] | 2 × stable            |
 *   | empty before                      | []     | [a→b, c→d] | 2 × added                              |
 *   | empty after                       | [a→b, c→d] | [] | 2 × removed                              |
 *   | both empty                        | []     | []     | all-zero report, no crash                |
 *   | entryPointCandidates emitted both | [a→b ✓] | [a→b ✓] | entryPointCandidatesBefore=1, After=1   |
 *   | missing --before dir              | n/a    | n/a    | exit(2), no artifact (CLI halt)          |
 *
 * Methodology: pure unit tests for the classifier + orchestrator.
 * No real subprocess, no real DB, no real LSP. The CLI halt path
 * is exercised via a fake `fs.access` that rejects.
 *
 * This file is a **vitest** unit suite. It runs in the `default`
 * project (NOT in `lbug-db`) — per the WI-4 / I-3 hard constraint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  classifyFlowFates,
  computeVerdict,
  buildDeltaTable,
  renderDeltaTable,
  sampleFlowFates,
  takeFateSample,
  renderSampleTable,
  rowToProcessNode,
  filterValidProcessNodes,
  toFlowKey,
  parseFlowFateArgs,
  renderFlowFateHelp,
  flowFateArtifactFilename,
  main as mainFn,
  type ProcessNode,
  type FlowFateRow,
  type FlowFateMainDeps,
  FlowFateHaltError,
  loadProcessNodes,
  flowFateAtomicWrite,
  __test__ as flowFateInternal,
  HELP_FLOW_FATE_ARGS,
  type ParsedFlowFateArgs,
  EXPECTED_BEFORE_SHA,
} from '../../../scripts/flow-fate.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function mkNode(over: Partial<ProcessNode> = {}): ProcessNode {
  return {
    id: over.id ?? 'proc_0_handleLogin',
    label: over.label ?? 'HandleLogin → CreateSession',
    entryPointId: over.entryPointId ?? 'fn_handleLogin',
    terminalId: over.terminalId ?? 'fn_createSession',
    isEntryPointCandidate: over.isEntryPointCandidate,
  };
}

function mkMeta(over: Partial<{ nodes: number; edges: number; communities: number; processes: number; files: number; lastCommit: string }> = {}) {
  return {
    repoPath: '/tmp/repo',
    // Default to `EXPECTED_BEFORE_SHA` so the test's
    // `loadProcessNodes` call (which asserts the SHA on the
    // `'before'` side per I-7) passes by default. Tests that
    // exercise the mismatch path override `lastCommit` to a
    // different value.
    lastCommit: over.lastCommit ?? EXPECTED_BEFORE_SHA,
    indexedAt: '2026-06-11T00:00:00.000Z',
    schemaVersion: 1,
    stats: {
      files: over.files ?? 9,
      nodes: over.nodes ?? 100,
      edges: over.edges ?? 200,
      communities: over.communities ?? 5,
      processes: over.processes ?? 10,
    },
  };
}

/** In-memory filesystem for the CLI halt tests. */
function makeFakeFs(opts: { beforeExists?: boolean; afterExists?: boolean } = {}): {
  fs: FlowFateMainDeps['fs'];
  files: Map<string, string>;
  _access: (path: string) => Promise<void>;
} {
  const files = new Map<string, string>();
  const beforeExists = opts.beforeExists ?? true;
  const afterExists = opts.afterExists ?? true;
  const fs: any = {
    async access(path: string) {
      // Allow the OUT dir to be created; everything else goes
      // through the explicit existence flags.
      if (path === '/tmp/before' && !beforeExists) throw new Error('ENOENT');
      if (path === '/tmp/after' && !afterExists) throw new Error('ENOENT');
    },
    async mkdir(_path: string, _opts: { recursive: boolean }) {
      /* noop */
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async rename(from: string, to: string) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`rename from missing '${from}'`);
      files.set(to, v);
      files.delete(from);
    },
  };
  return {
    fs,
    files,
    _access: fs.access,
  };
}

// ─── DT-1: in both, same key → stable ─────────────────────────────────

describe('flow-fate — DT-1: in both, same key → stable', () => {
  it('returns one stable row when before and after have the same key with same label', () => {
    const a = mkNode({ id: 'proc_0', label: 'A → B' });
    const b = mkNode({ id: 'proc_0', label: 'A → B' });
    const r = classifyFlowFates([a], [b]);
    expect(r.counts.stable).toBe(1);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.counts.removed).toBe(0);
    expect(r.counts.added).toBe(0);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].fate).toBe('stable');
    expect(r.rows[0].key).toBe('fn_handleLogin::fn_createSession');
    expect(r.rows[0].beforeId).toBe('proc_0');
    expect(r.rows[0].afterId).toBe('proc_0');
  });
});

// ─── DT-2: before-only → removed ──────────────────────────────────────

describe('flow-fate — DT-2: before-only → removed', () => {
  it('returns one removed row when key is only in before', () => {
    const a = mkNode({ id: 'proc_x', label: 'A → B' });
    const r = classifyFlowFates([a], []);
    expect(r.counts.removed).toBe(1);
    expect(r.counts.added).toBe(0);
    expect(r.counts.stable).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows[0].fate).toBe('removed');
    expect(r.rows[0].beforeId).toBe('proc_x');
    expect(r.rows[0].afterId).toBeUndefined();
  });
});

// ─── DT-3: after-only → added ─────────────────────────────────────────

describe('flow-fate — DT-3: after-only → added', () => {
  it('returns one added row when key is only in after', () => {
    const a = mkNode({ id: 'proc_y', label: 'A → B' });
    const r = classifyFlowFates([], [a]);
    expect(r.counts.added).toBe(1);
    expect(r.counts.removed).toBe(0);
    expect(r.counts.stable).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows[0].fate).toBe('added');
    expect(r.rows[0].afterId).toBe('proc_y');
    expect(r.rows[0].beforeId).toBeUndefined();
  });
});

// ─── DT-4: label changed + key unchanged → label-changed (NOT removed+added)

describe('flow-fate — DT-4: label changed, key unchanged → label-changed', () => {
  it('classifies a label delta as label-changed (not removed+added)', () => {
    const beforeNode = mkNode({ id: 'p1', label: 'Login → Session' });
    const afterNode = mkNode({ id: 'p2', label: 'Authenticate → IssueToken' });
    // Same key (entryPointId/terminalId), different label + id.
    const r = classifyFlowFates([beforeNode], [afterNode]);
    expect(r.counts['label-changed']).toBe(1);
    expect(r.counts.removed).toBe(0);
    expect(r.counts.added).toBe(0);
    expect(r.counts.stable).toBe(0);
    expect(r.rows[0].fate).toBe('label-changed');
    expect(r.rows[0].beforeLabel).toBe('Login → Session');
    expect(r.rows[0].afterLabel).toBe('Authenticate → IssueToken');
    // The labelChangedKeys side-channel surfaces the key.
    expect(r.labelChangedKeys).toEqual([
      'fn_handleLogin::fn_createSession',
    ]);
  });
});

// ─── DT-5: key changed + label same → removed + added (label is NOT the key)

describe('flow-fate — DT-5: key changed, label same → removed+added pair', () => {
  it('treats different keys as independent — label is not the match key', () => {
    const beforeNode = mkNode({ id: 'p1', entryPointId: 'fnA', terminalId: 'fnB', label: 'A → B' });
    const afterNode = mkNode({ id: 'p2', entryPointId: 'fnC', terminalId: 'fnB', label: 'A → B' });
    // Same label, different entryPointId → different key.
    const r = classifyFlowFates([beforeNode], [afterNode]);
    expect(r.counts.removed).toBe(1);
    expect(r.counts.added).toBe(1);
    expect(r.counts.stable).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows[0].fate).toBe('removed');
    expect(r.rows[1].fate).toBe('added');
    expect(r.rows[0].key).toBe('fnA::fnB');
    expect(r.rows[1].key).toBe('fnC::fnB');
  });
});

// ─── DT-6: duplicate labels with distinct keys → independent classification

describe('flow-fate — DT-6: duplicate labels, distinct keys → independent', () => {
  it('classifies two flows with the same label but different keys as 2× stable', () => {
    const n1 = mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b', label: 'X → Y' });
    const n2 = mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd', label: 'X → Y' });
    const r = classifyFlowFates([n1, n2], [n1, n2]);
    expect(r.counts.stable).toBe(2);
    expect(r.counts.removed).toBe(0);
    expect(r.counts.added).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].key).toBe('a::b');
    expect(r.rows[1].key).toBe('c::d');
  });
});

// ─── DT-7: empty before → all added ───────────────────────────────────

describe('flow-fate — DT-7: empty before → all added', () => {
  it('emits one added row per after entry when before is empty', () => {
    const n1 = mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b' });
    const n2 = mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd' });
    const r = classifyFlowFates([], [n1, n2]);
    expect(r.counts.added).toBe(2);
    expect(r.counts.removed).toBe(0);
    expect(r.counts.stable).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows.map((row) => row.fate)).toEqual(['added', 'added']);
  });
});

// ─── DT-8: empty after → all removed ──────────────────────────────────

describe('flow-fate — DT-8: empty after → all removed', () => {
  it('emits one removed row per before entry when after is empty', () => {
    const n1 = mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b' });
    const n2 = mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd' });
    const r = classifyFlowFates([n1, n2], []);
    expect(r.counts.removed).toBe(2);
    expect(r.counts.added).toBe(0);
    expect(r.counts.stable).toBe(0);
    expect(r.counts['label-changed']).toBe(0);
    expect(r.rows.map((row) => row.fate)).toEqual(['removed', 'removed']);
  });
});

// ─── DT-9: both empty → all-zero report, no crash ─────────────────────

describe('flow-fate — DT-9: both empty → all-zero report', () => {
  it('emits a zero-count report and an empty rows array without throwing', () => {
    const r = classifyFlowFates([], []);
    expect(r.counts).toEqual({ stable: 0, 'label-changed': 0, removed: 0, added: 0 });
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual({ before: 0, after: 0, intersection: 0 });
    expect(r.labelChangedKeys).toEqual([]);
    expect(r.entryPointCandidatesBefore).toBe(0);
    expect(r.entryPointCandidatesAfter).toBe(0);
    expect(r.entryPointsFound).toBe(0);
  });
});

// ─── DT-10: entryPointCandidates emitted on both sides ───────────────

describe('flow-fate — DT-10: entryPointCandidatesBefore/After emitted', () => {
  it('counts candidates (isEntryPointCandidate: true) on both sides', () => {
    const b1 = mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b', isEntryPointCandidate: true });
    const b2 = mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd', isEntryPointCandidate: false });
    const a1 = mkNode({ id: 'p3', entryPointId: 'e', terminalId: 'f', isEntryPointCandidate: true });
    const a2 = mkNode({ id: 'p4', entryPointId: 'g', terminalId: 'h', isEntryPointCandidate: true });
    const r = classifyFlowFates([b1, b2], [a1, a2]);
    expect(r.entryPointCandidatesBefore).toBe(1);
    expect(r.entryPointCandidatesAfter).toBe(2);
    expect(r.entryPointsFound).toBe(1); // 2 - 1
  });

  it('falls back to 0 when neither side supplies the flag', () => {
    const n = mkNode({ id: 'p1' }); // no isEntryPointCandidate
    const r = classifyFlowFates([n], [n]);
    expect(r.entryPointCandidatesBefore).toBe(0);
    expect(r.entryPointCandidatesAfter).toBe(0);
    expect(r.entryPointsFound).toBe(0);
  });
});

// ─── DT-11: invariant — match key is (entryPointId, terminalId) ──────

describe('flow-fate — DT-11: match key is exactly (entryPointId, terminalId)', () => {
  it('toFlowKey uses :: as separator and rejects empty halves', () => {
    expect(toFlowKey('a', 'b')).toBe('a::b');
    expect(() => toFlowKey('', 'b')).toThrow(/non-empty/);
    expect(() => toFlowKey('a', '')).toThrow(/non-empty/);
  });

  it('two nodes with the same key but different `id` collapse to one row', () => {
    const b = mkNode({ id: 'p_old', entryPointId: 'a', terminalId: 'b' });
    const a = mkNode({ id: 'p_new', entryPointId: 'a', terminalId: 'b' });
    const r = classifyFlowFates([b], [a]);
    // The match key is (entry, terminal) — not the process `id`.
    // Same key → one row, classified by label.
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].beforeId).toBe('p_old');
    expect(r.rows[0].afterId).toBe('p_new');
  });
});

// ─── DT-12: rowToProcessNode + filterValidProcessNodes — defensive guards

describe('flow-fate — DT-12: row projection defensive guards', () => {
  it('rowToProcessNode returns null for missing or empty fields', () => {
    expect(rowToProcessNode(null)).toBeNull();
    expect(rowToProcessNode({})).toBeNull();
    expect(rowToProcessNode({ id: 'p1', label: 'L', entryPointId: 'a' })).toBeNull();
    expect(rowToProcessNode({ id: 'p1', label: 'L', entryPointId: 'a', terminalId: 'b' })).not.toBeNull();
  });

  it('filterValidProcessNodes drops invalid entries', () => {
    const valid = mkNode();
    const result = filterValidProcessNodes([
      valid,
      null as any,
      {} as any,
      { id: '', label: 'L', entryPointId: 'a', terminalId: 'b' } as any,
      { id: 'p1', label: 'L', entryPointId: '', terminalId: 'b' } as any,
    ]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(valid.id);
  });
});

// ─── DT-13: verdict — decomposed, never single-cause ──────────────────

describe('flow-fate — DT-13: verdict is multi-cause decomposed', () => {
  it('emits evidence across {candidate shift, maxProcesses*2 trace cap, endpoint dedup}', () => {
    const before = [
      mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b', isEntryPointCandidate: true }),
      mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd', isEntryPointCandidate: true }),
      mkNode({ id: 'p3', entryPointId: 'e', terminalId: 'f', isEntryPointCandidate: false }),
    ];
    const after = [
      mkNode({ id: 'q1', entryPointId: 'a', terminalId: 'b', isEntryPointCandidate: true }),
      mkNode({ id: 'q2', entryPointId: 'g', terminalId: 'h', isEntryPointCandidate: true }),
    ];
    const r = classifyFlowFates(before, after);
    const v = computeVerdict(before, after, r);
    expect(v.flowDelta).toBe(-1); // 2 - 3
    expect(v.candidateDelta).toBe(0); // 2 - 2
    expect(v.intersection).toBe(1);
    expect(v.removed).toBe(2);
    expect(v.added).toBe(1);
    // The three drivers are populated.
    expect(v.drivers.candidateShift).toBe(0);
    expect(v.drivers.traceCap.cap).toBe(150); // 75 * 2
    expect(v.drivers.endpointDedup.beforeEndpoints).toBe(3);
    expect(v.drivers.endpointDedup.afterEndpoints).toBe(2);
    // Verdict line is multi-cause.
    expect(v.verdict).toMatch(/candidate shift/);
    expect(v.verdict).toMatch(/trace cap/);
    expect(v.verdict).toMatch(/endpoint dedup/);
    expect(v.verdict).toMatch(/Decomposed verdict/);
  });
});

// ─── DT-14: buildDeltaTable + renderDeltaTable — pure delta table ─────

describe('flow-fate — DT-14: delta table', () => {
  it('builds a 7-row table (files, nodes, edges, clusters, flows, db-size, wall-time) with deltas', () => {
    const beforeMeta = mkMeta({ nodes: 4478, edges: 11709, communities: 465, processes: 266, files: 660 });
    const afterMeta = mkMeta({ nodes: 4478, edges: 22269, communities: 474, processes: 167, files: 660 });
    const t = buildDeltaTable(beforeMeta, afterMeta, 1024, 2048, 5000, 6000, '438600e', 'b83ddb1');
    expect(t.rows.length).toBe(7);
    const get = (k: string) => t.rows.find((r) => r.metric === k);
    expect(get('nodes')!.delta).toBe(0);
    expect(get('edges')!.delta).toBe(10560); // 22269 - 11709
    expect(get('clusters')!.delta).toBe(9);
    expect(get('flows')!.delta).toBe(-99);
    expect(get('db-size')!.delta).toBe(1024);
    expect(get('analyze-wall-time')!.delta).toBe(1000);
    const md = renderDeltaTable(t);
    expect(md).toMatch(/nodes/);
    expect(md).toMatch(/edges/);
    expect(md).toMatch(/flows/);
  });

  it('handles null meta gracefully (e.g. corrupt or pre-existing index)', () => {
    const t = buildDeltaTable(null, null, null, null, null, null, '438600e', 'b83ddb1');
    expect(t.rows.length).toBe(7);
    for (const r of t.rows) {
      expect(r.before).toBeNull();
      expect(r.after).toBeNull();
      expect(r.delta).toBeNull();
    }
  });
});

// ─── DT-15: sample allocation + rendering ────────────────────────────

describe('flow-fate — DT-15: 10-flow sample', () => {
  it('sampleFlowFates allocates round-robin across fates', () => {
    const report = {
      counts: { stable: 100, 'label-changed': 5, removed: 50, added: 30 },
      rows: [],
      entryPointCandidatesBefore: 0,
      entryPointCandidatesAfter: 0,
      entryPointsFound: 0,
      labelChangedKeys: [],
      totals: { before: 155, after: 135, intersection: 100 },
    };
    const alloc = sampleFlowFates(report, 10);
    // Pure round-robin: each round grants +1 to every fate that
    // still has capacity. 100 stable / 5 label-changed / 50
    // removed / 30 added, target 10:
    //   round 1 → stable=1, lc=1, rem=1, added=1 (remaining 6)
    //   round 2 → stable=2, lc=2, rem=2, added=2 (remaining 2)
    //   round 3 → stable=3, lc=3, rem=3, added=3 → lc hits its cap (5)
    //             at this point, but we already added 1 in round 3.
    //   Total: stable=3, lc=3, rem=3, added=3 → wait, that's 12.
    // Recount: after 2 full rounds we have 8 (remaining 2). Round 3
    // takes 2 more — the first two fates in iteration order
    // (stable, label-changed) each take one. So allocation is
    // {stable:3, label-changed:3, removed:2, added:2} = 10.
    expect(alloc).toEqual({ stable: 3, 'label-changed': 3, removed: 2, added: 2 });
  });

  it('sampleFlowFates caps at the count for fates that run short', () => {
    const report = {
      counts: { stable: 1, 'label-changed': 0, removed: 0, added: 0 },
      rows: [],
      entryPointCandidatesBefore: 0,
      entryPointCandidatesAfter: 0,
      entryPointsFound: 0,
      labelChangedKeys: [],
      totals: { before: 1, after: 1, intersection: 1 },
    };
    const alloc = sampleFlowFates(report, 10);
    expect(alloc.stable).toBe(1);
    expect(alloc['label-changed']).toBe(0);
    expect(alloc.removed).toBe(0);
    expect(alloc.added).toBe(0);
  });

  it('takeFateSample returns up to n rows stratified by fate', () => {
    const before = [
      mkNode({ id: 'p1', entryPointId: 'a', terminalId: 'b' }),
      mkNode({ id: 'p2', entryPointId: 'c', terminalId: 'd' }),
    ];
    const after = [
      mkNode({ id: 'q1', entryPointId: 'a', terminalId: 'b' }), // stable
      mkNode({ id: 'q2', entryPointId: 'e', terminalId: 'f' }), // added
    ];
    const report = classifyFlowFates(before, after);
    const sample = takeFateSample(report, 10);
    // With counts {stable:1, lc:0, rem:1, added:1} and n=10:
    //   round 1 → stable=1, lc=0 (capped), rem=1, added=1 → 3 rows, remaining 7
    //   round 2 → stable capped, lc capped, rem capped, added capped → no progress → break
    // Total allocation: {stable:1, lc:0, rem:1, added:1} = 3.
    expect(sample.length).toBe(3);
    expect(sample[0].fate).toBe('stable');
    expect(sample[1].fate).toBe('removed');
    expect(sample[2].fate).toBe('added');
    const md = renderSampleTable(sample);
    expect(md).toMatch(/\| fate \| entryPointId \| terminalId \| beforeLabel \| afterLabel \|/);
    expect(md).toMatch(/stable/);
    expect(md).toMatch(/added/);
  });
});

// ─── DT-16: parseArgs — happy path + error cases ──────────────────────

describe('flow-fate — DT-16: parseArgs', () => {
  it('requires --before', () => {
    expect(() => parseFlowFateArgs([])).toThrow(/--before/);
  });

  it('defaults --after to "." and --out to "./.gitnexus-flow-fate-out"', () => {
    const p = parseFlowFateArgs(['--before', '/x']);
    expect(p.beforePath).toBe('/x');
    expect(p.afterPath).toBe('.');
    expect(p.outDir).toBe('./.gitnexus-flow-fate-out');
    expect(p.sampleSize).toBe(10);
  });

  it('--after and --out and --sample override', () => {
    const p = parseFlowFateArgs([
      '--before', '/b',
      '--after', '/a',
      '--out', '/o',
      '--sample', '5',
    ]);
    expect(p.beforePath).toBe('/b');
    expect(p.afterPath).toBe('/a');
    expect(p.outDir).toBe('/o');
    expect(p.sampleSize).toBe(5);
  });

  it('rejects non-numeric --sample', () => {
    expect(() => parseFlowFateArgs(['--before', '/x', '--sample', 'abc'])).toThrow(/non-negative integer/);
    expect(() => parseFlowFateArgs(['--before', '/x', '--sample', '-1'])).toThrow(/non-negative integer/);
  });

  it('--help returns sentinel with help:true', () => {
    const p: any = parseFlowFateArgs(['--help']);
    expect(p.help).toBe(true);
  });

  it('rejects unknown flag', () => {
    expect(() => parseFlowFateArgs(['--bogus', 'x'])).toThrow(/unknown flag/);
  });

  it('rejects flag with no value', () => {
    expect(() => parseFlowFateArgs(['--before'])).toThrow(/requires a value/);
  });

  it('renderFlowFateHelp mentions the halt contract', () => {
    const h = renderFlowFateHelp();
    expect(h).toMatch(/--before/);
    expect(h).toMatch(/halt|exit 2/);
  });
});

// ─── DT-17: artifact filename — deterministic + safe ──────────────────

describe('flow-fate — DT-17: artifactFilename', () => {
  it('produces <before-basename>-vs-<after-basename>-flow-fate.json', () => {
    expect(flowFateArtifactFilename('/tmp/before', '/tmp/after')).toBe('before-vs-after-flow-fate.json');
  });

  it('replaces non-alphanumeric chars in basenames', () => {
    const f = flowFateArtifactFilename('/tmp/some dir', '/tmp/other dir');
    expect(f).toMatch(/^some-dir-vs-other-dir-flow-fate\.json$/);
  });
});

// ─── DT-28: entry-point candidate query + annotation (KD-6) ────────────

describe('flow-fate — DT-28: entry-point candidate query + annotation', () => {
  it('annotates process nodes whose entryPointId is in the candidate set', async () => {
    const { annotateWithEntryPointCandidates, deriveEntryPointCandidateIds } = await import('../../../scripts/flow-fate.js');
    const candidates = new Set(['fn_handleLogin', 'fn_createSession']);
    const nodes = [
      mkNode({ id: 'p1', entryPointId: 'fn_handleLogin', terminalId: 'fn_x' }),
      mkNode({ id: 'p2', entryPointId: 'fn_createSession', terminalId: 'fn_y' }),
      mkNode({ id: 'p3', entryPointId: 'fn_other', terminalId: 'fn_z' }),
    ];
    const out = annotateWithEntryPointCandidates(nodes, candidates);
    expect(out[0].isEntryPointCandidate).toBe(true);
    expect(out[1].isEntryPointCandidate).toBe(true);
    expect(out[2].isEntryPointCandidate).toBe(false);
  });

  it('derives the candidate set from the cypher result', async () => {
    const { deriveEntryPointCandidateIds } = await import('../../../scripts/flow-fate.js');
    const runCypher = vi.fn(async () => [
      { entryPointId: 'fn_a' },
      { entryPointId: 'fn_b' },
      { entryPointId: '' }, // invalid; filtered
      {},
    ]);
    const out = await deriveEntryPointCandidateIds('repo', runCypher as any);
    expect(out.has('fn_a')).toBe(true);
    expect(out.has('fn_b')).toBe(true);
    expect(out.size).toBe(2);
  });

  it('loadProcessNodes annotates the nodes from the candidate query (KD-6: non-zero count in production runs)', async () => {
    const meta = mkMeta();
    const processRows = [
      { id: 'p1', label: 'A → B', entryPointId: 'fn_a', terminalId: 'fn_b' },
      { id: 'p2', label: 'C → D', entryPointId: 'fn_c', terminalId: 'fn_d' },
    ];
    const runCypher = vi.fn(async (_repo: string, cypher: string) => {
      if (/RETURN DISTINCT p\.entryPointId/i.test(cypher)) {
        return [{ entryPointId: 'fn_a' }, { entryPointId: 'fn_c' }];
      }
      return processRows;
    });
    const result = await loadProcessNodes('/tmp/x', {
      side: 'before',
      loadMeta: vi.fn(async () => meta) as any,
      getStoragePaths: vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      })) as any,
      runCypher: runCypher as any,
    });
    // Both nodes annotated, so the classifier's count is 2 (not 0).
    const annotated = result.nodes.filter((n) => n.isEntryPointCandidate);
    expect(annotated.length).toBe(2);
  });
});

// ─── DT-18: CLI main() — missing --before dir → exit 2, no partial output

describe('flow-fate — DT-18: main() halt — missing --before dir', () => {
  it('exits 2 and writes no artifact when --before is absent', async () => {
    const fakeFs = makeFakeFs({ beforeExists: false });
    const exit = vi.fn();
    const stderr = vi.fn();
    const stdout = vi.fn();
    await mainFn({
      argv: ['--before', '/tmp/before', '--after', '/tmp/after'],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout,
      runCypher: vi.fn(),
      loadMeta: vi.fn(),
      getStoragePaths: vi.fn(),
    });
    expect(exit).toHaveBeenCalledWith(2);
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/--before directory not found/);
    expect(stderrMsg).toMatch(/Halt contract/);
    // No artifact written.
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-19: CLI main() — missing --after dir → exit 2, no partial output

describe('flow-fate — DT-19: main() halt — missing --after dir', () => {
  it('exits 2 and writes no artifact when --after is absent', async () => {
    const fakeFs = makeFakeFs({ afterExists: false });
    const exit = vi.fn();
    const stderr = vi.fn();
    await mainFn({
      argv: ['--before', '/tmp/before', '--after', '/tmp/after'],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout: vi.fn(),
      runCypher: vi.fn(),
      loadMeta: vi.fn(),
      getStoragePaths: vi.fn(),
    });
    expect(exit).toHaveBeenCalledWith(2);
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/--after directory not found/);
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-20: CLI main() — parse error → exit 1, no artifact ───────────

describe('flow-fate — DT-20: main() parse error', () => {
  it('exits 1 and writes no artifact for unknown flag', async () => {
    const fakeFs = makeFakeFs();
    const exit = vi.fn();
    const stderr = vi.fn();
    await mainFn({
      argv: ['--bogus', 'x'],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout: vi.fn(),
    });
    expect(exit).toHaveBeenCalledWith(1);
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/unknown flag/);
    expect(fakeFs.files.size).toBe(0);
  });

  it('exits 1 for missing --before', async () => {
    const fakeFs = makeFakeFs();
    const exit = vi.fn();
    const stderr = vi.fn();
    await mainFn({
      argv: [],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout: vi.fn(),
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fakeFs.files.size).toBe(0);
  });

  it('--help prints usage and does not call exit(1)', async () => {
    const fakeFs = makeFakeFs();
    const exit = vi.fn();
    const stdout = vi.fn();
    await mainFn({
      argv: ['--help'],
      fs: fakeFs.fs,
      exit,
      stderr: vi.fn(),
      stdout,
    });
    expect(exit).not.toHaveBeenCalled();
    const stdoutMsg = (stdout as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stdoutMsg).toMatch(/usage:/);
  });
});

// ─── DT-21: CLI main() — happy path (self-compare, all stable) ───────

describe('flow-fate — DT-21: main() happy path (self-compare → all stable)', () => {
  it('writes one JSON artifact when before == after', async () => {
    const fakeFs = makeFakeFs();
    const meta = mkMeta();
    const rows = [
      { id: 'p1', label: 'A → B', entryPointId: 'a', terminalId: 'b' },
      { id: 'p2', label: 'C → D', entryPointId: 'c', terminalId: 'd' },
    ];
    const runCypher = vi.fn(async () => rows);
    const loadMeta = vi.fn(async () => meta);
    const getStoragePaths = vi.fn((p: string) => ({
      storagePath: p + '/.gitnexus',
      lbugPath: p + '/.gitnexus/lbug',
      metaPath: p + '/.gitnexus/meta.json',
    }));
    const exit = vi.fn();
    const stderr = vi.fn();
    const stdout = vi.fn();
    await mainFn({
      argv: ['--before', '/tmp/before', '--after', '/tmp/after', '--out', '/tmp/out'],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout,
      runCypher: runCypher as any,
      loadMeta: loadMeta as any,
      getStoragePaths: getStoragePaths as any,
    });
    // 1 JSON artifact, no summary.md (single file).
    expect(fakeFs.files.size).toBe(1);
    const key = [...fakeFs.files.keys()][0];
    const json = JSON.parse(fakeFs.files.get(key)!);
    expect(json.fates.counts.stable).toBe(2);
    expect(json.fates.counts.removed).toBe(0);
    expect(json.fates.counts.added).toBe(0);
    expect(json.fates.counts['label-changed']).toBe(0);
    // exit was NOT called with non-zero.
    expect(exit).not.toHaveBeenCalledWith(expect.any(Number));
  });
});

// ─── DT-22: CLI main() — loadMeta returns null → halt ─────────────────

describe('flow-fate — DT-22: main() halt — repo not indexed', () => {
  it('exits 2 and writes no artifact when loadMeta returns null', async () => {
    const fakeFs = makeFakeFs();
    const loadMeta = vi.fn(async () => null);
    const getStoragePaths = vi.fn((p: string) => ({
      storagePath: p + '/.gitnexus',
      lbugPath: p + '/.gitnexus/lbug',
      metaPath: p + '/.gitnexus/meta.json',
    }));
    const exit = vi.fn();
    const stderr = vi.fn();
    await mainFn({
      argv: ['--before', '/tmp/before', '--after', '/tmp/after'],
      fs: fakeFs.fs,
      exit,
      stderr,
      stdout: vi.fn(),
      runCypher: vi.fn(),
      loadMeta: loadMeta as any,
      getStoragePaths: getStoragePaths as any,
    });
    expect(exit).toHaveBeenCalledWith(2);
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/no .gitnexus\/meta\.json/);
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-23: loadProcessNodes — propagates FlowFateHaltError ───────────

describe('flow-fate — DT-23: loadProcessNodes halt propagation', () => {
  it('throws FlowFateHaltError when loadMeta returns null', async () => {
    await expect(
      loadProcessNodes('/tmp/x', {
        loadMeta: vi.fn(async () => null) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn() as any,
      }),
    ).rejects.toBeInstanceOf(FlowFateHaltError);
  });

  it('throws FlowFateHaltError when runCypher rejects', async () => {
    await expect(
      loadProcessNodes('/tmp/x', {
        loadMeta: vi.fn(async () => mkMeta()) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn(async () => {
          throw new Error('Cypher failed');
        }) as any,
      }),
    ).rejects.toBeInstanceOf(FlowFateHaltError);
  });

  it('returns valid ProcessNode list when cypher yields rows', async () => {
    const meta = mkMeta();
    const rows = [
      { id: 'p1', label: 'A → B', entryPointId: 'a', terminalId: 'b' },
      { id: 'p2', label: 'C → D', entryPointId: 'c', terminalId: 'd' },
      { id: 'p3', label: '', entryPointId: '', terminalId: '' }, // invalid
    ];
    const result = await loadProcessNodes('/tmp/x', {
      loadMeta: vi.fn(async () => meta) as any,
      getStoragePaths: vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      })) as any,
      runCypher: vi.fn(async () => rows) as any,
    });
    expect(result.nodes.length).toBe(2); // invalid row filtered out
    expect(result.meta).toBe(meta);
    expect(result.repoId).toBe('x');
  });
});

// ─── DT-24: atomicWriteFile — temp + rename ───────────────────────────

describe('flow-fate — DT-24: flowFateAtomicWrite', () => {
  it('writes to <path>.tmp then renames to <path>', async () => {
    const fakeFs = makeFakeFs();
    await flowFateAtomicWrite('/tmp/x.json', '{"ok":true}', fakeFs.fs as any);
    expect(fakeFs.files.has('/tmp/x.json')).toBe(true);
    expect(fakeFs.files.has('/tmp/x.json.tmp')).toBe(false);
    expect(fakeFs.files.get('/tmp/x.json')).toBe('{"ok":true}');
  });
});

// ─── DT-25: HELP sentinel + smoke (artifact file shape) ───────────────

describe('flow-fate — DT-25: HELP sentinel + smoke', () => {
  it('HELP_FLOW_FATE_ARGS has help:true and required fields', () => {
    expect((HELP_FLOW_FATE_ARGS as any).help).toBe(true);
    expect(HELP_FLOW_FATE_ARGS.outDir).toBe('./.gitnexus-flow-fate-out');
    expect(HELP_FLOW_FATE_ARGS.sampleSize).toBe(10);
  });

  it('CLI integration smoke (tmpdir + real filesystem + stub seams)', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/gnx-ff-smoke-`);
    try {
      const beforeDir = join(tmp, 'before');
      const afterDir = join(tmp, 'after');
      const outDir = join(tmp, 'out');
      // Real on-disk dirs; we still stub the runCypher + loadMeta
      // seams so we never hit a real DB.
      const { mkdirSync } = await import('fs');
      mkdirSync(beforeDir, { recursive: true });
      mkdirSync(afterDir, { recursive: true });
      const meta = mkMeta({ processes: 2 });
      const runCypher = vi.fn(async () => [
        { id: 'p1', label: 'A → B', entryPointId: 'a', terminalId: 'b' },
        { id: 'p2', label: 'C → D', entryPointId: 'c', terminalId: 'd' },
      ]);
      const loadMeta = vi.fn(async () => meta);
      const getStoragePaths = vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      }));
      // We do NOT inject `fs` — main uses the real `node:fs/promises`
      // so mkdir + access resolve to the real tmp dir.
      await mainFn({
        argv: [
          '--before', beforeDir,
          '--after', afterDir,
          '--out', outDir,
        ],
        runCypher: runCypher as any,
        loadMeta: loadMeta as any,
        getStoragePaths: getStoragePaths as any,
        stderr: vi.fn(),
        stdout: vi.fn(),
        exit: vi.fn(),
      });
      // The artifact landed in outDir.
      const { readdirSync, readFileSync } = await import('fs');
      const outFiles = readdirSync(outDir);
      expect(outFiles.length).toBe(1);
      const json = JSON.parse(readFileSync(join(outDir, outFiles[0]), 'utf-8'));
      expect(json.fates.counts.stable).toBe(2);
      // `verdict` is the full VerdictEvidence object; the
      // multi-cause narrative lives in `.verdict` (string).
      expect(json.verdict.verdict).toMatch(/Decomposed verdict/);
      expect(json.delta.rows.length).toBe(7);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── DT-27: I-7 --before SHA enforcement (438600e) ─────────────────────

describe('flow-fate — DT-27: I-7 --before SHA enforcement', () => {
  it('throws FlowFateHaltError with code 4 when before.lastCommit != EXPECTED_BEFORE_SHA (no override)', async () => {
    const wrongMeta = mkMeta({ lastCommit: 'deadbeef0000' });
    await expect(
      loadProcessNodes('/tmp/x', {
        side: 'before',
        loadMeta: vi.fn(async () => wrongMeta) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn(async () => []) as any,
      }),
    ).rejects.toMatchObject({
      name: 'FlowFateHaltError',
      code: 4,
    });
  });

  it('passes when expectedBeforeSha override matches the actual lastCommit', async () => {
    const meta = mkMeta({ lastCommit: 'cafef00d1234' });
    const result = await loadProcessNodes('/tmp/x', {
      side: 'before',
      expectedBeforeSha: 'cafef00d1234',
      loadMeta: vi.fn(async () => meta) as any,
      getStoragePaths: vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      })) as any,
      runCypher: vi.fn(async () => []) as any,
    });
    expect(result.nodes).toEqual([]);
  });

  it('does NOT enforce the SHA on the after side (only before is pinned)', async () => {
    const wrongMeta = mkMeta({ lastCommit: 'b83ddb1cafe' });
    // The default --after side has lastCommit different from 438600e
    // — that is expected. The assertion must NOT fire.
    const result = await loadProcessNodes('/tmp/x', {
      side: 'after',
      loadMeta: vi.fn(async () => wrongMeta) as any,
      getStoragePaths: vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      })) as any,
      runCypher: vi.fn(async () => []) as any,
    });
    expect(result.nodes).toEqual([]);
  });

  it('parseFlowFateArgs exposes --expected-before-sha with the default constant', () => {
    const parsed = parseFlowFateArgs(['--before', '/tmp/x']);
    expect(parsed.expectedBeforeSha).toBe(EXPECTED_BEFORE_SHA);
    const parsed2 = parseFlowFateArgs(['--before', '/tmp/x', '--expected-before-sha', 'override-sha']);
    expect(parsed2.expectedBeforeSha).toBe('override-sha');
  });

  it('throws FlowFateHaltError with code 4 when before.lastCommit is empty (pre-migration or corrupt meta)', async () => {
    // I-7: a missing `lastCommit` (empty string) is NOT a
    // silent pass — it indicates a pre-migration or
    // hand-edited `meta.json`. The guard must treat it as a
    // mismatch and abort, otherwise a corrupt meta bypasses
    // the SHA gate. The assertion message is the same shape
    // as the standard mismatch case.
    const emptyMeta = mkMeta({ lastCommit: '' });
    await expect(
      loadProcessNodes('/tmp/x', {
        side: 'before',
        loadMeta: vi.fn(async () => emptyMeta) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn(async () => []) as any,
      }),
    ).rejects.toMatchObject({
      name: 'FlowFateHaltError',
      code: 4,
    });
  });
});

// ─── DT-26: no-write invariant — flow-fate source has no write-API tokens

describe('flow-fate — DT-26: no-write invariant (KD-8 / I-2)', () => {
  it('flow-fate.ts source has no initLbug / executeQuery / addNode / addRelationship / DROP', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // test/unit/scripts/flow-fate.test.ts → gitnexus/ (4 levels up)
    const srcPath = join(here, '..', '..', '..', 'scripts', 'flow-fate.ts');
    const src = readFileSync(srcPath, 'utf-8');
    // Strip block + line comments to avoid matching documentation.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    const FORBIDDEN: RegExp[] = [
      /\bexecuteQuery\s*\(/,
      /\bimport\b[^\n;]*\bexecuteQuery\b/,
      /\binitLbug\s*\(/,
      /\binitLbugWithDb\s*\(/,
      /\baddNode\s*\(/,
      /\baddRelationship\s*\(/,
      /\bDROP\s+(?:NODE\s+)?TABLE\b/i,
    ];
    const violations: string[] = [];
    for (const re of FORBIDDEN) {
      const m = stripped.match(re);
      if (m) violations.push(m[0]);
    }
    expect(violations, `forbidden write-API symbols in flow-fate.ts: ${violations.join(', ')}`).toEqual([]);
  });

  it('flow-fate.ts does NOT statically import executeParameterized (dynamic-only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, '..', '..', '..', 'scripts', 'flow-fate.ts');
    const raw = readFileSync(srcPath, 'utf-8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    // No STATIC import that names the adapter's executor.
    expect(stripped).not.toMatch(/import\b[^\n;]*\bexecuteParameterized\b/);
    // The dynamic-import form IS allowed.
    expect(stripped).toMatch(/import\(\s*['"][^'"]*dist[^'"]*lbug-adapter[^'"]*['"]/);
  });
});

// ─── DT-29: I-7 / WI-4 — EXPECTED_BEFORE_SHA enforcement (halt + override)

describe('flow-fate — loadProcessNodes — EXPECTED_BEFORE_SHA enforcement', () => {
  it('throws FlowFateHaltError with the SHA + literal 438600e in the message on SHA mismatch (no override)', async () => {
    // I-1 / WI-4 hard constraint: a `before` side whose
    // `meta.lastCommit` does not match the canonical baseline
    // MUST abort before any artifact is written. The test
    // drives a non-canonical `lastCommit` (`'abcdef'`) and a
    // fake `runCypher` returning empty rows, then asserts the
    // helper throws with the SHA and the canonical
    // `438600e…` short-prefix in the message.
    const wrongMeta = mkMeta({ lastCommit: 'abcdef' });
    await expect(
      loadProcessNodes('/tmp/x', {
        side: 'before',
        loadMeta: vi.fn(async () => wrongMeta) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn(async () => []) as any,
      }),
    ).rejects.toMatchObject({
      name: 'FlowFateHaltError',
      code: 4,
    });
    // Recapture the rejection with a try/catch to assert the
    // message contents (toMatchObject only checks the listed
    // fields; the message text is the load-bearing assertion).
    let caught: any = null;
    try {
      await loadProcessNodes('/tmp/x', {
        side: 'before',
        loadMeta: vi.fn(async () => wrongMeta) as any,
        getStoragePaths: vi.fn((p: string) => ({
          storagePath: p + '/.gitnexus',
          lbugPath: p + '/.gitnexus/lbug',
          metaPath: p + '/.gitnexus/meta.json',
        })) as any,
        runCypher: vi.fn(async () => []) as any,
      });
    } catch (e: any) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.name).toBe('FlowFateHaltError');
    expect(caught.code).toBe(4);
    // The mismatched SHA + the canonical short-prefix MUST
    // both appear so the operator can grep the log.
    expect(caught.message).toMatch(/abcdef/);
    expect(caught.message).toMatch(/438600e/);
  });

  it('does NOT throw when --expected-before-sha overrides the canonical default to match meta.lastCommit', async () => {
    // I-1 / WI-4: the operator can override the canonical
    // baseline via `args.expectedBeforeSha`. When the override
    // matches `meta.lastCommit`, the helper MUST NOT halt;
    // it returns the empty-shape result (no nodes) and the
    // caller can continue.
    const meta = mkMeta({ lastCommit: 'abcdef' });
    const result = await loadProcessNodes('/tmp/x', {
      side: 'before',
      expectedBeforeSha: 'abcdef',
      loadMeta: vi.fn(async () => meta) as any,
      getStoragePaths: vi.fn((p: string) => ({
        storagePath: p + '/.gitnexus',
        lbugPath: p + '/.gitnexus/lbug',
        metaPath: p + '/.gitnexus/meta.json',
      })) as any,
      runCypher: vi.fn(async () => []) as any,
    });
    expect(result.nodes).toEqual([]);
    expect(result.meta).toBe(meta);
    expect(result.repoId).toBe('x');
    // The cypher path returned []; the candidate query is a
    // separate call that ALSO returned [] (no rows). The
    // field is undefined on the happy path (no cypher throw).
    expect(result.entryPointQueryError).toBeUndefined();
  });
});
