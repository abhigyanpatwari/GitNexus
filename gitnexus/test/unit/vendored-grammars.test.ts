import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VENDOR_ROOT,
  VENDORED_GRAMMAR_PACKAGES,
  vendoredGrammarDir,
  requireVendoredGrammar,
} from '../../src/core/tree-sitter/vendored-grammars.js';

/**
 * Regression guard for #2111 / #1728.
 *
 * The five vendored tree-sitter grammars (c/dart/proto/swift/kotlin) MUST load
 * from `vendor/` by absolute path and MUST NEVER be copied into / required from
 * `node_modules`. An undeclared package under node_modules is "extraneous" to
 * every subsequent npm/npx arborist reify, which prunes/relocates it — on
 * Windows that threw `EPERM: operation not permitted, symlink` during the
 * npx-cache reify an MCP client triggers, and on every OS it silently deleted
 * the grammars on the 2nd run. These tests fail if anyone reintroduces a bare
 * `require('tree-sitter-<vendored>')` / `import … from 'tree-sitter-<vendored>'`
 * (which would force a node_modules copy back into existence).
 */

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

const TEST_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * All `.ts` files we police: every file under src/, plus test/ EXCEPT
 * test/fixtures/ (fixtures are arbitrary sample code to be analyzed, not our
 * code). A reintroduced bare load can defeat the fix from test/ too, so the
 * guard must cover it — not just src/.
 */
function policedFiles(): string[] {
  const self = fileURLToPath(import.meta.url);
  const under = (root: string) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('.ts'))
      .map((p) => path.join(root, p));
  return [
    ...under(SRC_ROOT),
    ...under(TEST_ROOT).filter((p) => !p.includes(`${path.sep}fixtures${path.sep}`)),
    // This guard file itself holds the bad-load patterns as regex-probe fixtures.
  ].filter((p) => p !== self);
}

/**
 * A bare ESM/CJS load of a vendored grammar package in real code. Covers every
 * node_modules-forcing form — static `import … from`, side-effect `import 'x'`,
 * dynamic `import('x')`, `require('x')`, `require.resolve('x')` — with single,
 * double, OR backtick quotes, and an optional `/subpath`. Skips matches inside a
 * leading-`//` or `*` comment (several query.ts files mention the bad pattern in
 * prose, e.g. "`import Dart from 'tree-sitter-dart'` would throw"). Biased toward
 * over-matching: a missed real load defeats the guard, a flagged trailing-comment
 * mention only costs a glance.
 */
function bareVendoredLoadLines(file: string): string[] {
  const names = [...VENDORED_GRAMMAR_PACKAGES].join('|');
  // prefix: `from`, `import(`, `import ` (side-effect), `require(`, `require.resolve(`
  const re = new RegExp(
    `(?:from|import|require\\(|require\\.resolve\\()\\s*\\(?\\s*['"\\\`](?:${names})(?:/[^'"\\\`]*)?['"\\\`]`,
  );
  const hits: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    const trimmed = raw.trimStart();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
    if (!isComment) hits.push(`${path.basename(file)}: ${raw.trim()}`);
  }
  return hits;
}

describe('vendored grammars load from vendor/ (#2111)', () => {
  it('resolves every vendored grammar to a real dir under vendor/, never node_modules', () => {
    expect(VENDOR_ROOT.endsWith(`${path.sep}vendor`)).toBe(true);
    for (const pkg of VENDORED_GRAMMAR_PACKAGES) {
      const dir = vendoredGrammarDir(pkg);
      expect(dir.startsWith(VENDOR_ROOT)).toBe(true);
      expect(dir.includes(`${path.sep}node_modules${path.sep}`)).toBe(false);
      expect(existsSync(dir), `${pkg} missing under vendor/`).toBe(true);
    }
  });

  it('loads each vendored grammar by absolute path (committed prebuild, no node_modules copy)', () => {
    for (const pkg of VENDORED_GRAMMAR_PACKAGES) {
      const grammar = requireVendoredGrammar(pkg);
      expect(grammar, `${pkg} failed to load from vendor/`).toBeTruthy();
    }
  });

  it('no src/test file bare-imports/requires a vendored grammar (would force a node_modules copy back)', () => {
    const offenders = policedFiles().flatMap(bareVendoredLoadLines);
    expect(
      offenders,
      `Use requireVendoredGrammar(...) instead of a bare specifier:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('guard regex catches every node_modules-forcing load form (and ignores prose mentions)', () => {
    // Sanity-check the guard itself so the adversarial bypasses (#2144 review)
    // stay closed: static/side-effect/dynamic/subpath/backtick all flagged,
    // requireVendoredGrammar + leading-comment prose ignored.
    const tmp = path.join(fileURLToPath(new URL('.', import.meta.url)), `__guard_probe__.ts.txt`);
    const caught = [
      `import C from 'tree-sitter-c';`,
      `import 'tree-sitter-dart';`,
      `await import('tree-sitter-kotlin');`,
      `const x = require('tree-sitter-swift');`,
      `require.resolve('tree-sitter-proto');`,
      'const y = require(`tree-sitter-c`);',
      `import Node from 'tree-sitter-c/bindings/node';`,
    ];
    const ignored = [
      `// import C from 'tree-sitter-c' would throw`,
      ` * mentions 'tree-sitter-dart' in a block comment`,
      `requireVendoredGrammar('tree-sitter-c');`,
      `import Cpp from 'tree-sitter-cpp';`, // not a vendored grammar
    ];
    writeFileSync(tmp, [...caught, ...ignored].join('\n'));
    try {
      const flagged = bareVendoredLoadLines(tmp).map((l) => l.split(': ').slice(1).join(': '));
      for (const c of caught) expect(flagged, `should flag: ${c}`).toContain(c);
      for (const i of ignored) expect(flagged, `should NOT flag: ${i}`).not.toContain(i);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
