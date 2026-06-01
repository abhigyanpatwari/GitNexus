import { describe, it, expect, afterEach } from 'vitest';
import type { ParsedFile, ScopeResolutionIndexes } from 'gitnexus-shared';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { goScopeResolver } from '../../src/core/ingestion/languages/go/scope-resolver.js';
import { cppScopeResolver } from '../../src/core/ingestion/languages/cpp/scope-resolver.js';
import { rustScopeResolver } from '../../src/core/ingestion/languages/rust/scope-resolver.js';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.js';
import { populateGoRangeBindings } from '../../src/core/ingestion/languages/go/range-binding.js';
import { populateCppRangeBindings } from '../../src/core/ingestion/languages/cpp/range-bindings.js';
import { populateRustRangeBindings } from '../../src/core/ingestion/languages/rust/range-binding.js';
import { populateJavaPackageSiblings } from '../../src/core/ingestion/languages/java/package-siblings.js';

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
  it('Go: times out the bad file, still binds the good file', () => {
    const good = `package main
func main() {
  items := []string{"a", "b"}
  for _, v := range items {
    _ = v
  }
}`;
    // Large but syntactically plausible Go so extractParsedFile succeeds.
    const bad = 'package main\n' + pathological('var x = 1\n');

    const goodParsed = parse(goScopeResolver as unknown as ResolverLike, good, 'good.go');
    const badParsed = parse(goScopeResolver as unknown as ResolverLike, bad, 'bad.go');
    const fileContents = new Map<string, string>([
      ['good.go', good],
      ['bad.go', bad],
    ]);

    // The bad file is first, so reaching the good file proves the timeout was
    // caught and the loop continued. Not throwing IS the regression assertion
    // (pre-fix this aborted the whole run). The resolved binding VALUE is not
    // asserted here: range-binding resolves types from state populated by
    // earlier pipeline phases (propagateImportedReturnTypes etc.) that this
    // isolated hook-level test does not run, so it would be undefined either way.
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    expect(() =>
      populateGoRangeBindings([badParsed, goodParsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('C++: times out the bad file, still binds the good file', () => {
    const good = `#include <vector>
void f(std::vector<User>& users) {
  for (auto& u : users) {
    (void)u;
  }
}`;
    const bad = pathological('int x = 1;\n');

    const goodParsed = parse(cppScopeResolver as unknown as ResolverLike, good, 'good.cpp');
    const badParsed = parse(cppScopeResolver as unknown as ResolverLike, bad, 'bad.cpp');
    const fileContents = new Map<string, string>([
      ['good.cpp', good],
      ['bad.cpp', bad],
    ]);

    // Not throwing is the regression assertion (the timeout on the first file
    // is caught and the loop continues to the good file). The resolved binding
    // value depends on earlier pipeline phases not run in this isolated test.
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    expect(() =>
      populateCppRangeBindings([badParsed, goodParsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('Rust: times out the bad file, still binds the good file', () => {
    const good = `struct User { name: String }
fn main() {
  let users: Vec<User> = vec![];
  for u in users {
    let _ = u;
  }
}`;
    const bad = pathological('static X: i32 = 1;\n');

    const goodParsed = parse(rustScopeResolver as unknown as ResolverLike, good, 'good.rs');
    const badParsed = parse(rustScopeResolver as unknown as ResolverLike, bad, 'bad.rs');
    const fileContents = new Map<string, string>([
      ['good.rs', good],
      ['bad.rs', bad],
    ]);

    // Not throwing is the regression assertion (the timeout on the first file
    // is caught and the loop continues to the good file). The resolved binding
    // value depends on earlier pipeline phases not run in this isolated test.
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    expect(() =>
      populateRustRangeBindings([badParsed, goodParsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('Java: a timed-out file degrades to "no package" without aborting siblings', () => {
    // Two good same-package files so sibling injection has work to do, plus a
    // bad file whose package extraction times out and degrades to '' (its own
    // bucket) rather than throwing.
    const a = `package com.example;
class A {}`;
    const b = `package com.example;
class B {}`;
    const bad = 'package com.example;\n' + pathological('class Filler {}\n');

    const aParsed = parse(javaScopeResolver as unknown as ResolverLike, a, 'A.java');
    const bParsed = parse(javaScopeResolver as unknown as ResolverLike, b, 'B.java');
    const badParsed = parse(javaScopeResolver as unknown as ResolverLike, bad, 'Bad.java');
    const fileContents = new Map<string, string>([
      ['A.java', a],
      ['B.java', b],
      ['Bad.java', bad],
    ]);

    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    expect(() =>
      populateJavaPackageSiblings([badParsed, aParsed, bParsed], makeEmptyIndexes(), {
        fileContents,
      }),
    ).not.toThrow();
  });
});
