/**
 * Read-only contract over the REAL gitnexus/package.json for the R grammar. The
 * prepare-tree-sitter-bundle unit tests use a synthetic fixture, so nothing else in the
 * unit tier notices if the shipped manifest stops bundling or exact-pinning the R grammar,
 * or if its version drifts from the audited peer table that the pack step validates.
 * (The packaged-install smoke in CI is the end-to-end check; this fails earlier.)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grammarRebuildPackage } from '../../src/core/tree-sitter/parser-loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
};
const script = readFileSync(path.join(root, 'scripts/prepare-tree-sitter-bundle.cjs'), 'utf8');

const R_GRAMMAR = '@eagleoutice/tree-sitter-r';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** The keys of the script's AUDITED_PEERS map literal (`['name@version', 'range']`). */
function auditedPeerKeys(): string[] {
  const block = /const AUDITED_PEERS = new Map\(\[([\s\S]*?)\]\);/.exec(script)?.[1] ?? '';
  return [...block.matchAll(/\[\s*'([^']+)'\s*,/g)].map((m) => m[1]);
}

describe('R grammar entry in the shipped package.json', () => {
  it('is a runtime dependency pinned to an exact version', () => {
    expect(manifest.dependencies[R_GRAMMAR]).toMatch(EXACT_VERSION);
  });

  it('is bundled, so consumers do not depend on npm overrides', () => {
    expect(manifest.bundleDependencies).toContain(R_GRAMMAR);
  });

  it('matches a version in the AUDITED_PEERS table of the pack step', () => {
    const keys = auditedPeerKeys();
    expect(keys.length).toBeGreaterThan(1); // the parse of the table itself works
    expect(keys).toContain(`${R_GRAMMAR}@${manifest.dependencies[R_GRAMMAR]}`);
  });

  it('is the only audited version of the R grammar', () => {
    expect(auditedPeerKeys().filter((k) => k.startsWith(`${R_GRAMMAR}@`))).toHaveLength(1);
  });
});

describe('the npm rebuild hint for a grammar that failed to load', () => {
  it('names the scoped R grammar package, not tree-sitter-r', () => {
    expect(grammarRebuildPackage('r')).toBe(R_GRAMMAR);
  });

  it('keeps the tree-sitter-<language> default for every other language', () => {
    expect(grammarRebuildPackage('go')).toBe('tree-sitter-go');
    expect(grammarRebuildPackage('python')).toBe('tree-sitter-python');
  });
});
