/**
 * Integration tests for heritage extractor wiring via real tree-sitter output.
 *
 * Complements test/unit/heritage-extraction.test.ts, which exercises the
 * configs and factory against mocked AST nodes. These tests drive the same
 * extractors against **real** tree-sitter parses so that a drift between
 * the per-language tree-sitter queries and the extractor configs would be
 * caught here even if mocked unit tests keep passing.
 *
 * Context: PR #890 review follow-up. See
 * docs/plans/2026-04-16-005-refactor-pr890-review-followups-plan.md Unit 3a.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import type { CaptureMap } from '../../src/core/ingestion/language-provider.js';
import { rubyHeritageConfig } from '../../src/core/ingestion/heritage-extractors/configs/ruby.js';

let parser: Parser;

beforeAll(async () => {
  parser = await loadParser();
});

/** Run the provider's tree-sitter queries over `code` and yield per-match capture maps. */
function runQueries(code: string, lang: SupportedLanguages): CaptureMap[] {
  const tree = parser.parse(code);
  const provider = getProvider(lang);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
  const matches = query.matches(tree.rootNode);

  return matches.map((match) => {
    const captureMap: Record<string, any> = {};
    for (const capture of match.captures) {
      captureMap[capture.name] = capture.node;
    }
    return captureMap as unknown as CaptureMap;
  });
}

/** Parse `code` and return the first AST node whose type matches `nodeType`. */
function findFirstNode(code: string, nodeType: string): any | null {
  const tree = parser.parse(code);
  const stack: any[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === nodeType) return node;
    for (let i = node.childCount - 1; i >= 0; i--) {
      stack.push(node.child(i));
    }
  }
  return null;
}

// ─── Ruby extractFromCall — real AST ─────────────────────────────────────────

describe('Ruby heritage extractFromCall (real tree-sitter AST)', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Ruby);
  });

  const extract = rubyHeritageConfig.callBasedHeritage!.extract;

  it('3a-1: class Foo; include Bar; end → single include entry', () => {
    const code = `class Foo\n  include Bar\nend\n`;
    const callNode = findFirstNode(code, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('include', callNode, 'foo.rb');
    expect(result).toEqual([{ className: 'Foo', parentName: 'Bar', kind: 'include' }]);
  });

  it('3a-2: include A, B, C produces three entries, one per constant arg', () => {
    const code = `class Multi\n  include A, B, C\nend\n`;
    const callNode = findFirstNode(code, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('include', callNode, 'multi.rb');
    expect(result).toEqual([
      { className: 'Multi', parentName: 'A', kind: 'include' },
      { className: 'Multi', parentName: 'B', kind: 'include' },
      { className: 'Multi', parentName: 'C', kind: 'include' },
    ]);
  });

  it('3a-3: extend ActiveSupport::Concern (scope_resolution arg)', () => {
    const code = `class Post\n  extend ActiveSupport::Concern\nend\n`;
    const callNode = findFirstNode(code, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('extend', callNode, 'post.rb');
    expect(result).toEqual([
      { className: 'Post', parentName: 'ActiveSupport::Concern', kind: 'extend' },
    ]);
  });

  it('3a-4: nested module/class resolves to the nearest class, not the module', () => {
    const code = `module Outer\n  class Inner\n    include X\n  end\nend\n`;
    const callNode = findFirstNode(code, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('include', callNode, 'nested.rb');
    expect(result).toEqual([{ className: 'Inner', parentName: 'X', kind: 'include' }]);
  });

  it('3a-5: top-level include with no enclosing class returns []', () => {
    const code = `include Foo\n`;
    // NOTE: `include Foo` at top level may not produce a `call` node in tree-sitter-ruby;
    // it often lowers to an `identifier` body_statement. Construct a realistic top-level
    // call (`Kernel.include Foo`) to exercise the no-enclosing-class branch.
    const fallback = `Kernel.include(Foo)\n`;
    const callNode = findFirstNode(fallback, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('include', callNode, 'top.rb');
    expect(result).toEqual([]);
  });

  it('prepend inside a module uses the module as enclosingClass', () => {
    const code = `module AppHelper\n  prepend Logged\nend\n`;
    const callNode = findFirstNode(code, 'call');
    expect(callNode).not.toBeNull();

    const result = extract('prepend', callNode, 'helper.rb');
    expect(result).toEqual([{ className: 'AppHelper', parentName: 'Logged', kind: 'prepend' }]);
  });
});

// ─── TypeScript heritage.extract — real AST + real query captures ────────────

describe('TypeScript heritage extract (real tree-sitter captures)', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.TypeScript);
  });

  it('3a-6: class Child extends Parent {} produces one extends entry', () => {
    const code = `class Child extends Parent {}\n`;
    const captureMaps = runQueries(code, SupportedLanguages.TypeScript);
    const heritageMatches = captureMaps.filter((m) => (m as any)['heritage.class']);
    expect(heritageMatches.length).toBeGreaterThan(0);

    const provider = getProvider(SupportedLanguages.TypeScript);
    const extractor = provider.heritageExtractor!;
    const items = extractor.extract(heritageMatches[0], {
      filePath: 'child.ts',
      language: SupportedLanguages.TypeScript,
    });

    expect(items).toEqual([{ className: 'Child', parentName: 'Parent', kind: 'extends' }]);
  });

  it('3a-7: class Child extends Parent implements IFoo {} yields extends + implements', () => {
    const code = `interface IFoo {}\nclass Parent {}\nclass Child extends Parent implements IFoo {}\n`;
    const captureMaps = runQueries(code, SupportedLanguages.TypeScript);
    const heritageMatches = captureMaps.filter(
      (m) =>
        (m as any)['heritage.class'] &&
        ((m as any)['heritage.extends'] || (m as any)['heritage.implements']),
    );
    expect(heritageMatches.length).toBeGreaterThan(0);

    const provider = getProvider(SupportedLanguages.TypeScript);
    const extractor = provider.heritageExtractor!;

    const kinds = new Set<string>();
    const parents = new Set<string>();
    for (const cm of heritageMatches) {
      const items = extractor.extract(cm, {
        filePath: 'child.ts',
        language: SupportedLanguages.TypeScript,
      });
      for (const item of items) {
        expect(item.className).toBe('Child');
        kinds.add(item.kind);
        parents.add(item.parentName);
      }
    }

    expect(kinds).toContain('extends');
    expect(kinds).toContain('implements');
    expect(parents).toContain('Parent');
    expect(parents).toContain('IFoo');
  });
});
