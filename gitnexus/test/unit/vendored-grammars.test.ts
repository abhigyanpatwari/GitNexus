import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
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

/** All `.ts` files under src/, recursively. */
function srcFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts'))
    .map((p) => path.join(SRC_ROOT, p));
}

/**
 * A bare ESM/CJS load of a vendored grammar package, ignoring matches that sit
 * inside a `//` or `*` comment (several query.ts files mention the bad pattern
 * in prose, e.g. "`import Dart from 'tree-sitter-dart'` would throw").
 */
function bareVendoredLoadLines(file: string): string[] {
  const names = [...VENDORED_GRAMMAR_PACKAGES].join('|');
  const re = new RegExp(`(?:from|require\\(|require\\.resolve\\()\\s*['"](?:${names})['"]`);
  const hits: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    const before = raw.slice(0, m.index);
    const trimmed = raw.trimStart();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || before.includes('//');
    if (!isComment) hits.push(raw.trim());
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

  it('no src file bare-imports/requires a vendored grammar (would force a node_modules copy back)', () => {
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      for (const line of bareVendoredLoadLines(file)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: ${line}`);
      }
    }
    expect(
      offenders,
      `Use requireVendoredGrammar(...) instead of a bare specifier:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
