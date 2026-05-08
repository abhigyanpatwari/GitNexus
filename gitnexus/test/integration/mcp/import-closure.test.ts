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
 * This test locks in the fix: spawn a child Node process, import the built
 * `dist/cli/mcp.js` (without invoking `mcpCommand`), and assert that
 * `@ladybugdb/core` is NOT in the loaded-module set. The assertion is
 * evidence-based — it checks Node's CJS module cache, which is global per
 * process and tracks every native/CJS module loaded by either ESM or CJS
 * importers.
 *
 * Characterization-first: this test was written before the fix landed and
 * MUST fail against the pre-fix code. Run against the parent of the U1
 * commit to verify the regression signal works.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_MCP = path.join(REPO_ROOT, 'dist', 'cli', 'mcp.js');
const DIST_MCP_URL = pathToFileURL(DIST_MCP).href;

const PROBE = `
  import { createRequire } from 'node:module';
  const req = createRequire(import.meta.url);
  const before = new Set(Object.keys(req.cache));
  await import(process.env.PROBE_TARGET);
  const after = new Set(Object.keys(req.cache));
  const newlyLoaded = [...after].filter((k) => !before.has(k));
  process.stdout.write(JSON.stringify(newlyLoaded));
`;

describe('MCP CLI static-import closure', () => {
  it('does not load @ladybugdb/core when cli/mcp.js is imported (without invoking mcpCommand)', () => {
    if (!fs.existsSync(DIST_MCP)) {
      throw new Error(
        `dist/cli/mcp.js missing — run \`npm run build\` first (or \`npm run test:integration\` which builds via pretest:integration).`,
      );
    }

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: REPO_ROOT,
      env: { ...process.env, PROBE_TARGET: DIST_MCP_URL, NODE_OPTIONS: '' },
      timeout: 30_000,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `probe failed (status ${result.status}):\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }

    const newlyLoaded = JSON.parse(result.stdout) as string[];

    // The headline assertion: @ladybugdb/core (a native CJS module) must not
    // be loaded by the static-import closure of cli/mcp.js. If it is, the
    // pre-sentinel stdout window the prior fix tried to close is still open.
    const ladybugLoaded = newlyLoaded.filter((p) => /@ladybugdb[\\/]core/.test(p));
    expect(
      ladybugLoaded,
      `@ladybugdb/core was loaded at cli/mcp.js static-import time. ` +
        `mcpCommand cannot install the stdout sentinel before native init runs. ` +
        `Offending paths:\n${ladybugLoaded.join('\n')}\n\n` +
        `Full newly-loaded set (${newlyLoaded.length} entries):\n${newlyLoaded.join('\n')}`,
    ).toEqual([]);
  });

  it('does not load any tree-sitter native binding (sanity check on grammar imports)', () => {
    if (!fs.existsSync(DIST_MCP)) {
      throw new Error(`dist/cli/mcp.js missing — run \`npm run build\` first.`);
    }

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: REPO_ROOT,
      env: { ...process.env, PROBE_TARGET: DIST_MCP_URL, NODE_OPTIONS: '' },
      timeout: 30_000,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`probe failed: ${result.stderr}`);
    }

    const newlyLoaded = JSON.parse(result.stdout) as string[];
    // No tree-sitter parser should load at cli/mcp.js static-import time.
    // The analyze path is the only caller of warnMissingOptionalGrammars
    // (which require()s each grammar); cli/mcp.ts itself does not invoke
    // it, and its static-import closure is leaf-only — so importing
    // dist/cli/mcp.js without invoking mcpCommand must not trigger any
    // native grammar binding load.
    const treeSitterNative = newlyLoaded.filter((p) => /tree-sitter-[a-z]+[\\/]build/.test(p));
    expect(
      treeSitterNative,
      `tree-sitter native bindings loaded at cli/mcp.js static-import time:\n${treeSitterNative.join('\n')}`,
    ).toEqual([]);
  });
});
