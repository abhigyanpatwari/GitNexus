/**
 * U6 (#2227 tri-review-2, R4) — per-language anchor-alignment guard.
 *
 * The resolved-callee-id join (`BasicBlock.calleeIds`) relies on ONE invariant:
 * the position the CFG harvester stamps on each call/new site (`SiteRecord.at =
 * [1-based line, 0-based col]`) must equal the position the live scope query
 * stamps on the matching `@reference.call.*` capture (`ReferenceSite.atRange =
 * { startLine (1-based), startCol (0-based) }`). The Phase-4 emit joins resolved
 * callee ids onto blocks by EXACT position (U3), so if a scope query's anchor
 * node ever drifts for a language, `calleeIds` silently empties for that
 * language — and today nothing fails: the alignment is asserted only by the
 * hardcoded `at` literals in `harvest.test.ts` and the commit-message claims.
 *
 * This standing test drives BOTH sides on the SAME source, in-process, per
 * language, and asserts byte-equality. It does NOT re-implement the private
 * broadest-span `anchorCaptureFor` (KTD3): the exported `extractParsedFile`
 * already returns the computed `atRange`, and the exported `makeCfgHarness` +
 * `allSites` already return the harvested `site.at`.
 *
 * Join direction that matters: every harvested call/new site that carries an
 * `at` (i.e. is id-joinable) must have a corresponding real `@reference.call`
 * anchor in the scope set for that file. The scope side may legitimately
 * produce extra refs the harvester doesn't (or vice-versa for member-reads with
 * no `at`); we only assert the harvest→scope direction over sites with an `at`.
 *
 * Coverage: the 6 newly-harvested languages (Python, Dart, Kotlin, Ruby, Rust,
 * Swift), each with ≥3 representative call shapes INCLUDING its language-specific
 * risk case — most notably Dart, whose member-call anchor is the METHOD-NAME
 * node (unique among the 12), and Rust's struct-literal constructor (U4).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

import { makeCfgHarness, allSites } from '../../helpers/cfg-harness.js';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import type { CfgVisitor, SiteRecord } from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';

import { createPythonCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/python.js';
import { createDartCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/dart.js';
import { createKotlinCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/kotlin.js';
import { createRubyCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/ruby.js';
import { createRustCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/rust.js';
import { createSwiftCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/swift.js';

import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import { dartProvider } from '../../../src/core/ingestion/languages/dart.js';
import { kotlinProvider } from '../../../src/core/ingestion/languages/kotlin.js';
import { rubyProvider } from '../../../src/core/ingestion/languages/ruby.js';
import { rustProvider } from '../../../src/core/ingestion/languages/rust.js';
import { swiftProvider } from '../../../src/core/ingestion/languages/swift.js';

const require = createRequire(import.meta.url);

/** A tree-sitter grammar, typed as the harness expects it. */
type Grammar = Parameters<typeof makeCfgHarness>[0];

/** A `[1-based line, 0-based col]` anchor — the shared base of both sides. */
type Anchor = readonly [number, number];

/** One harvested call/new site that carries an `at` (id-joinable). */
interface HarvestSite {
  readonly at: Anchor;
  readonly kind: 'call' | 'new';
  readonly callee: string | undefined;
}

/** One scope-query call reference (kind 'call', incl. callForm constructor). */
interface ScopeRef {
  readonly at: Anchor;
  readonly name: string;
  readonly callForm: string | undefined;
}

/**
 * Collect every harvested call/new site that carries an `at`, across every
 * function CFG of `src`. Member-reads and any call/new without an `at` (e.g. a
 * call rooted on a call result that the resolver cannot id-join) are excluded —
 * they are not joinable, so they are out of this contract's scope.
 */
function harvestSites(
  grammar: Grammar,
  visitor: CfgVisitor<SyntaxNode>,
  filePath: string,
  src: string,
): HarvestSite[] {
  const harness = makeCfgHarness(grammar, visitor, filePath);
  const out: HarvestSite[] = [];
  for (const cfg of harness.cfgsOf(src)) {
    for (const s of allSites(cfg)) {
      const at = joinableAt(s);
      if (at !== undefined)
        out.push({ at, kind: s.kind === 'new' ? 'new' : 'call', callee: s.callee });
    }
  }
  return out;
}

/** The `at` anchor of `s` iff it is an id-joinable call/new site, else undefined. */
function joinableAt(s: SiteRecord): Anchor | undefined {
  const isCallOrNew = s.kind === 'call' || s.kind === 'new';
  const at = s.at;
  return isCallOrNew && at !== undefined ? [at[0], at[1]] : undefined;
}

/**
 * Run the real scope extractor and collect every call-kind reference site's
 * anchor. A Rust struct literal is `kind: 'call'` + `callForm: 'constructor'`,
 * so the `kind === 'call'` filter already includes it; we keep `callForm` on the
 * record purely for diagnostics.
 */
function scopeCallRefs(provider: LanguageProvider, filePath: string, src: string): ScopeRef[] {
  const pf = extractParsedFile(provider, src, filePath);
  const sites = pf?.referenceSites ?? [];
  return sites
    .filter((r) => r.kind === 'call')
    .map((r) => ({
      at: [r.atRange.startLine, r.atRange.startCol] as const,
      name: r.name,
      callForm: r.callForm,
    }));
}

const key = (a: Anchor): string => `${a[0]},${a[1]}`;

interface LangCase {
  readonly name: string;
  readonly grammar: Grammar;
  readonly visitor: CfgVisitor<SyntaxNode>;
  readonly provider: LanguageProvider;
  readonly filePath: string;
  /** Source with ≥3 call shapes, the last being the language-specific risk case. */
  readonly src: string;
  /** Minimum number of joinable harvested sites the fixture is expected to yield. */
  readonly minSites: number;
}

// Each fixture's final shape is the language-specific anchor risk:
//   Python — chained `a.b.c()` (anchor still on the call node, not the leaf).
//   Dart   — cascade `a..m()` + member `a.m()`: the anchor is the METHOD-NAME
//            node (unique among the 12 languages). The whole point of U6.
//   Kotlin — safe-call `a?.b()` (anchor on the whole call_expression).
//   Ruby   — paren-less command `puts x` (anchor on the whole `call` node).
//   Rust   — `::` path `Foo::bar(x)` AND struct-literal `Point {}` (U4,
//            `callForm: 'constructor'`).
//   Swift  — trailing closure `xs.map { }` (anchor on the call_expression).
const LANGS: readonly LangCase[] = [
  {
    name: 'python',
    grammar: require('tree-sitter-python') as Grammar,
    visitor: createPythonCfgVisitor(),
    provider: pythonProvider,
    filePath: 'fixture.py',
    src: `def f(a, b):\n    foo(a)\n    obj.m(b)\n    a.b.c()\n`,
    minSites: 3,
  },
  {
    name: 'dart',
    grammar: requireVendoredGrammar('tree-sitter-dart') as Grammar,
    visitor: createDartCfgVisitor(),
    provider: dartProvider,
    filePath: 'fixture.dart',
    src: `void f(a, b) {\n  foo(a);\n  a.m(b);\n  a..n();\n}\n`,
    minSites: 3,
  },
  {
    name: 'kotlin',
    grammar: requireVendoredGrammar('tree-sitter-kotlin') as Grammar,
    visitor: createKotlinCfgVisitor(),
    provider: kotlinProvider,
    filePath: 'fixture.kt',
    src: `fun f(a: Foo, b: Int) {\n    foo(b)\n    a.m(b)\n    a?.n(b)\n}\n`,
    minSites: 3,
  },
  {
    name: 'ruby',
    grammar: require('tree-sitter-ruby') as Grammar,
    visitor: createRubyCfgVisitor(),
    provider: rubyProvider,
    filePath: 'fixture.rb',
    src: `def f(a, x)\n  foo(x)\n  a.m(x)\n  puts x\nend\n`,
    minSites: 3,
  },
  {
    name: 'rust',
    grammar: require('tree-sitter-rust') as Grammar,
    visitor: createRustCfgVisitor(),
    provider: rustProvider,
    filePath: 'fixture.rs',
    src: `fn f(a: A, x: i32) {\n    foo(x);\n    a.m(x);\n    Foo::bar(x);\n    let p = Point { x: 1 };\n}\n`,
    minSites: 4,
  },
  {
    name: 'swift',
    grammar: requireVendoredGrammar('tree-sitter-swift') as Grammar,
    visitor: createSwiftCfgVisitor(),
    provider: swiftProvider,
    filePath: 'fixture.swift',
    src: `func f(a: Foo, xs: [Int]) {\n    foo(a)\n    a.m()\n    xs.map { x in x }\n}\n`,
    minSites: 3,
  },
];

describe('CFG harvester ↔ scope-query anchor alignment (U6/R4)', () => {
  for (const lang of LANGS) {
    describe(lang.name, () => {
      const harvest = harvestSites(lang.grammar, lang.visitor, lang.filePath, lang.src);
      const scope = scopeCallRefs(lang.provider, lang.filePath, lang.src);
      const scopeKeys = new Set(scope.map((r) => key(r.at)));

      it('the fixture yields the expected number of joinable harvested sites', () => {
        // A guard against a vacuous pass: if the harvester silently stopped
        // producing sites for this language, `arrayContaining([])` below would
        // trivially hold. Pin the floor so the alignment assertion has teeth.
        expect(harvest.length).toBeGreaterThanOrEqual(lang.minSites);
      });

      it('every harvested call/new anchor equals a real @reference.call anchor', () => {
        // The id-join lands iff each harvested `site.at` is also a scope-query
        // call anchor. Compare the harvest anchors against the scope anchor set:
        // a drift in either anchor node fails loudly with the offending position.
        const harvestKeys = harvest.map((h) => key(h.at)).sort();
        const presentInScope = harvest
          .filter((h) => scopeKeys.has(key(h.at)))
          .map((h) => key(h.at))
          .sort();
        // `toEqual` (not `arrayContaining`) so an extra harvested anchor that the
        // scope query lacks fails — both lists must be identical.
        expect(presentInScope).toEqual(harvestKeys);
      });

      it('reports each harvested site with its matched scope ref (diagnostic lock)', () => {
        // A second, shape-explicit assertion: each joinable harvest site maps to
        // a scope ref AT THE SAME ANCHOR. Builds the joined pairs unconditionally
        // (no `if`-guard around an expect) and asserts the full set, so a
        // mismatch surfaces the language, the callee, and both positions.
        const matched = harvest.map((h) => {
          const ref = scope.find((r) => key(r.at) === key(h.at));
          return {
            harvestAt: key(h.at),
            kind: h.kind,
            callee: h.callee,
            scopeAt: ref === undefined ? 'NO-SCOPE-ANCHOR' : key(ref.at),
          };
        });
        // Every entry's scopeAt must equal its harvestAt — none may be the
        // NO-SCOPE-ANCHOR sentinel.
        expect(matched.map((m) => m.scopeAt)).toEqual(matched.map((m) => m.harvestAt));
      });
    });
  }

  it('Dart member + cascade calls anchor on the METHOD-NAME node (the unique case)', () => {
    // Dart is the ONLY language whose member-call anchor is the method-name
    // identifier rather than the whole call / receiver. This pins that the
    // harvester and scope query agree on the method-name column specifically
    // (col 4 for `a.m`, col 5 for `a..n`), not merely "some shared position".
    const dart = LANGS.find((l) => l.name === 'dart')!;
    const harvest = harvestSites(dart.grammar, dart.visitor, dart.filePath, dart.src);
    const scope = scopeCallRefs(dart.provider, dart.filePath, dart.src);
    // member call `a.m(b)` on line 3 anchors on the method name `m` (col 4).
    const memberHarvest = harvest.find((h) => h.at[0] === 3)!;
    const memberScope = scope.find((r) => r.at[0] === 3)!;
    expect(memberHarvest.at).toEqual([3, 4]);
    expect([memberScope.at[0], memberScope.at[1]]).toEqual([3, 4]);
    expect(memberScope.name).toBe('m');
    // cascade call `a..n()` on line 4 anchors on the method name `n` (col 5).
    const cascadeHarvest = harvest.find((h) => h.at[0] === 4)!;
    const cascadeScope = scope.find((r) => r.at[0] === 4)!;
    expect(cascadeHarvest.at).toEqual([4, 5]);
    expect([cascadeScope.at[0], cascadeScope.at[1]]).toEqual([4, 5]);
    expect(cascadeScope.name).toBe('n');
  });

  it('Rust struct-literal constructor anchor aligns (U4 → @reference.call.constructor)', () => {
    // The struct literal `Point { x: 1 }` is a `kind: 'new'` harvest site; the
    // scope query tags it `kind: 'call'` + `callForm: 'constructor'`. Both must
    // anchor on the struct_expression start so the resolved constructor id joins.
    const rust = LANGS.find((l) => l.name === 'rust')!;
    const harvest = harvestSites(rust.grammar, rust.visitor, rust.filePath, rust.src);
    const scope = scopeCallRefs(rust.provider, rust.filePath, rust.src);
    const structHarvest = harvest.find((h) => h.kind === 'new')!;
    const structScope = scope.find((r) => r.callForm === 'constructor')!;
    expect(structHarvest.callee).toBe('Point');
    expect([structScope.at[0], structScope.at[1]]).toEqual([
      structHarvest.at[0],
      structHarvest.at[1],
    ]);
    expect(structScope.name).toBe('Point');
  });
});
