/**
 * #2788 — `resolveCppQualifiedNamespaceMember` serves qualified `ns::member()`
 * lookups from a per-pipeline index instead of rescanning every parsed file per
 * call site. These tests pin the properties the index must not lose:
 *
 *   1. Transitive inline-namespace collection — parent- and child-level member
 *      visibility through one receiver — and same-name ambiguity (#1564): the
 *      semantics the old linear scan provided.
 *   2. Cross-file accumulation — C++ namespaces are open, so one receiver's
 *      members are spread over however many files reopen it. The legacy scan
 *      re-derived its hits per call site and got this for free; the index has
 *      to merge across the whole `parsedFiles` array to match it.
 *   3. Cache invalidation — a new `parsedFiles` array, or a
 *      `clearCppInlineNamespaces()` between passes, must not serve stale hits.
 *      This is the failure mode the index introduces; nothing else covers it.
 */

import type {
  ParsedFile,
  ScopeId,
  ScopeResolutionIndexes,
  SymbolDefinition,
} from 'gitnexus-shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCppInlineNamespaces,
  markCppInlineNamespaceRange,
  populateCppInlineNamespaceScopes,
  resolveCppQualifiedNamespaceMember,
} from '../../../../src/core/ingestion/languages/cpp/inline-namespaces.js';

const NO_SCOPES = {} as unknown as ScopeResolutionIndexes;

interface ScopeSpec {
  readonly id: string;
  readonly parent: string | null;
  readonly defs: readonly SymbolDefinition[];
  /** Distinguishes each scope's range so inline marking targets exactly one. */
  readonly line: number;
}

function def(nodeId: string, type: string, qualifiedName: string): SymbolDefinition {
  return { nodeId, type, qualifiedName } as unknown as SymbolDefinition;
}

function nsDef(nodeId: string, qualifiedName: string): SymbolDefinition {
  return def(nodeId, 'Namespace', qualifiedName);
}

function fnDef(nodeId: string, qualifiedName: string): SymbolDefinition {
  return def(nodeId, 'Function', qualifiedName);
}

function ns(
  id: string,
  parent: string | null,
  defs: readonly SymbolDefinition[],
  line: number,
): ScopeSpec {
  return { id, parent, defs, line };
}

function range(line: number): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  return { startLine: line, startCol: 0, endLine: line + 1, endCol: 0 };
}

/** Build one `ParsedFile` from scope specs, marking the scopes named in
 *  `inlineIds` as inline namespaces (capture-time range mark +
 *  `populateOwners`-time scope-id resolution, same order as the pipeline).
 *  Separate from {@link makeParsedFiles} so a test can compose a genuinely
 *  MULTI-file `parsedFiles` array, which is the only way to exercise the
 *  index's cross-file accumulation. */
function makeParsedFile(
  filePath: string,
  specs: readonly ScopeSpec[],
  inlineIds: readonly string[],
): ParsedFile {
  const parsed = {
    filePath,
    scopes: specs.map((s) => ({
      id: s.id as unknown as ScopeId,
      kind: 'Namespace',
      parent: s.parent as unknown as ScopeId | null,
      ownedDefs: s.defs,
      range: range(s.line),
    })),
  } as unknown as ParsedFile;
  markInline(parsed, specs, inlineIds);
  return parsed;
}

/** Single-file `parsedFiles` array — the shape most of these tests need. */
function makeParsedFiles(
  filePath: string,
  specs: readonly ScopeSpec[],
  inlineIds: readonly string[],
): readonly ParsedFile[] {
  return [makeParsedFile(filePath, specs, inlineIds)];
}

/** Capture-time inline marking + `populateOwners`-time scope-id resolution,
 *  in the same order the pipeline runs them. Spec lookup is a Map, not
 *  `Array.find`, so marking a deep chain stays linear in `specs`. */
function markInline(
  parsed: ParsedFile,
  specs: readonly ScopeSpec[],
  inlineIds: readonly string[],
): void {
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const id of inlineIds) {
    const spec = byId.get(id);
    if (spec === undefined) throw new Error(`inline scope ${id} must exist`);
    markCppInlineNamespaceRange(parsed.filePath, range(spec.line));
  }
  populateCppInlineNamespaceScopes(parsed);
}

/** `namespace outer { <ownDefs> inline namespace v1 { <inlineDefs> } }` */
function outerWithInlineChild(
  filePath: string,
  ownDefs: readonly SymbolDefinition[],
  inlineDefs: readonly SymbolDefinition[],
): readonly ParsedFile[] {
  return makeParsedFiles(
    filePath,
    [
      ns('sc:outer', null, [nsDef('n:outer', 'outer'), ...ownDefs], 1),
      ns('sc:v1', 'sc:outer', [nsDef('n:v1', 'outer.v1'), ...inlineDefs], 10),
    ],
    ['sc:v1'],
  );
}

/** `namespace n0 { inline namespace n1 { … inline namespace n<depth-1> {
 *   void leaf(); } … } }` — one function, declared in the innermost namespace,
 *  reachable by qualified lookup from every level above it. */
function inlineChain(filePath: string, depth: number): readonly ParsedFile[] {
  const specs: ScopeSpec[] = [];
  for (let d = 0; d < depth; d++) {
    const self = nsDef(`n:ns${d}`, `n${d}`);
    specs.push(
      ns(
        `sc:n${d}`,
        d === 0 ? null : `sc:n${d - 1}`,
        d === depth - 1 ? [self, fnDef('n:leaf', `n${d}.leaf`)] : [self],
        d * 2 + 1,
      ),
    );
  }
  // Every level below the outermost is `inline`, so the whole chain is one
  // transitively-visible run of namespaces.
  return makeParsedFiles(
    filePath,
    specs,
    specs.slice(1).map((s) => s.id),
  );
}

describe('C++ qualified-namespace member index (#2788)', () => {
  beforeEach(() => {
    clearCppInlineNamespaces();
  });

  it('resolves outer::foo through an inline-namespace child', () => {
    const files = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@v1', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@v1',
    });
  });

  it('returns undefined for an unknown namespace or member', () => {
    const files = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@v1', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('nope', 'foo', files, NO_SCOPES)).toBeUndefined();
    expect(resolveCppQualifiedNamespaceMember('outer', 'nope', files, NO_SCOPES)).toBeUndefined();
  });

  it('does not descend into a non-inline nested namespace', () => {
    const files = makeParsedFiles(
      'a.cpp',
      [
        ns('sc:outer', null, [nsDef('n:outer', 'outer')], 1),
        ns(
          'sc:nested',
          'sc:outer',
          [nsDef('n:nested', 'outer.nested'), fnDef('n:foo@nested', 'outer.nested.foo')],
          10,
        ),
      ],
      [],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBeUndefined();
    expect(resolveCppQualifiedNamespaceMember('nested', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@nested',
    });
  });

  it('reports same-name hits across two inline children as ambiguous (#1564)', () => {
    const files = makeParsedFiles(
      'a.cpp',
      [
        ns('sc:outer', null, [nsDef('n:outer', 'outer')], 1),
        ns('sc:v1', 'sc:outer', [nsDef('n:v1', 'outer.v1'), fnDef('n:foo@v1', 'outer.v1.foo')], 10),
        ns('sc:v2', 'sc:outer', [nsDef('n:v2', 'outer.v2'), fnDef('n:foo@v2', 'outer.v2.foo')], 20),
      ],
      ['sc:v1', 'sc:v2'],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBe('ambiguous');
  });

  it('resolves through an inline namespace that reuses its parent’s name', () => {
    // Pins the `visited` dedup: `namespace ns { inline namespace ns { … } }`
    // registers both scopes under receiver `ns`, and without dedup the one
    // `foo` is collected twice and degrades to 'ambiguous', dropping the CALLS
    // edge. Why node identity is the right dedup key: see
    // `gatherQualifiedNsMember` in `inline-namespaces.ts`.
    const files = makeParsedFiles(
      'a.cpp',
      [
        ns('sc:ns@outer', null, [nsDef('n:ns@outer', 'ns')], 1),
        ns(
          'sc:ns@inner',
          'sc:ns@outer',
          [nsDef('n:ns@inner', 'ns.ns'), fnDef('n:foo', 'ns.ns.foo')],
          10,
        ),
      ],
      ['sc:ns@inner'],
    );
    expect(resolveCppQualifiedNamespaceMember('ns', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo',
    });
  });

  it('finds both a namespace-owned member and its inline child member', () => {
    // Both levels are visible through the same receiver: `foo` is owned by
    // `outer` itself, `bar` only by its inline child `v1`. Distinct member
    // names per level on purpose — two same-named candidates with no call-site
    // info collapse to 'ambiguous', which would assert nothing about either.
    const files = outerWithInlineChild(
      'a.cpp',
      [fnDef('n:foo@outer', 'outer.foo')],
      [fnDef('n:bar@v1', 'outer.v1.bar')],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@outer',
    });
    expect(resolveCppQualifiedNamespaceMember('outer', 'bar', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:bar@v1',
    });
  });

  it('resolves through a 20,000-deep inline chain without exhausting the stack', () => {
    // Pins that a deep chain neither overflows the stack nor blows the heap —
    // the two failure modes a recursive build and an eager member table had.
    // Why an uncaught throw here aborts the whole `analyze`: see
    // `QualifiedNsMemberIndex` in `inline-namespaces.ts`. 20,000 is ~2.5x the
    // depth that overflowed in this same runner, for margin over per-platform
    // stack sizes.
    const files = inlineChain('deep.cpp', 20_000);
    // From the outermost namespace: the full chain is one transitive walk.
    expect(resolveCppQualifiedNamespaceMember('n0', 'leaf', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:leaf',
    });
    // Every inline namespace is a legal qualified receiver of its own, so
    // mid-chain and innermost receivers must resolve too.
    expect(resolveCppQualifiedNamespaceMember('n10000', 'leaf', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:leaf',
    });
    expect(resolveCppQualifiedNamespaceMember('n19999', 'leaf', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:leaf',
    });
    // A miss down the same chain stays a miss rather than becoming a throw.
    expect(resolveCppQualifiedNamespaceMember('n0', 'nosuch', files, NO_SCOPES)).toBeUndefined();
  });

  it('merges one namespace’s members across every file that reopens it', () => {
    // C++ namespaces are open: `namespace outer { void a(); }` in one file and
    // `namespace outer { void b(); }` in another are the SAME namespace, and
    // `outer::a()` / `outer::b()` must both resolve. The legacy scan re-derived
    // its hits from all of `parsedFiles` per call site; the index accumulates
    // once, so the per-receiver state has to outlive the file loop. Distinct
    // scope ids per file, as the real pipeline mints them.
    const files: readonly ParsedFile[] = [
      makeParsedFile(
        'a.cpp',
        [ns('sc:outer@a', null, [nsDef('n:outer@a', 'outer'), fnDef('n:a', 'outer.a')], 1)],
        [],
      ),
      makeParsedFile(
        'b.cpp',
        [ns('sc:outer@b', null, [nsDef('n:outer@b', 'outer'), fnDef('n:b', 'outer.b')], 1)],
        [],
      ),
    ];
    expect(resolveCppQualifiedNamespaceMember('outer', 'a', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:a',
    });
    expect(resolveCppQualifiedNamespaceMember('outer', 'b', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:b',
    });
  });

  it('does not serve one parsedFiles array’s index to another', () => {
    const first = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@a', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', first, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@a',
    });
    const second = outerWithInlineChild('b.cpp', [], [fnDef('n:foo@b', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', second, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@b',
    });
  });

  it('rebuilds after clearCppInlineNamespaces even when parsedFiles is reused', () => {
    // Pass 1: `v1` is inline, so `outer::foo` reaches through it.
    const specs: readonly ScopeSpec[] = [
      ns('sc:outer', null, [nsDef('n:outer', 'outer')], 1),
      ns('sc:v1', 'sc:outer', [nsDef('n:v1', 'outer.v1'), fnDef('n:foo@v1', 'outer.v1.foo')], 10),
    ];
    const files = makeParsedFiles('a.cpp', specs, ['sc:v1']);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@v1',
    });

    // Pass 2: SAME `parsedFiles` reference (so identity alone would serve the
    // cached index), but `v1` is no longer inline. Without the index reset in
    // `clearCppInlineNamespaces` the stale pass-1 hit survives.
    clearCppInlineNamespaces();
    markInline(files[0], specs, []);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBeUndefined();
  });
});
