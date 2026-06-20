import { describe, expect, it } from 'vitest';
import {
  CALLEES_TRUNCATED_SENTINEL,
  CALLEE_ID_SEP,
  calleeIdsOfBlock,
  calleesOfBlock,
  emitFileCfgs,
} from '../../src/core/ingestion/cfg/emit.js';
import { DEFAULT_PDG_MAX_SITES_PER_STATEMENT } from '../../src/core/ingestion/cfg/visitors/call-site-harvest.js';
import { calleeIdPosKey } from '../../src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.js';
import { splitCalleeIds } from '../../src/mcp/local/pdg-impact.js';
import { cfgOf } from '../helpers/ts-cfg-harness.js';
import { allSites } from '../helpers/cfg-harness.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type {
  BasicBlockData,
  FunctionCfg,
  SiteRecord,
} from '../../src/core/ingestion/cfg/types.js';
import type { GraphNode } from 'gitnexus-shared';

/**
 * U3 (#2227 follow-up plan) — `BasicBlock.calleeIds` via the exact call-site
 * position join.
 *
 * `calleeIdsOfBlock(block, fileMap)` mirrors {@link calleesOfBlock}, but joins
 * each site's U1 `at` anchor to U2's resolved-id map (`posKey → Set<calleeId>`)
 * instead of slicing the leaf name. The CHARACTERIZATION block below proves the
 * KTD7 round-trip: a synthetic map keyed at the EXACT `at` positions the real
 * harvester produced resolves back to exactly the block's own callees — i.e.
 * U1's `at` and U2's `calleeIdPosKey` agree on the coordinate.
 */

// ── pure-helper scenarios (hand-built blocks, mirroring cfg-callees-of-block) ──

const callSite = (callee: string, at: readonly [number, number]): SiteRecord => ({
  kind: 'call',
  callee,
  at,
});

const block = (statements: BasicBlockData['statements']): BasicBlockData => ({
  index: 0,
  startLine: 1,
  endLine: 1,
  text: '',
  kind: 'normal',
  statements,
});

describe('calleeIdsOfBlock', () => {
  it('emits sorted, de-duplicated resolved ids joined by exact site position', () => {
    const s1 = callSite('foo', [1, 0]);
    const s2 = callSite('bar', [2, 4]);
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 0), new Set(['idA'])],
      [calleeIdPosKey(2, 4), new Set(['idB'])],
    ]);
    // idB then idA in source order, but the output is SORTED (mirrors callees).
    const result = calleeIdsOfBlock(
      block([{ line: 1, defs: [], uses: [], sites: [s2, s1] }]),
      fileMap,
    );
    expect(result).toBe('idA\tidB');
  });

  it('unions multi-target dispatch ids at one position (KTD8/R2)', () => {
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(3, 2), new Set(['idX', 'idY'])],
    ]);
    const result = calleeIdsOfBlock(
      block([{ line: 3, defs: [], uses: [], sites: [callSite('dispatch', [3, 2])] }]),
      fileMap,
    );
    expect(result).toBe('idX\tidY');
  });

  it('a resolved id containing a space round-trips through calleeIdsOfBlock + splitCalleeIds (#2227)', () => {
    // C++ overload ids embed multi-word primitives (`unsigned char`) and file
    // paths can contain spaces, so a resolved id can legitimately hold a space.
    // The TAB delimiter keeps it in ONE field; a space-join would fragment it
    // and silently drop inter-procedural reach to that callee.
    const spaceId = 'Method:src/my file.cpp:S::f~shape:unsigned char:none:pointer:1';
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 0), new Set([spaceId])],
      [calleeIdPosKey(2, 4), new Set(['idPlain'])],
    ]);
    const cell = calleeIdsOfBlock(
      block([
        { line: 1, defs: [], uses: [], sites: [callSite('f', [1, 0]), callSite('g', [2, 4])] },
      ]),
      fileMap,
    );
    // Tab-joined: the space-id keeps its internal spaces inside one field.
    expect(cell).toContain(CALLEE_ID_SEP);
    expect(cell).toContain('unsigned char');
    // splitCalleeIds recovers BOTH ids WHOLE — the space-id is not fragmented.
    expect([...splitCalleeIds(cell)].sort()).toEqual([spaceId, 'idPlain'].sort());
  });

  it('carries the resolved id even when the leaf name differs from the call-site leaf (alias, R1)', () => {
    // The site leaf is `aliased`, but the resolution map binds its position to
    // the canonical symbol id `id:realFn` — `calleeIds` carries the RESOLVED id,
    // not the syntactic alias.
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(5, 8), new Set(['id:realFn'])],
    ]);
    const result = calleeIdsOfBlock(
      block([{ line: 5, defs: [], uses: [], sites: [callSite('aliased', [5, 8])] }]),
      fileMap,
    );
    expect(result).toBe('id:realFn');
  });

  it('skips member-read sites and sites whose position is not in the map', () => {
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 4), new Set(['idHit'])],
    ]);
    const result = calleeIdsOfBlock(
      block([
        {
          line: 1,
          defs: [],
          uses: [],
          sites: [
            { kind: 'member-read', property: 'body', at: [1, 4] }, // member-read → skipped
            callSite('hit', [1, 4]), // position in map → idHit
            callSite('miss', [9, 9]), // position absent from map → no id
          ],
        },
      ]),
      fileMap,
    );
    expect(result).toBe('idHit');
  });

  it('flags the block callee-unknown with the sentinel when a statement hits the site cap (R7)', () => {
    const cappedSites: SiteRecord[] = Array.from(
      { length: DEFAULT_PDG_MAX_SITES_PER_STATEMENT },
      (_unused, i) => callSite('foo', [1, i]),
    );
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 0), new Set(['idFoo'])],
    ]);
    const result = calleeIdsOfBlock(
      block([{ line: 1, defs: [], uses: [], sites: cappedSites }]),
      fileMap,
    );
    // The sentinel sorts first ('*' < letters) and rides alongside the real ids.
    expect(result.split(CALLEE_ID_SEP)).toContain(CALLEES_TRUNCATED_SENTINEL);
    expect(result.split(CALLEE_ID_SEP)).toContain('idFoo');
  });

  it('returns an empty string when the map is absent (pdg off / degraded — R3)', () => {
    const b = block([{ line: 1, defs: [], uses: [], sites: [callSite('foo', [1, 0])] }]);
    expect(calleeIdsOfBlock(b, undefined)).toBe('');
    // callees is unaffected — the leaf-name fallback substrate is still present.
    expect(calleesOfBlock(b)).toBe('foo');
  });

  it('returns an empty string for a block with no call sites', () => {
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 0), new Set(['idA'])],
    ]);
    expect(calleeIdsOfBlock(block([{ line: 1, defs: [], uses: [] }]), fileMap)).toBe('');
    expect(calleeIdsOfBlock(block(undefined), fileMap)).toBe('');
  });
});

// ── emitFileCfgs property wiring ─────────────────────────────────────────────

/** The emitted BasicBlock node properties, keyed by block index, for a 1-fn cfg. */
function emittedBlockProps(
  cfg: FunctionCfg,
  calleeIdMap?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<number, GraphNode['properties']> {
  const graph = createKnowledgeGraph();
  emitFileCfgs(graph, [cfg], undefined, undefined, calleeIdMap);
  const out = new Map<number, GraphNode['properties']>();
  for (let i = 0; i < cfg.blocks.length; i++) {
    const id = `BasicBlock:${cfg.filePath}:${cfg.functionStartLine}:${cfg.functionStartColumn}:${i}`;
    const node = graph.getNode(id);
    expect(node).toBeDefined();
    out.set(i, (node as GraphNode).properties);
  }
  return out;
}

describe('emitFileCfgs — calleeIds property', () => {
  it('emits calleeIds = "" for every block when no map is passed (pdg off, R4)', () => {
    const cfg = cfgOf(`function f(arr) { arr.map(x => foo(x)); bar(); }`);
    const props = emittedBlockProps(cfg);
    for (const p of props.values()) {
      expect(p).toMatchObject({ calleeIds: '' });
    }
  });

  it('emits a non-empty calleeIds joined from the map, alongside the unchanged callees', () => {
    const cfg = cfgOf(`function f(arr) { arr.map(x => foo(x)); bar(); }`);
    // Synthetic resolved-id map keyed at the EXACT positions the harvester
    // produced for `arr.map` and `bar`.
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 18), new Set(['id:map'])], // arr.map
      [calleeIdPosKey(1, 40), new Set(['id:bar'])], // bar
    ]);
    const props = emittedBlockProps(cfg, fileMap);
    const callBlock = [...props.values()].find(
      (p) => typeof p.calleeIds === 'string' && p.calleeIds.length > 0,
    );
    expect(callBlock).toMatchObject({
      callees: 'bar map', // leaf names, sorted — UNCHANGED by the id wiring
      calleeIds: 'id:bar\tid:map', // resolved ids, sorted (TAB-joined, CALLEE_ID_SEP)
    });
  });
});

// ── CHARACTERIZATION-FIRST (KTD7) — the at ↔ calleeIdPosKey round-trip ────────

/**
 * Build a synthetic `posKey → Set<calleeId>` map keyed at the EXACT `at`
 * positions the produced SiteRecords carry, assigning each call/new site a
 * synthetic resolved id `id:<callee>`. This is what U2 would have captured had
 * the CALLS resolution keyed `atRange` on the same anchor. The id round-trips
 * back to its callee via {@link idToCallee}.
 */
function syntheticMapFromSites(cfg: FunctionCfg): {
  fileMap: ReadonlyMap<string, ReadonlySet<string>>;
  idToCallee: Map<string, string>;
} {
  const fileMap = new Map<string, Set<string>>();
  const idToCallee = new Map<string, string>();
  for (const site of allSites(cfg)) {
    // Only call/new sites carry `at`; the join consumes exactly those.
    const at = site.at;
    const callee = site.callee;
    if (at === undefined || callee === undefined) continue;
    const id = `id:${callee}`;
    idToCallee.set(id, callee.slice(callee.lastIndexOf('.') + 1));
    const key = calleeIdPosKey(at[0], at[1]);
    const set = fileMap.get(key) ?? new Set<string>();
    set.add(id);
    fileMap.set(key, set);
  }
  return { fileMap, idToCallee };
}

/** Leaf names of `calleeIds`, recovered through the synthetic id→callee map. */
function calleeNamesViaIds(calleeIds: string, idToCallee: Map<string, string>): string {
  const names = calleeIds
    .split(CALLEE_ID_SEP)
    .filter((tok) => tok.length > 0)
    .map((id) => {
      const name = idToCallee.get(id);
      expect(name).toBeDefined();
      return name as string;
    });
  return [...new Set(names)].sort().join(' ');
}

/**
 * For every block, the id set (mapped back to callee leaf names) must equal the
 * block's OWN `calleesOfBlock` names — proving the `at` positions land on the
 * right sites. This is the per-block KTD7 round-trip assertion.
 */
function assertRoundTrip(cfg: FunctionCfg): void {
  const { fileMap, idToCallee } = syntheticMapFromSites(cfg);
  for (const b of cfg.blocks) {
    const calleeIds = calleeIdsOfBlock(b, fileMap);
    const names = calleesOfBlock(b);
    // The id set, resolved back through the synthetic map, must reproduce the
    // block's own leaf-name set EXACTLY (no divergence): same positions, same
    // partitioning. (No aliases in these fixtures, so "modulo aliases" is exact
    // equality.)
    expect(calleeNamesViaIds(calleeIds, idToCallee)).toBe(names);
  }
}

describe('KTD7 characterization — at ↔ calleeIdPosKey round-trip', () => {
  it('round-trips a multi-line statement with an argument-position call on the next line', () => {
    // The inner `inner(a)` call begins on line 3, the statement head on line 2.
    // A statement-line join would mis-attribute inner's id — the position join
    // must land it on its own line.
    const cfg = cfgOf(`function f(a, b) {\n  outer(\n    inner(a)\n  );\n}`);
    assertRoundTrip(cfg);
    // Pin the produced positions so a future anchor regression is caught here.
    const outer = allSites(cfg).find((s) => s.callee === 'outer');
    const inner = allSites(cfg).find((s) => s.callee === 'inner');
    expect(outer).toMatchObject({ at: [2, 2] });
    expect(inner).toMatchObject({ at: [3, 4] });
  });

  it('round-trips a member chain alongside a member-read site (member-read carries no id)', () => {
    const cfg = cfgOf(`function f(a, x) { a.b.c(x); svc.run(); }`);
    assertRoundTrip(cfg);
    // The member-read site (no `at`) must not contribute an id.
    const memberReads = allSites(cfg).filter((s) => s.kind === 'member-read');
    expect(memberReads.length).toBeGreaterThan(0);
    expect(memberReads.every((s) => s.at === undefined)).toBe(true);
  });

  it('single-line closure: calleeIds carries the map + bar ids but NOT the nested foo (the bug the position join fixes)', () => {
    // `arr.map(x => foo(x)); bar();` — `foo` is a nested-fn site the harvester
    // EXCLUDES, so it produces no top-level SiteRecord (no `at`). The position
    // join therefore cannot include foo's id even if one existed at foo's
    // position. We assert this directly: a map that ALSO binds foo's source
    // position (col 30) must NOT leak foo into the outer block's calleeIds.
    const cfg = cfgOf(`function f(arr) { arr.map(x => foo(x)); bar(); }`);

    // The block's real call sites are exactly [arr.map@[1,18], bar@[1,40]].
    const sites = allSites(cfg).filter((s) => s.kind === 'call' || s.kind === 'new');
    expect(sites.map((s) => s.callee)).toEqual(['arr.map', 'bar']);

    // Adversarial map: binds the real two positions to map/bar ids AND binds
    // foo's source column (30) to a foo id. Because no SiteRecord carries
    // foo's position, the join cannot reach it.
    const fileMap = new Map<string, ReadonlySet<string>>([
      [calleeIdPosKey(1, 18), new Set(['id:map'])],
      [calleeIdPosKey(1, 40), new Set(['id:bar'])],
      [calleeIdPosKey(1, 30), new Set(['id:foo'])], // foo's position — never joined
    ]);

    // The single call-bearing block.
    const callBlock = cfg.blocks.find((b) =>
      (b.statements ?? []).some((s) => (s.sites ?? []).some((x) => x.kind === 'call')),
    );
    expect(callBlock).toBeDefined();
    const calleeIds = calleeIdsOfBlock(callBlock as BasicBlockData, fileMap);

    const idSet = new Set(calleeIds.split(CALLEE_ID_SEP).filter((t) => t.length > 0));
    expect(idSet.has('id:map')).toBe(true);
    expect(idSet.has('id:bar')).toBe(true);
    expect(idSet.has('id:foo')).toBe(false);
    // Sorted, exact set (TAB-joined, CALLEE_ID_SEP).
    expect(calleeIds).toBe('id:bar\tid:map');
  });
});
