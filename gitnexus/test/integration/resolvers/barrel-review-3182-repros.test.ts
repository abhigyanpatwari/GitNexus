/**
 * Pipeline-level reproductions from magyargergo's review of #3182, each of
 * which produced an incorrect or missing CALLS edge at 6d3ac0d8:
 *
 *  1. finalize-algorithm.ts:1374 — a function NESTED in another function behind
 *     an `export *` barrel displaced the real exported value of the same name
 *     (0.85 edge to `wrapper.selected`, which is private to `wrapper`).
 *  2. javascript/scope-resolver.ts:105 — `module.exports = { alpha() {} }` +
 *     `const { alpha } = require('./lib')`: the Method IS the module's export,
 *     and `namedImportsBindTopLevelOnly` sent the exact import to a name guess
 *     (and to nothing at all once another module declared its own `alpha`).
 *  3. finalize-algorithm.ts:1049 — `export class Unrelated { clash() {} }` in
 *     the barrel made `clash` a local name and switched the star-vs-star
 *     collision check off.
 *  4. free-call-fallback.ts:710 — `alpha(); precise();` vs `precise(); alpha();`
 *     after `import { alpha as precise }` gave different edges for one
 *     dependency. A precisely resolved site proves the edge in either order.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './helpers.js';

async function run(name: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-3182-${name}-`));
  try {
    writeFixtureRepo(dir, files);
    const result = await runPipelineFromRepo(dir, () => {});
    const calls = getRelationships(result, 'CALLS')
      .filter(
        (e) => e.sourceFilePath.endsWith('caller.ts') || e.sourceFilePath.endsWith('caller.js'),
      )
      .map((e) => ({
        target: e.target,
        targetId: e.rel.targetId,
        targetFile: path.basename(e.targetFilePath),
        confidence: e.rel.confidence,
        reason: e.rel.reason,
      }))
      .sort((a, b) => a.target.localeCompare(b.target) || a.targetFile.localeCompare(b.targetFile));
    return { calls, outcomes: getResolutionOutcomes(result) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('#3182 review reproductions', () => {
  it('1. a nested function behind `export *` does not displace the exported value of the same name', async () => {
    const { calls } = await run('nested', {
      'package.json': '{ "name": "r", "private": true }\n',
      'lib.ts': `export function factory() { return () => 1; }\nexport const selected = factory();\nfunction wrapper() { function selected() {} return selected; }\nexport { wrapper };\n`,
      'index.ts': `export * from './lib';\n`,
      'caller.ts': `import { selected } from './index';\nexport function go() { return selected(); }\n`,
    });
    // `selected` is a `const` value (arrow returned by a call) — the graph
    // has no Function node for it, so the honest outcome is NO edge to a
    // callable named `selected`; above all, none to `wrapper`'s private one.
    expect(calls.filter((c) => c.target === 'selected')).toEqual([]);
  }, 120000);

  it('2. a CommonJS `module.exports = { alpha() {} }` member binds an exact destructured require', async () => {
    const files = {
      'package.json': '{ "name": "r", "private": true }\n',
      'lib.js': `module.exports = { alpha() { return 1; } };\n`,
      'caller.js': `const { alpha } = require('./lib');\nfunction run() { return alpha(); }\nmodule.exports = { run };\n`,
    };
    const single = await run('cjs1', files);
    expect(single.calls).toEqual([
      {
        target: 'alpha',
        targetId: 'Method:lib.js:alpha#0',
        targetFile: 'lib.js',
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ]);
    // A second module declaring its own `alpha` must not turn the exact import
    // into an ambiguous guess that disappears.
    const dup = await run('cjs2', {
      ...files,
      'other.js': `function alpha() { return 2; }\nmodule.exports = { alpha };\n`,
    });
    expect(dup.calls).toEqual([
      {
        target: 'alpha',
        targetId: 'Method:lib.js:alpha#0',
        targetFile: 'lib.js',
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ]);
  }, 120000);

  it('3. a class member in the barrel does not shadow a star-vs-star collision', async () => {
    const { calls, outcomes } = await run('shadow', {
      'package.json': '{ "name": "r", "private": true }\n',
      'a.ts': `export function clash() { return 'a'; }\n`,
      'b.ts': `export function clash() { return 'b'; }\n`,
      'index.ts': `export * from './a';\nexport * from './b';\nexport class Unrelated { clash() { return 0; } }\n`,
      'caller.ts': `import { clash } from './index';\nexport function go() { return clash(); }\n`,
    });
    expect(calls.filter((c) => c.target === 'clash')).toEqual([]);
    expect(outcomes.some((o) => o.kind === 'reexport-ambiguous' && o.name === 'clash')).toBe(true);
  }, 120000);

  it('4. `alpha(); precise();` and `precise(); alpha();` yield the same import-resolved edge', async () => {
    const base = {
      'package.json': '{ "name": "r", "private": true }\n',
      'lib.ts': `export function alpha() { return 1; }\n`,
    };
    const guessFirst = await run('order1', {
      ...base,
      'caller.ts': `import { alpha as precise } from './lib';\nexport function go() { alpha(); precise(); }\n`,
    });
    const preciseFirst = await run('order2', {
      ...base,
      'caller.ts': `import { alpha as precise } from './lib';\nexport function go() { precise(); alpha(); }\n`,
    });
    const expected = [
      {
        target: 'alpha',
        targetId: 'Function:lib.ts:alpha',
        targetFile: 'lib.ts',
        confidence: 0.85,
        reason: 'import-resolved',
      },
    ];
    expect(guessFirst.calls).toEqual(expected);
    expect(preciseFirst.calls).toEqual(expected);
  }, 120000);
});
