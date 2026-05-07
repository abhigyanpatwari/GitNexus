import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { goScopeResolver } from '../../../../src/core/ingestion/languages/go/scope-resolver.js';
import { populateGoRangeBindings } from '../../../../src/core/ingestion/languages/go/range-binding.js';
import type { ParsedFile, ScopeResolutionIndexes } from 'gitnexus-shared';

function parseGo(src: string, path = 'main.go'): ParsedFile {
  const p = extractParsedFile(goScopeResolver.languageProvider, src, path);
  if (p === undefined) throw new Error(`scope extraction failed for ${path}`);
  goScopeResolver.populateOwners(p);
  return p;
}

function makeEmptyIndexes(): ScopeResolutionIndexes {
  return {
    bindings: new Map(),
    imports: [],
    scopeTree: { roots: [] } as any,
    methodDispatch: new Map(),
    sccs: [],
  } as ScopeResolutionIndexes;
}

describe('Go range binding — null guard (#1346, #1366)', () => {
  it('does not crash on plain for loop (no range_clause)', () => {
    const src = `package main
func main() {
  for i := 0; i < 10; i++ {
    _ = i
  }
}`;
    const parsed = parseGo(src);
    const fileContents = new Map<string, string>([['main.go', src]]);
    // Before fix: rangeClause was undefined, checked with === null,
    // then rangeClause.namedChildren crashed.
    expect(() =>
      populateGoRangeBindings([parsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('does not crash on for-range without expression_list', () => {
    // Single variable range without comma: for v := range ch
    const src = `package main
func main() {
  ch := make(chan int)
  for v := range ch {
    _ = v
  }
}`;
    const parsed = parseGo(src);
    const fileContents = new Map<string, string>([['main.go', src]]);
    expect(() =>
      populateGoRangeBindings([parsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('does not crash on for-range over map with blank identifier', () => {
    const src = `package main
func main() {
  m := map[string]int{"a": 1}
  for _, v := range m {
    _ = v
  }
}`;
    const parsed = parseGo(src);
    const fileContents = new Map<string, string>([['main.go', src]]);
    expect(() =>
      populateGoRangeBindings([parsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('does not crash on for-range with type alias target', () => {
    const src = `package main
type Users []string
func main() {
  var users Users
  for _, u := range users {
    _ = u
  }
}`;
    const parsed = parseGo(src);
    const fileContents = new Map<string, string>([['main.go', src]]);
    expect(() =>
      populateGoRangeBindings([parsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });

  it('does not crash on nested for loops mixing plain and range', () => {
    const src = `package main
func main() {
  items := []string{"a", "b"}
  for i := 0; i < len(items); i++ {
    for _, v := range items {
      _ = v
    }
  }
}`;
    const parsed = parseGo(src);
    const fileContents = new Map<string, string>([['main.go', src]]);
    expect(() =>
      populateGoRangeBindings([parsed], makeEmptyIndexes(), { fileContents }),
    ).not.toThrow();
  });
});
