/**
 * MCP CLI static-import-closure regression test.
 *
 * Codex's adversarial review on PR #1383 found that even though `cli/mcp.ts`
 * is loaded lazily by Commander, ITS static imports (`startMCPServer`,
 * `LocalBackend`, `installGlobalStdoutSentinel`, `warnMissingOptionalGrammars`)
 * evaluate synchronously when the module loads — well before `mcpCommand`'s
 * function body runs. Three of those four imports transitively pull in
 * `core/lbug/pool-adapter.ts`, which `import`s `@ladybugdb/core` at module top
 * level. The native binding's init can write to raw stdout in that pre-sentinel
 * window and corrupt the JSON-RPC frame stream.
 *
 * This test locks in the fix: import the built `dist/cli/mcp.js` in a child
 * process (without invoking `mcpCommand`) and assert that `@ladybugdb/core` is
 * NOT in the loaded-module set.
 *
 * The probe is `test/helpers/module-load-probe.ts`. This file used to carry its
 * own copy that diffed Node's CJS module cache and nothing else. That was
 * enough for the `@ladybugdb/core` headline — a native CJS module always
 * surfaces in `require.cache` — but it was structurally BLIND to the ESM
 * `dist/**` graph it was walking, which is where the static imports it is
 * policing actually live, and it had no non-vacuity guard at all: a `cli/mcp.js`
 * severed from its own imports produced an empty cache diff and passed green.
 * The shared probe adds the ESM channel and REQUIRES an anchor, so "nothing
 * forbidden loaded" now means something. It also spawns ONCE for the two
 * assertions below, which used to pay for two separate probes of one target.
 *
 * `dist/mcp/stdio-context.js` is the anchor because it is the entry's only
 * remaining first-party static import — the whole point of the fix — so its
 * disappearance is exactly the refactor that would make both assertions vacuous.
 *
 * Characterization-first: this test was written before the fix landed and
 * MUST fail against the pre-fix code. Run against the parent of the U1
 * commit to verify the regression signal works.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { probeModuleLoad, type ModuleLoadProbe } from '../../helpers/module-load-probe.js';

describe('MCP CLI static-import closure', () => {
  let probe: ModuleLoadProbe;

  beforeAll(async () => {
    probe = await probeModuleLoad({
      entry: 'cli/mcp.js',
      anchor: 'dist/mcp/stdio-context.js',
      // Observed on Node 22.18 against a clean build: 4 modules. This closure is
      // deliberately leaf-only, so the floor is necessarily tight — the anchor
      // above is the load-bearing non-vacuity guard here.
      minModules: 3,
    });
  }, 90_000);

  it('does not load @ladybugdb/core when cli/mcp.js is imported (without invoking mcpCommand)', () => {
    // The headline assertion: @ladybugdb/core (a native CJS module) must not
    // be loaded by the static-import closure of cli/mcp.js. If it is, the
    // pre-sentinel stdout window the prior fix tried to close is still open.
    const ladybugLoaded = probe.matching(/@ladybugdb[\\/]core/);
    expect(
      ladybugLoaded,
      `@ladybugdb/core was loaded at cli/mcp.js static-import time. ` +
        `mcpCommand cannot install the stdout sentinel before native init runs. ` +
        `Offending paths:\n${ladybugLoaded.join('\n')}\n\n` +
        `Full loaded set (${probe.modules.length} entries):\n${probe.modules.join('\n')}`,
    ).toEqual([]);
  });

  it('does not load any tree-sitter native binding (sanity check on grammar imports)', () => {
    // No tree-sitter parser should load at cli/mcp.js static-import time.
    // The analyze path is the only caller of warnMissingOptionalGrammars
    // (which require()s each grammar); cli/mcp.ts itself does not invoke
    // it, and its static-import closure is leaf-only — so importing
    // dist/cli/mcp.js without invoking mcpCommand must not trigger any
    // native grammar binding load.
    const treeSitterNative = probe.matching(/tree-sitter-[a-z]+[\\/]build/);
    expect(
      treeSitterNative,
      `tree-sitter native bindings loaded at cli/mcp.js static-import time:\n${treeSitterNative.join('\n')}`,
    ).toEqual([]);
  });
});
