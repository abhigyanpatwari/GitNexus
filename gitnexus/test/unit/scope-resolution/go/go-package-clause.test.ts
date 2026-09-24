import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import {
  goPackageDir,
  inferGoPackageName,
} from '../../../../src/core/ingestion/languages/go/package-clause.js';
import { getGoParser, getGoScopeQuery } from '../../../../src/core/ingestion/languages/go/query.js';
import { GO_QUERIES } from '../../../../src/core/ingestion/tree-sitter-queries.js';

/**
 * #2837. Both Go package-bucketing passes used to carry their own copy of
 *
 *     sourceText.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)
 *
 * whose `m` flag matches the first `package <ident>` line ANYWHERE in the file,
 * comment bodies included. The two rows marked "regression" below were measured
 * returning the decoy name against that expression; everything else is a
 * behaviour-preservation control, because a stricter resolver that rejected a
 * real-world header would be a worse bug than the one being fixed.
 */
describe('inferGoPackageName (#2837)', () => {
  it('reads a plain package clause', () => {
    expect(inferGoPackageName('package services\n\nfunc f() {}\n')).toBe('services');
  });

  it('reads past a build constraint', () => {
    expect(inferGoPackageName('//go:build linux\n\npackage services\n')).toBe('services');
  });

  it('reads past a line-comment doc block', () => {
    expect(inferGoPackageName('// Package services does things.\npackage services\n')).toBe(
      'services',
    );
  });

  // REGRESSION: measured as "legacy_notes" before the fix.
  it('ignores a package line inside a block comment', () => {
    const src = '/*\npackage legacy_notes kept for history\n*/\npackage services\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  // REGRESSION: measured as "helper" before the fix.
  it('ignores an indented package line inside a block comment', () => {
    const src = '/*\n  package helper old name\n*/\npackage services\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  it('reads past several comments on one line', () => {
    expect(inferGoPackageName('/* a */ /* b */ package services\n')).toBe('services');
  });

  it('reads past a byte-order mark and CRLF line endings', () => {
    expect(inferGoPackageName('﻿//go:build linux\r\n\r\npackage services\r\n')).toBe('services');
  });

  it('is not fooled by a package line inside a later raw string literal', () => {
    const src = 'package services\n\nconst tmpl = `\npackage other\n`\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  // Go separates tokens by any whitespace, so this is legal and tree-sitter
  // parses it without error. A stricter matcher would drop the file from BOTH
  // Go cross-file passes (#2843 review).
  it('accepts a newline between the keyword and the package name', () => {
    expect(inferGoPackageName('package\nmain\n\nfunc f() {}\n')).toBe('main');
  });

  it('accepts CR-only line endings', () => {
    expect(inferGoPackageName('//go:build linux\r\rpackage services\r')).toBe('services');
  });

  // `gorun`-style scripts. Not legal Go, but the regex this replaced skipped it
  // via `/m`, so rejecting it would be a silent regression rather than a
  // principled tightening.
  it('reads past a leading shebang line', () => {
    expect(inferGoPackageName('#!/usr/bin/env gorun\n\npackage main\n')).toBe('main');
  });

  it('still stops on a # that is not a first-line shebang', () => {
    expect(inferGoPackageName('// doc\n#!/usr/bin/env gorun\npackage main\n')).toBeNull();
  });

  it('returns null when the first real token is not a package clause', () => {
    expect(inferGoPackageName('func main() {}\n')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(inferGoPackageName('')).toBeNull();
  });

  it('returns null for an unterminated block comment', () => {
    expect(inferGoPackageName('/* never closed\npackage services\n')).toBeNull();
  });

  it('returns null for a line comment running to EOF', () => {
    expect(inferGoPackageName('// only a comment')).toBeNull();
  });
});

describe('goPackageDir', () => {
  it('returns the containing directory', () => {
    expect(goPackageDir('internal/services/pick_service.go')).toBe('internal/services');
  });

  it('normalizes Windows separators', () => {
    expect(goPackageDir('internal\\services\\pick_service.go')).toBe('internal/services');
  });

  it('returns an empty string for a repo-root file', () => {
    expect(goPackageDir('main.go')).toBe('');
  });
});

/**
 * The scope/def range contract, asserted directly (#2843 review).
 *
 * #2837 moved five Go captures from the `type_declaration` onto the `type_spec`.
 * That contract was previously observable only as 70 changed digests in the
 * captures golden, where a future edit that moved ranges again would look
 * identical. These rows state it outright, and pin the LOCKSTEP requirement:
 * the scope capture and the def capture must name the SAME node, or the def is
 * larger than its own scope and nothing is owned.
 */
describe('Go type capture anchoring (#2837)', () => {
  // The SHIPPED queries, not copies of them. Inlining the patterns here would
  // make every row below assert against the test's own string, so reverting the
  // real re-anchor would leave them green — the exact regression they exist to
  // catch. `getGoScopeQuery()` is the memoized `GO_SCOPE_QUERY`; `GO_QUERIES` is
  // what the parse worker runs.
  const goQueries = new Parser.Query(Go as Parameters<Parser['setLanguage']>[0], GO_QUERIES);
  const nodesNamed = (src: string, query: Parser.Query, name: string) =>
    query
      .captures(getGoParser().parse(src).rootNode)
      .filter((c) => c.name === name)
      .map((c) => c.node);
  const classScopes = (src: string) => nodesNamed(src, getGoScopeQuery(), 'scope.class');

  it('anchors the class scope on the type_spec, one per declared type', () => {
    const nodes = classScopes(
      'package p\ntype ( A struct{ x int }\n B struct{ y int } )\ntype C struct{}\n',
    );
    expect(nodes.map((n) => n.type)).toEqual(['type_spec', 'type_spec', 'type_spec']);
    expect(nodes.map((n) => n.childForFieldName('name')?.text)).toEqual(['A', 'B', 'C']);
  });

  it('starts the scope range at the type name, not the `type` keyword', () => {
    const [scope] = classScopes('package p\ntype C struct{}\n');
    expect(scope!.startIndex).toBe(scope!.childForFieldName('name')!.startIndex);
  });

  // The lockstep invariant, checked ACROSS the two shipped queries: the scope
  // capture in languages/go/query.ts and the definition capture in
  // tree-sitter-queries.ts must name the same node. Moving one without the other
  // made the def strictly larger than its own scope and deleted every Go
  // field-receiver edge, plain declarations included.
  it('anchors scope and definition on the same node', () => {
    const src = 'package p\ntype ( A struct{ x int }\n B struct{ y int } )\n';
    const defs = nodesNamed(src, goQueries, 'definition.struct');
    expect(defs.map((d) => d.type)).toEqual(['type_spec', 'type_spec']);
    expect(defs.map((d) => d.startIndex)).toEqual(classScopes(src).map((s) => s.startIndex));
  });

  it('emits no class scope for an alias or a named non-struct type', () => {
    expect(classScopes('package p\ntype Alias = Other\ntype Named int\n')).toHaveLength(0);
  });
});
