import type { ScopeResolutionIndexes } from '../../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../../src/core/ingestion/scope-extractor-bridge.js';
import { javaScopeResolver } from '../../../../../src/core/ingestion/languages/java/scope-resolver.js';
import { populateJavaPackageSiblings } from '../../../../../src/core/ingestion/languages/java/package-siblings.js';

/**
 * Regression coverage for the post-finalize parse hooks after
 * `parseSourceSafe` started throwing `ParseTimeoutError` (#1922). A single
 * pathological file that times out must NOT abort the whole hook run — the
 * hook must hard-skip it (degrade-and-continue) and still process the
 * remaining good files.
 *
 * Strategy: build all ParsedFiles with a generous budget, THEN set a 1ms
 * budget so the large file times out on the hook's cache-miss re-parse while
 * the small good file still parses cleanly (tree-sitter only checks the budget
 * periodically, so trivial sources complete before the first check — same
 * assumption the safe-parse timeout suite relies on).
 */

const ORIGINAL_BUDGET = process.env.GITNEXUS_PARSE_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) {
    delete process.env.GITNEXUS_PARSE_TIMEOUT_MS;
  } else {
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = ORIGINAL_BUDGET;
  }
});

interface ResolverLike {
  languageProvider: Parameters<typeof extractParsedFile>[0];
  populateOwners: (p: ParsedFile) => void;
}

function parse(resolver: ResolverLike, src: string, path: string): ParsedFile {
  const p = extractParsedFile(resolver.languageProvider, src, path);
  if (p === undefined) throw new Error(`scope extraction failed for ${path}`);
  resolver.populateOwners(p);
  return p;
}

function makeEmptyIndexes(): ScopeResolutionIndexes {
  return {
    bindings: new Map(),
    bindingAugmentations: new Map(),
    imports: [],
    scopeTree: { roots: [] } as any,
    methodDispatch: new Map(),
    sccs: [],
  } as unknown as ScopeResolutionIndexes;
}

/**
 * A source large enough that a 1ms parse budget reliably times out on the
 * hook's cache-miss re-parse (any parse taking >1ms trips the deadline, which
 * tree-sitter checks every 100 ops), but small enough that the no-budget
 * `extractParsedFile` setup parse stays fast on every grammar (C++ in
 * particular is slow per byte, so 15k lines made setup take ~80s/test).
 */
function pathological(repeatLine: string): string {
  return repeatLine.repeat(2_000);
}

describe('post-finalize parse hooks — single timeout does not abort the run (#1922)', () => {
  for (const example of [
    {
      label: 'Java',
      resolver: javaScopeResolver,
      populate: populateJavaPackageSiblings,
      extension: 'java',
      packageStatement: 'package com.example;',
    },
  ] as const) {
    it(`${example.label}: a timed-out file degrades to no package without aborting siblings`, () => {
      const { resolver, populate, extension, packageStatement } = example;

      const a = `${packageStatement}\nclass A {}`;
      const b = `${packageStatement}\nclass B {}`;
      const bad = `${packageStatement}\n${pathological('class Filler {}\n')}`;

      const aPath = `A.${extension}`;
      const bPath = `B.${extension}`;
      const badPath = `Bad.${extension}`;
      const aParsed = parse(resolver as unknown as ResolverLike, a, aPath);
      const bParsed = parse(resolver as unknown as ResolverLike, b, bPath);
      const badParsed = parse(resolver as unknown as ResolverLike, bad, badPath);
      const fileContents = new Map<string, string>([
        [aPath, a],
        [bPath, b],
        [badPath, bad],
      ]);

      process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
      assert.doesNotThrow(() =>
        populate([badParsed, aParsed, bParsed], makeEmptyIndexes(), { fileContents }),
      );
    });
  }
});
