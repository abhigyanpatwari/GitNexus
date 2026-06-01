/**
 * Integration tests for the heritage supertype-alternation fix.
 *
 * Each case parses a small real source snippet with the per-language grammar,
 * runs the provider's *live* treeSitterQueries (the same bank consumed by
 * heritage-processor.ts and parse-worker.ts), feeds the resulting capture maps
 * through provider.heritageExtractor.extract, and asserts the supertype name
 * the extractor would hand to resolution. This guards the qualified / generic /
 * scoped / interface supertype shapes that previously matched only the bare
 * (type_identifier) and were silently dropped.
 *
 * It also includes a query-compile guard: every supported language's full
 * treeSitterQueries MUST compile, because heritage-processor.ts catches a
 * query-compile error and skips the file, dropping ALL heritage for it.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import {
  createParserForLanguage,
  getLanguageGrammar,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import type { CaptureMap } from '../../src/core/ingestion/language-provider.js';
import type { HeritageInfo } from '../../src/core/ingestion/heritage-types.js';

/**
 * Parse `code` with `lang`'s grammar, run the provider's live treeSitterQueries,
 * and return every heritage item the extractor emits across all matches.
 */
async function extractHeritage(
  code: string,
  lang: SupportedLanguages,
  filePath: string,
): Promise<HeritageInfo[]> {
  const parser = await createParserForLanguage(lang, filePath);
  const provider = getProvider(lang);
  const tree = parser.parse(code);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
  const matches = query.matches(tree.rootNode);
  const extractor = provider.heritageExtractor!;

  const out: HeritageInfo[] = [];
  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    for (const capture of match.captures) captureMap[capture.name] = capture.node;
    if (!(captureMap as CaptureMap)['heritage.class']) continue;
    out.push(
      ...extractor.extract(captureMap as unknown as CaptureMap, { filePath, language: lang }),
    );
  }
  return out;
}

/** Set of `${className}->${parentName}:${kind}` keys for order-independent asserts. */
function keys(items: HeritageInfo[]): Set<string> {
  return new Set(items.map((i) => `${i.className}->${i.parentName}:${i.kind}`));
}

// ─── Query-compile guard ─────────────────────────────────────────────────────

describe('heritage query-compile guard', () => {
  // Every tree-sitter-backed language. A malformed heritage block would make the
  // whole bank fail to compile and silently drop heritage for the language.
  const languages: SupportedLanguages[] = [
    SupportedLanguages.TypeScript,
    SupportedLanguages.JavaScript,
    SupportedLanguages.Python,
    SupportedLanguages.Java,
    SupportedLanguages.Go,
    SupportedLanguages.Rust,
    SupportedLanguages.CSharp,
    SupportedLanguages.C,
    SupportedLanguages.CPlusPlus,
    SupportedLanguages.PHP,
    SupportedLanguages.Ruby,
    SupportedLanguages.Swift,
    SupportedLanguages.Dart,
    SupportedLanguages.Kotlin,
  ];

  for (const lang of languages) {
    it(`${lang}: provider.treeSitterQueries compiles`, () => {
      let grammar: unknown;
      try {
        grammar = getLanguageGrammar(lang);
      } catch {
        // Optional grammars (e.g. Kotlin) may be unavailable in some installs.
        return;
      }
      const provider = getProvider(lang);
      expect(() => new Parser.Query(grammar as any, provider.treeSitterQueries)).not.toThrow();
    });
  }
});

// ─── Java ────────────────────────────────────────────────────────────────────

describe('Java heritage shapes', () => {
  it('generic + qualified extends and qualified/bare implements', async () => {
    const code = 'class A extends pkg.Base<T> implements pkg.IFoo, Bar {}';
    const items = await extractHeritage(code, SupportedLanguages.Java, 'A.java');
    const k = keys(items);
    expect(k.has('A->Base:extends')).toBe(true);
    expect(k.has('A->IFoo:implements')).toBe(true);
    expect(k.has('A->Bar:implements')).toBe(true);
  });

  it('interface extends interface(s)', async () => {
    const code = 'interface IA extends IB, pkg.IC<T> {}';
    const items = await extractHeritage(code, SupportedLanguages.Java, 'IA.java');
    const k = keys(items);
    expect(k.has('IA->IB:implements')).toBe(true);
    expect(k.has('IA->IC:implements')).toBe(true);
  });
});

// ─── C# ───────────────────────────────────────────────────────────────────────

describe('C# heritage shapes', () => {
  it('class qualified + generic base entries', async () => {
    const code = 'class A : pkg.Base, IFoo<T>, ns.IBar {}';
    const items = await extractHeritage(code, SupportedLanguages.CSharp, 'A.cs');
    const k = keys(items);
    expect(k.has('A->Base:extends')).toBe(true);
    expect(k.has('A->IFoo:extends')).toBe(true);
    expect(k.has('A->IBar:extends')).toBe(true);
  });

  it('record primary-constructor base', async () => {
    const code = 'record R(int X) : pkg.Base(X), IFoo {}';
    const items = await extractHeritage(code, SupportedLanguages.CSharp, 'R.cs');
    const k = keys(items);
    expect(k.has('R->Base:extends')).toBe(true);
    expect(k.has('R->IFoo:extends')).toBe(true);
  });

  it('struct base list', async () => {
    const code = 'struct S : IFoo, ns.IBar {}';
    const items = await extractHeritage(code, SupportedLanguages.CSharp, 'S.cs');
    const k = keys(items);
    expect(k.has('S->IFoo:extends')).toBe(true);
    expect(k.has('S->IBar:extends')).toBe(true);
  });

  // Alias-qualified bases. Verified against tree-sitter-c-sharp node-types.json
  // + a live parse of this exact source:
  //   - `global::System.IDisposable` (dotted) parses as a `qualified_name`
  //     whose qualifier is an `alias_qualified_name` (already covered).
  //   - `MyAlias::Foo` (bare, no dotted suffix) parses as a bare
  //     `alias_qualified_name` base_list entry — previously dropped because the
  //     descriptor lacked that shape. Both collapse to the simple name.
  it('alias-qualified bases: global:: (dotted) and bare alias-qualified', async () => {
    const code =
      'extern alias MyAlias;\nclass A : System.Exception, global::System.IDisposable, MyAlias::Foo {}';
    const items = await extractHeritage(code, SupportedLanguages.CSharp, 'A.cs');
    const k = keys(items);
    expect(k.has('A->Exception:extends')).toBe(true);
    expect(k.has('A->IDisposable:extends')).toBe(true);
    expect(k.has('A->Foo:extends')).toBe(true);
  });
});

// ─── TypeScript ────────────────────────────────────────────────────────────────

describe('TypeScript heritage shapes', () => {
  it('qualified class extends + interface implements', async () => {
    const code = 'class C extends ns.Base implements IFoo, ns.IBar {}';
    const items = await extractHeritage(code, SupportedLanguages.TypeScript, 'c.ts');
    const k = keys(items);
    expect(k.has('C->Base:extends')).toBe(true);
    expect(k.has('C->IFoo:implements')).toBe(true);
    expect(k.has('C->IBar:implements')).toBe(true);
  });

  it('interface extends interface(s)', async () => {
    const code = 'interface I extends A, ns.B<T> {}';
    const items = await extractHeritage(code, SupportedLanguages.TypeScript, 'i.ts');
    const k = keys(items);
    expect(k.has('I->A:implements')).toBe(true);
    expect(k.has('I->B:implements')).toBe(true);
  });
});

// ─── JavaScript ─────────────────────────────────────────────────────────────────

describe('JavaScript heritage shapes', () => {
  it('qualified member_expression extends', async () => {
    const code = 'class C extends ns.Base {}';
    const items = await extractHeritage(code, SupportedLanguages.JavaScript, 'c.js');
    expect(keys(items).has('C->Base:extends')).toBe(true);
  });
});

// ─── Python ──────────────────────────────────────────────────────────────────────

describe('Python heritage shapes', () => {
  it('bare, attribute and subscript superclasses', async () => {
    const code = 'class C(Base, models.Model, Generic[T]):\n    pass\n';
    const items = await extractHeritage(code, SupportedLanguages.Python, 'c.py');
    const k = keys(items);
    expect(k.has('C->Base:extends')).toBe(true);
    expect(k.has('C->Model:extends')).toBe(true);
    expect(k.has('C->Generic:extends')).toBe(true);
  });
});

// ─── Go ─────────────────────────────────────────────────────────────────────────

describe('Go heritage shapes', () => {
  it('qualified and generic struct embeds (named field skipped)', async () => {
    const code = 'type D struct {\n\tpkg.Base\n\tGen[T]\n\tAnimal\n\tName string\n}\n';
    const items = await extractHeritage(code, SupportedLanguages.Go, 'd.go');
    const k = keys(items);
    expect(k.has('D->Base:extends')).toBe(true);
    expect(k.has('D->Gen:extends')).toBe(true);
    expect(k.has('D->Animal:extends')).toBe(true);
    // Named field `Name string` must NOT become heritage.
    expect(k.has('D->string:extends')).toBe(false);
  });

  it('interface-in-interface embed', async () => {
    const code = 'type I interface {\n\tio.Reader\n\tOther\n}\n';
    const items = await extractHeritage(code, SupportedLanguages.Go, 'i.go');
    const k = keys(items);
    expect(k.has('I->Reader:extends')).toBe(true);
    expect(k.has('I->Other:extends')).toBe(true);
  });

  it('type-set union operands are NOT embeds (P3c)', async () => {
    // `int | float64` is a constraint type-set, not an embedded interface. A
    // multi-operand type_elem is skipped by goHeritageConfig.shouldSkipExtends.
    const code = 'type N interface {\n\tint | float64\n}\n';
    const items = await extractHeritage(code, SupportedLanguages.Go, 'n.go');
    const k = keys(items);
    expect(k.has('N->int:extends')).toBe(false);
    expect(k.has('N->float64:extends')).toBe(false);
  });
});

// ─── Rust ───────────────────────────────────────────────────────────────────────

describe('Rust heritage shapes', () => {
  it('scoped + generic trait impl', async () => {
    const code = 'impl ns::Trait<T> for Foo {}';
    const items = await extractHeritage(code, SupportedLanguages.Rust, 'lib.rs');
    expect(keys(items).has('Foo->Trait:trait-impl')).toBe(true);
  });
});

// ─── Ruby ───────────────────────────────────────────────────────────────────────

describe('Ruby heritage shapes', () => {
  it('scoped superclass and scoped class name', async () => {
    const code = 'class Foo::Bar < Base::Sup\nend\n';
    const items = await extractHeritage(code, SupportedLanguages.Ruby, 'foo.rb');
    expect(keys(items).has('Bar->Sup:extends')).toBe(true);
  });
});

// ─── C++ ────────────────────────────────────────────────────────────────────────

describe('C++ heritage shapes', () => {
  it('templated and qualified bases', async () => {
    const code = 'class D : public ns::Base<T>, Other {};';
    const items = await extractHeritage(code, SupportedLanguages.CPlusPlus, 'd.cpp');
    const k = keys(items);
    expect(k.has('D->Base:extends')).toBe(true);
    expect(k.has('D->Other:extends')).toBe(true);
  });
});

// ─── Kotlin (optional grammar) ────────────────────────────────────────────────────

const KOTLIN_AVAILABLE = (() => {
  try {
    getLanguageGrammar(SupportedLanguages.Kotlin);
    return true;
  } catch {
    return false;
  }
})();

// Visible skip (not a silent in-body `return`) so an absent optional grammar
// shows as `skipped` rather than green-washing the by-delegation regression.
(KOTLIN_AVAILABLE ? describe : describe.skip)('Kotlin heritage shapes', () => {
  // `explicit_delegation` (`Bar by <delegate>`) places the supertype user_type
  // FIRST and the delegate expression after `by`; the normalizer must pick the
  // leading user_type, never the trailing delegate. Every form resolves to Bar.
  it('bare-identifier delegate: `: Bar by baz`', async () => {
    const items = await extractHeritage(
      'class Foo : Bar by baz {}',
      SupportedLanguages.Kotlin,
      'Foo.kt',
    );
    const k = keys(items);
    expect(k.has('Foo->Bar:extends')).toBe(true);
    // The delegate property `baz` must NOT be recorded as the supertype (P2).
    expect(k.has('Foo->baz:extends')).toBe(false);
  });

  it('navigation delegate: `: Bar by holder.value`', async () => {
    const items = await extractHeritage(
      'class Foo : Bar by holder.value {}',
      SupportedLanguages.Kotlin,
      'Foo.kt',
    );
    expect(keys(items).has('Foo->Bar:extends')).toBe(true);
  });

  it('call delegate: `: Bar by makeBar()`', async () => {
    const items = await extractHeritage(
      'class Foo : Bar by makeBar() {}',
      SupportedLanguages.Kotlin,
      'Foo.kt',
    );
    expect(keys(items).has('Foo->Bar:extends')).toBe(true);
  });

  it('constructor invocation: `: Bar()`', async () => {
    const items = await extractHeritage(
      'class Foo : Bar() {}',
      SupportedLanguages.Kotlin,
      'Foo.kt',
    );
    expect(keys(items).has('Foo->Bar:extends')).toBe(true);
  });

  it('generic supertype with delegation: `: Bar<T> by baz`', async () => {
    const items = await extractHeritage(
      'class Foo : Bar<T> by baz {}',
      SupportedLanguages.Kotlin,
      'Foo.kt',
    );
    expect(keys(items).has('Foo->Bar:extends')).toBe(true);
  });
});

// ─── PHP ────────────────────────────────────────────────────────────────────────

describe('PHP heritage shapes', () => {
  // PHP qualified names collapse to the simple name (the V1 ctx.resolve simple-
  // name contract): `Models\BaseModel` -> `BaseModel`. The php_only grammar
  // parses source already in PHP mode (no `<?php` opener).
  it('qualified extends/implements collapse to the simple name', async () => {
    const code =
      'namespace App;\nclass A extends Models\\BaseModel implements Contracts\\Jsonable {}\n';
    const items = await extractHeritage(code, SupportedLanguages.PHP, 'A.php');
    const k = keys(items);
    expect(k.has('A->BaseModel:extends')).toBe(true);
    expect(k.has('A->Jsonable:implements')).toBe(true);
  });
});

// ─── Swift / Dart (vendored, optional) ──────────────────────────────────────────────

const SWIFT_AVAILABLE = (() => {
  try {
    getLanguageGrammar(SupportedLanguages.Swift);
    return true;
  } catch {
    return false;
  }
})();

(SWIFT_AVAILABLE ? describe : describe.skip)('Swift heritage shapes', () => {
  it('captures class supertype and protocol conformance', async () => {
    const items = await extractHeritage(
      'class A: BaseClass, SomeProtocol {}',
      SupportedLanguages.Swift,
      'A.swift',
    );
    const k = keys(items);
    expect(k.has('A->BaseClass:extends')).toBe(true);
    expect(k.has('A->SomeProtocol:extends')).toBe(true);
  });
});

const DART_AVAILABLE = (() => {
  try {
    getLanguageGrammar(SupportedLanguages.Dart);
    return true;
  } catch {
    return false;
  }
})();

(DART_AVAILABLE ? describe : describe.skip)('Dart heritage shapes', () => {
  it('captures extends / implements / with', async () => {
    // Dart clause order is fixed: extends, then with, then implements.
    const items = await extractHeritage(
      'class A extends Base with MixinM implements Foo {}',
      SupportedLanguages.Dart,
      'a.dart',
    );
    const k = keys(items);
    expect(k.has('A->Base:extends')).toBe(true);
    expect(k.has('A->Foo:implements')).toBe(true);
    expect(k.has('A->MixinM:trait-impl')).toBe(true);
  });
});
