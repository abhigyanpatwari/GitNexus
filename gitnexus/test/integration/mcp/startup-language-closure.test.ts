/**
 * MCP startup must not load the analyze-only language provider registry (#2802).
 *
 * `mcp/local/pdg-impact.ts` once imported `core/ingestion/languages/index.ts`
 * for a single extension→language lookup. That edge pulled all 16 providers,
 * their extractors, and the tree-sitter native binding into every MCP server
 * start: ~226 extra modules and ~130 ms, for a server that never analyzes
 * anything. The finding was discovered and lost once already (during #2793)
 * before #2802 re-derived it, so it gets a guard rather than a comment.
 *
 * The guard is a REAL MODULE-LOAD PROBE, not a source-level import walk. A
 * previous regex-based version of this test (`test/unit/mcp-startup-import-
 * closure.test.ts`) was defeated four separate ways: it walked from
 * `local-backend.ts` instead of the actual server entry, it was structurally
 * blind to eager top-level `await import(...)`, its type-only-import stripper
 * lazily matched across a 16 kB window of `pdg-impact.ts` (the terminating
 * `from "…"` lived inside a string literal), and its comment stripper treated
 * `/*` inside a string literal as a comment opener.
 *
 * The probe itself now lives in `test/helpers/module-load-probe.ts`, shared with
 * `test/integration/mcp/import-closure.test.ts` and
 * `test/integration/optional-grammars/registry-import-closure.test.ts` — it
 * spawns a child Node process, imports a built `dist/` entry, and reports every
 * module the loader actually pulled in. It cannot be fooled by import syntax, a
 * stale entry point, or regex drift: whatever Node evaluates, the probe sees.
 * The FORBIDDEN set and its remedy stay here, because they are specific to
 * #2802.
 *
 * Coverage note: `dist/mcp/server.js` is the entry that must be protected — it
 * is what `mcpCommand` dynamically imports and what actually serves MCP.
 * `dist/cli/mcp.js` is asserted too (it is the process entry, and its
 * deliberately leaf-only static closure is pinned separately by
 * `import-closure.test.ts`), as is `dist/mcp/local/local-backend.js` — the
 * module whose import graph #2802 actually changed, and
 * `dist/mcp/http-transport.js`, which is the OTHER startup entry: `gitnexus mcp
 * --http` reaches it through its own `await import(...)` in `mcpCommand`, not
 * through `server.js`, so nothing about `server.js` staying clean constrains it.
 *
 * `local-backend.js`'s closure is TODAY a strict subset of `server.js`'s (156
 * of 380 modules, none of them absent from the server's), so it cannot surface
 * an offender the server probe would miss. It is kept anyway, for two reasons
 * that survive that measurement. The subset relation is an observation about
 * the current graph and nothing enforces it: the day `server.js` stops reaching
 * the local backend eagerly (remote-only default, lazy backend selection), the
 * server probe's anchor — `dist/mcp/resources.js` — keeps passing while the
 * module #2802 actually changed goes unobserved. Its own entry pins
 * `dist/mcp/local/pdg-impact.js` as an anchor, which is coverage the server
 * entry does not and cannot provide. And since the probes run concurrently, the
 * marginal wall-clock cost is ~0: it finishes inside the server probe's window.
 *
 * Lazy `await import(...)` inside a function body remains the sanctioned escape
 * hatch: it does not run at startup, so the probe does not see it. A top-level
 * `await import(...)` DOES run at module evaluation, and the probe reports it —
 * which is the point.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  anchorsOf,
  probeModuleLoads,
  type ModuleLoadProbes,
  type ModuleLoadRequest,
} from '../../helpers/module-load-probe.js';

/** Modules under this directory are the analyze-only provider registry. */
const FORBIDDEN_RE = /(^|\/)core\/ingestion\/languages\//;

/**
 * The group contract extractors, and the native parser binding they reach.
 *
 * Same defect class as #2802, found immediately after it: `core/group/service.ts`
 * statically imported `./sync.js`, which pulls all six contract extractors, five
 * of which statically import `tree-sitter`. Only `group_sync` ever needs them —
 * the other seven group tools do not — so a static import put the whole parser
 * stack on every MCP server start. Measured cost of that one edge on a native
 * filesystem: `dist/mcp/server.js` 521 ms -> 133 ms, `local-backend.js` 453 ms
 * -> 66 ms.
 *
 * Matching the parser by its package prefix rather than a bare substring so a
 * source file that merely mentions the word cannot satisfy or trip this.
 */
const FORBIDDEN_GROUP_RE = /(^|\/)core\/group\/extractors\/|(^|\/)node_modules\/tree-sitter/;

/**
 * The chain the group policy above polices, and therefore ITS non-vacuity
 * anchor. `core/group/service.js` is the module that statically imported
 * `./sync.js` and dragged the extractors in; the fix made that edge lazy. An
 * anchor on some other chain (`mcp/resources.js`, `mcp/local/pdg-impact.js`)
 * plus the module-count floor both stay green when `local-backend →
 * core/group/service` is severed — the obvious next lazy-load step — and the
 * group assertion would then be vacuous on every row while the file still
 * reported all-pass. Anchors are per-POLICY, not per-entry; see
 * `test/helpers/module-load-probe.ts`.
 */
const GROUP_ANCHOR = 'dist/core/group/service.js';

// Observed on Node 22.18 against a clean build at the tip of this branch:
// server.js 380 distinct modules, local-backend.js 156, cli/mcp.js 4. Treat
// these as a snapshot, not a contract — they moved twice inside this branch
// alone (the group-extractor and cfg/emit closures each took ~100 and ~7 out),
// and only the FLOORS below are asserted. The floors sit well under the
// observed counts so normal dependency churn doesn't trip them, while a probe
// that silently loaded nothing still fails.
//
// `mcp/http-transport.js` is the largest startup entry — measured 516 modules,
// +136 over server.js for express, cors and the SDK's Streamable-HTTP/SSE
// transports. It is what `gitnexus mcp --http` starts and the hosted-deploy
// path, and `mcpCommand` imports it directly, not via `server.js`; because that
// edge runs one way only, a static import added inside `http-transport.ts`
// would reinstate #2802 on the HTTP path with every other row here green. The
// probes run concurrently, so its marginal wall-clock cost is ~0 — it finishes
// alongside the others rather than after them.
//
// `mcp/resources.js` (measured 57 modules, 0 offenders) and `mcp/staleness.js`
// (53, 0) are named in the #2802 write-up but deliberately get NO rows: both
// are eagerly inside the closures of `server.js` and `http-transport.js`
// (each appears in both probes' module lists), so any offender they acquired
// surfaces on those rows already. They would earn rows only if something made
// them reachable other than eagerly-from-the-server.
const ENTRIES = [
  {
    entry: 'mcp/server.js',
    anchor: ['dist/mcp/resources.js', GROUP_ANCHOR],
    minModules: 100,
  },
  {
    entry: 'mcp/http-transport.js',
    anchor: ['dist/mcp/server.js', GROUP_ANCHOR],
    minModules: 100,
  },
  {
    entry: 'mcp/local/local-backend.js',
    anchor: ['dist/mcp/local/pdg-impact.js', GROUP_ANCHOR],
    minModules: 50,
  },
  // The one row with a single anchor, because it is subject to ONE policy. Its
  // whole design is a 4-module leaf closure that reaches nothing first-party
  // beyond `stdio-context → stdio-capture`, so it can never reach
  // `core/group/service.js` and cannot be given the group anchor honestly. It
  // is excluded from the group policy below for that reason: a row that cannot
  // fail for any reason related to the policy it is listed under is exactly the
  // vacuity this file's probe exists to prevent. Its leaf-only closure is
  // pinned exhaustively by `import-closure.test.ts` instead.
  { entry: 'cli/mcp.js', anchor: 'dist/mcp/stdio-context.js', minModules: 3 },
] as const satisfies readonly ModuleLoadRequest[];

/**
 * The rows the group policy applies to — DERIVED from the anchors, not
 * hand-listed beside them, so an entry cannot join that policy without
 * carrying the anchor that keeps it able to fail.
 */
const GROUP_POLICY_ENTRIES = ENTRIES.filter((request) =>
  anchorsOf(request.anchor).includes(GROUP_ANCHOR),
).map((request) => request.entry);

describe('MCP startup module-load closure (#2802)', () => {
  let probes: ModuleLoadProbes;

  // Every entry is probed CONCURRENTLY here, not one per test: the probes are
  // independent child processes and each pays a full Node start, so running
  // them in parallel cuts this file's wall clock by roughly 60% and makes each
  // additional entry near-free. The helper labels every failure with its entry
  // and enforces each entry's anchors and module floor, so the `it` bodies
  // below are pure policy assertions.
  beforeAll(async () => {
    probes = await probeModuleLoads(ENTRIES);
  }, 90_000);

  // `%s` over the bare entries, not `$entry` over the request objects: vitest
  // quotes an interpolated object property, and `importing dist/'mcp/server.js'`
  // reads like a typo in CI output.
  it.each(ENTRIES.map((request) => request.entry))(
    'importing dist/%s loads no language provider module',
    (entry) => {
      const probe = probes.get(entry);
      const offenders = probe.matching(FORBIDDEN_RE);

      // Headline assertion: named chains, not a bare boolean, so whoever
      // reintroduces the edge sees exactly which modules did it.
      expect(
        offenders,
        `${probe.label} eagerly loads the analyze-only language provider registry. ` +
          `MCP startup never analyzes anything — route the lookup through a lazy ` +
          `\`await import(...)\` inside the function that needs it (see #2802). ` +
          `Offending modules:\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );

  // Pins the derivation above: if a future edit drops `GROUP_ANCHOR` from every
  // entry, `GROUP_POLICY_ENTRIES` empties and the `it.each` below silently
  // registers zero cases — a whole policy disappearing without one red test.
  it('runs the group policy over exactly the entries that reach core/group/service.js', () => {
    expect(GROUP_POLICY_ENTRIES).toEqual([
      'mcp/server.js',
      'mcp/http-transport.js',
      'mcp/local/local-backend.js',
    ]);
  });

  it.each(GROUP_POLICY_ENTRIES)(
    'importing dist/%s loads no group contract extractor or native parser',
    (entry) => {
      const probe = probes.get(entry);
      const offenders = probe.matching(FORBIDDEN_GROUP_RE);

      expect(
        offenders,
        `${probe.label} eagerly loads the group contract extractors and/or the ` +
          `native tree-sitter binding. Only \`group_sync\` needs them, and MCP ` +
          `startup never syncs — keep \`core/group/sync.js\` behind the lazy ` +
          `\`await import(...)\` in \`GroupService.groupSync\`. ` +
          `Offending modules:\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );
});
