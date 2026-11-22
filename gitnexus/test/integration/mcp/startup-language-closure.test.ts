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
 * Both transports receive their backend at runtime. Probe the backend separately
 * to exercise the group service and CFG imports that the transports skip.
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
 *
 * The separator is `[\\/]`, matching the sibling probes' `ANY_GRAMMAR_RE` and
 * `OPTIONAL_GRAMMAR_RE`, NOT a bare `/`. Native bindings reach the probe through
 * the `require.cache` channel as absolute paths, and `toRepoRelativePosix` only
 * POSIX-normalises paths INSIDE the repo root — a hoisted `node_modules` renders
 * verbatim, so on Windows this is `…\node_modules\tree-sitter\…` and a
 * forward-slash-only pattern silently matches nothing. This file now runs on the
 * Windows matrix, where that would have made the parser half of the assertion
 * vacuous. The `core/group/extractors/` half is first-party `dist/**`, always
 * in-repo and therefore already normalised.
 */
const FORBIDDEN_GROUP_RE = /(^|\/)core\/group\/extractors\/|[\\/]node_modules[\\/]tree-sitter/;

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

/**
 * Third instance of the same defect class, and the one this file could not see.
 *
 * `pdg-impact.ts` imported two format constants from `core/ingestion/cfg/emit.ts`.
 * ESM evaluates a module to import any binding from it, so those two strings
 * pulled the whole analyze-only CFG closure — `emit`, `reaching-defs`,
 * `reaching-defs-graph`, `control-dependence`, `post-dominators`,
 * `synthetic-escape`, `call-site-harvest` — into every MCP start. The constants
 * moved to the leaf `cfg/callee-cell-format.ts`, but `emit.ts` still RE-EXPORTS
 * them, so pointing the import back at `emit.js` typechecks identically and
 * restores all seven modules. Neither existing policy matches
 * `core/ingestion/cfg/`, so nothing was stopping that.
 *
 * Allowlist rather than a denylist of the seven: the failure mode is a module
 * nobody has thought of yet, and a denylist only ever names the regressions
 * already suffered. Everything here is a genuine LEAF — zero imports — which is
 * why it can sit on the startup path at all; that is a real convention in
 * `core/ingestion` (each file's header calls itself the one shared codec), and
 * this is the only thing enforcing it.
 */
const CFG_ANCHOR = 'dist/core/ingestion/cfg/callee-cell-format.js';
const INGESTION_CFG_RE = /(^|\/)core\/ingestion\/cfg\//;
const CFG_LEAVES_ALLOWED: ReadonlySet<string> = new Set([
  CFG_ANCHOR,
  'dist/core/ingestion/cfg/reaching-def-reason-codec.js',
]);

const TRANSPORTS = [
  {
    entry: 'mcp/server.js',
    anchor: ['dist/mcp/resources.js', 'dist/mcp/repository-policy.js'],
    minModules: 100,
  },
  {
    entry: 'mcp/http-transport.js',
    anchor: ['dist/mcp/server.js', 'dist/mcp/repository-policy.js'],
    minModules: 100,
  },
] as const satisfies readonly ModuleLoadRequest[];

const ENTRIES = [
  ...TRANSPORTS,
  {
    entry: 'mcp/local/local-backend.js',
    anchor: ['dist/mcp/local/pdg-impact.js', GROUP_ANCHOR, CFG_ANCHOR],
    minModules: 50,
  },
  // import-closure.test.ts pins the CLI's leaf-only closure.
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

/** Same derivation for the CFG-leaf policy. */
const CFG_POLICY_ENTRIES = ENTRIES.filter((request) =>
  anchorsOf(request.anchor).includes(CFG_ANCHOR),
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

  it.each(TRANSPORTS)('$entry loads no local backend, group parser, or CFG module', ({ entry }) => {
    const probe = probes.get(entry);
    expect(probe.modules).not.toContain('dist/mcp/local/local-backend.js');
    expect(probe.matching(/(^|\/)core\/group\//)).toEqual([]);
    expect(probe.matching(FORBIDDEN_GROUP_RE)).toEqual([]);
    expect(probe.matching(INGESTION_CFG_RE)).toEqual([]);
  });

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

  it.each([
    ['group', GROUP_POLICY_ENTRIES],
    ['cfg-leaf', CFG_POLICY_ENTRIES],
  ])('the %s policy covers the local backend and excludes the CLI leaf', (_name, entries) => {
    expect(entries).toContain('mcp/local/local-backend.js');
    expect(entries).not.toContain('cli/mcp.js');
  });

  // The #2802 defect class, third instance: an analyze-only closure reached
  // through a constant. Allowlist, not denylist — see CFG_LEAVES_ALLOWED.
  it.each(CFG_POLICY_ENTRIES)(
    'importing dist/%s loads no non-leaf core/ingestion/cfg module',
    (entry) => {
      const probe = probes.get(entry);
      const offenders = probe
        .matching(INGESTION_CFG_RE)
        .filter((module) => !CFG_LEAVES_ALLOWED.has(module));

      expect(
        offenders,
        `${probe.label} eagerly loads analyze-only CFG modules. ESM evaluates a ` +
          `module to import ANY binding from it, so importing a constant from ` +
          `\`cfg/emit.js\` drags its whole closure onto startup — take format ` +
          `constants from the leaf \`cfg/callee-cell-format.js\` instead, and add ` +
          `a new module here only if it genuinely imports nothing (see #2802). ` +
          `Offending modules:\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );

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
