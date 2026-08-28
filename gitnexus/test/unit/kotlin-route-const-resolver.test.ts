/**
 * Kotlin route-path constant resolution (the Kotlin binding of the #2391 core).
 *
 * Covers the four reference forms the Java binding already handles — qualified
 * access, fully-qualified name, single-name import, `+`-concatenation — plus the
 * places Kotlin genuinely differs from Java and therefore needs its own
 * behavior rather than a translation:
 *
 *   • `object` / `companion object` / top-level carriers, where Java has only
 *     `static final` on a type (a companion member is referenced through its
 *     ENCLOSING class, never through `Companion`);
 *   • no `String` type gate — Kotlin infers property types, so the initializer
 *     decides whether a constant is foldable;
 *   • a file name need not match the declaration it holds, so import resolution
 *     falls back to the package directory;
 *   • member imports are unmarked (`import a.b.C.F` is spelled exactly like a
 *     type import), so both readings are tried;
 *   • string templates (`"$base/orders"`) are refused rather than silently
 *     folded with the interpolation deleted.
 *
 * Every unresolvable case asserts `null` — an ambiguous import must never
 * produce a guessed path, because a wrong route is a false edge in the graph
 * while a missing one is only a missing fact.
 */

import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { MAX_FOLD_LENGTH } from '../../src/core/ingestion/route-extractors/constant-resolver.js';
import {
  extractKotlinModuleConstants,
  foldKotlinOperands,
  isKotlinConstantFile,
  parseKotlinConstOperands,
  resolveKotlinConstant,
  resolveKotlinImport,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/kotlin-const-resolver.js';
import { unquoteSpringLiteral } from '../../src/core/ingestion/route-extractors/spring-shared.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Optional grammar; the suite skips when its native binding is unavailable.
}

const parser = new Parser();
if (Kotlin) parser.setLanguage(Kotlin as Parser.Language);

const parse = (src: string): Parser.Tree => parser.parse(src);

/** Build a RepoConstants map from virtual files: { 'a/b/C.kt': source }. */
function repoOf(files: Record<string, string>): RepoConstants {
  const map = new Map();
  for (const [key, src] of Object.entries(files)) {
    map.set(key, extractKotlinModuleConstants(parse(src)));
  }
  return map;
}

/** The initializer expression of the first `property_declaration` in `src`. */
function firstInitializer(src: string): Parser.SyntaxNode {
  const property = parse(src).rootNode.descendantsOfType('property_declaration')[0];
  expect(property, 'expected a property_declaration').toBeDefined();
  const eq = property.children.findIndex((c) => c.type === '=');
  expect(eq, 'expected an initializer').toBeGreaterThan(-1);
  const init = property.children.slice(eq + 1).find((c) => c.isNamed);
  expect(init, 'expected an initializer expression').toBeDefined();
  return init as Parser.SyntaxNode;
}

const CONSTS_KEY = 'src/main/kotlin/com/example/app/api/ApiPaths.kt';
const CONTROLLER_KEY = 'src/main/kotlin/com/example/app/web/OrderController.kt';

const CONSTS_SRC = `package com.example.app.api

object ApiPaths {
    const val BASE = "/api/v1"
    const val ORDERS = BASE + "/orders"
    val LEGACY: String = "/legacy/orders"
}
`;

const describeKotlin = Kotlin ? describe : describe.skip;

describeKotlin('Kotlin route-path constant resolution', () => {
  describe('reference forms shared with the Java binding', () => {
    it('resolves a qualified reference through a type import', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('resolves a fully-qualified reference with no import at all', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

@RestController
class OrderController {
    @GetMapping(com.example.app.api.ApiPaths.ORDERS)
    fun list() {}
}
`,
      });
      expect(
        resolveKotlinConstant(CONTROLLER_KEY, 'com.example.app.api.ApiPaths.ORDERS', repo),
      ).toBe('/api/v1/orders');
    });

    it('resolves a single-name import of an object member', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths.ORDERS

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}
}
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('folds an inline `+`-concatenation at the annotation site', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @PostMapping(value = ApiPaths.BASE + "/orders/create")
    fun create() {}
}
`,
      });
      const operands = parseKotlinConstOperands(
        firstInitializer('val X = ApiPaths.BASE + "/orders/create"'),
      );
      if (operands === null) throw new Error('expected a foldable operand list');
      expect(operands).toEqual([
        { kind: 'ref', name: 'ApiPaths.BASE' },
        { kind: 'literal', value: '/orders/create' },
      ]);
      expect(foldKotlinOperands(CONTROLLER_KEY, operands, repo)).toBe('/api/v1/orders/create');
    });

    it('folds a constant defined by concatenating another constant', () => {
      // `ORDERS = BASE + "/orders"` inside the same object.
      const repo = repoOf({ [CONSTS_KEY]: CONSTS_SRC });
      expect(resolveKotlinConstant(CONSTS_KEY, 'ApiPaths.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('folds a chain of three or more `+` operands', () => {
      // tree-sitter-kotlin nests `A + B + C` left-associatively, so every
      // `additive_expression` has exactly two operands and the chain folds by
      // recursion. Pinned because the two-operand case cannot detect a
      // regression to a flat-node reading.
      const key = 'src/main/kotlin/com/example/app/api/Chained.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Chained {
    const val BASE = "/api"
    const val VERSION = "/v1"
    const val ORDERS = BASE + VERSION + "/orders"
    const val ORDER_ITEMS = BASE + VERSION + "/orders" + "/items"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Chained.ORDERS', repo)).toBe('/api/v1/orders');
      expect(resolveKotlinConstant(key, 'Chained.ORDER_ITEMS', repo)).toBe('/api/v1/orders/items');
    });

    it('rejects a `-` expression, which shares one node type with `+`', () => {
      // tree-sitter-kotlin gives `A + B` and `A - B` the same
      // `additive_expression` type, so only the presence of a `+` token
      // distinguishes a concatenation. Subtraction is not a string operation;
      // folding it as one would fabricate a path.
      const key = 'src/main/kotlin/com/example/app/api/Minus.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Minus {
    const val BASE = "/api"
    const val VERSION = "/v1"
    val BROKEN = BASE - VERSION
}
`,
      });
      expect(resolveKotlinConstant(key, 'Minus.BROKEN', repo)).toBeNull();
    });

    it('folds escapes to exactly what the literal path would produce', () => {
      const key = 'src/main/kotlin/com/example/app/api/Regexes.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Regexes {
    const val USER = "/user/{id:\\\\d+}"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Regexes.USER', repo)).toBe(
        unquoteSpringLiteral('"/user/{id:\\\\d+}"'),
      );
    });
  });

  describe('ambiguity floors to skip, never to a guess', () => {
    it('returns null when two modules carry the same fully-qualified name', () => {
      const files = {
        'service-a/src/main/kotlin/com/example/app/api/ApiPaths.kt': CONSTS_SRC,
        'service-b/src/main/kotlin/com/example/app/api/ApiPaths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/legacy/orders"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      };
      const repo = repoOf(files);
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
      // Same verdict at the resolver layer the fold delegates to.
      expect(
        resolveKotlinImport(
          CONTROLLER_KEY,
          'com.example.app.api.ApiPaths',
          new Set(Object.keys(files)),
        ),
      ).toBeNull();
    });

    it('returns null when the package holds two constant files and no name matches', () => {
      // Kotlin lets a file be named anything, so resolution falls back to the
      // package directory — which only answers when exactly one candidate sits
      // there. Two do here, so the import cannot be pinned.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        'src/main/kotlin/com/example/app/api/More.kt': `package com.example.app.api

object MorePaths {
    const val ITEMS = "/api/v1/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });

    it('returns null for a wildcard import', () => {
      // `import com.example.app.api.*` binds no single name, so there is nothing
      // to key the fold on and no honest way to pick a package member.
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.*
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBeNull();
    });

    it('returns null for an unknown reference rather than an empty path', () => {
      const repo = repoOf({ [CONSTS_KEY]: CONSTS_SRC });
      expect(resolveKotlinConstant(CONSTS_KEY, 'ApiPaths.MISSING', repo)).toBeNull();
      expect(foldKotlinOperands(CONSTS_KEY, [{ kind: 'ref', name: 'MISSING' }], repo)).toBeNull();
    });

    it('folds to the empty string as a SUCCESS, not a skip', () => {
      // The counterpart of the test above, and the distinction it depends on:
      // `null` means "could not fold", `''` means "folded, and the answer is
      // empty". `const val ROOT = ""` is Spring's spelling for "the class prefix
      // itself", so collapsing it into null loses a route the literal
      // `@GetMapping("")` publishes from the same class. `resolveKotlinConstant`
      // already returned `''` here; `foldKotlinOperands` did not, which made the
      // two entry points disagree about the same constant.
      const key = 'src/main/kotlin/com/example/app/api/Root.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object ApiPaths {
    const val ROOT = ""
}
`,
      });
      expect(resolveKotlinConstant(key, 'ApiPaths.ROOT', repo)).toBe('');
      expect(foldKotlinOperands(key, [{ kind: 'ref', name: 'ApiPaths.ROOT' }], repo)).toBe('');
      expect(foldKotlinOperands(key, [{ kind: 'literal', value: '' }], repo)).toBe('');
    });

    it('terminates on a self-referential constant', () => {
      const key = 'src/main/kotlin/com/example/app/api/Cycle.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Cycle {
    val A = B + "/a"
    val B = A + "/b"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Cycle.A', repo)).toBeNull();
    });
  });

  describe('Kotlin-specific declaration forms', () => {
    it('reads a companion object member through its enclosing class', () => {
      const key = 'src/main/kotlin/com/example/app/api/OrderApi.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

class OrderApi {
    companion object {
        const val ORDERS = "/api/v1/orders"
    }
}
`,
      });
      // Kotlin source says `OrderApi.ORDERS`; `Companion` never appears.
      expect(resolveKotlinConstant(key, 'OrderApi.ORDERS', repo)).toBe('/api/v1/orders');
      expect(resolveKotlinConstant(key, 'Companion.ORDERS', repo)).toBeNull();
    });

    it('reads a top-level `const val` through a single-name import', () => {
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/TopLevel.kt': `package com.example.app.api

const val ORDERS = "/api/v1/orders"
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ORDERS
`,
      });
      // The declaration's file is named `TopLevel.kt`, so this only resolves via
      // the package-directory fallback tier.
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('reads an object whose file is not named after it', () => {
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Constants.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('un-aliases an aliased import', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths as Paths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'Paths.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('accepts a non-`const` `val` in an object but rejects `var`', () => {
      const key = 'src/main/kotlin/com/example/app/api/Mixed.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Mixed {
    val STABLE = "/api/v1/stable"
    var MUTABLE = "/api/v1/mutable"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Mixed.STABLE', repo)).toBe('/api/v1/stable');
      expect(resolveKotlinConstant(key, 'Mixed.MUTABLE', repo)).toBeNull();
    });

    it('rejects a computed property (custom getter or delegate)', () => {
      const key = 'src/main/kotlin/com/example/app/api/Computed.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Computed {
    val VIA_GETTER: String get() = "/api/v1/getter"
    val VIA_DELEGATE: String by lazy { "/api/v1/delegate" }
}
`,
      });
      expect(resolveKotlinConstant(key, 'Computed.VIA_GETTER', repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'Computed.VIA_DELEGATE', repo)).toBeNull();
    });

    it('does not harvest an instance property of a plain class', () => {
      // `val` in a class body is per-instance; `Holder.ORDERS` does not compile.
      const key = 'src/main/kotlin/com/example/app/api/Holder.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

class Holder {
    val ORDERS = "/api/v1/orders"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Holder.ORDERS', repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'ORDERS', repo)).toBeNull();
    });

    it('refuses a string template instead of dropping the interpolation', () => {
      // Joining the literal runs of `"$BASE/orders"` would publish `/orders` —
      // a path the application does not serve.
      const key = 'src/main/kotlin/com/example/app/api/Templated.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Templated {
    const val BASE = "/api/v1"
    val ORDERS = "\${BASE}/orders"
    val ITEMS = "$BASE/items"
}
`,
      });
      expect(resolveKotlinConstant(key, 'Templated.BASE', repo)).toBe('/api/v1');
      expect(resolveKotlinConstant(key, 'Templated.ORDERS', repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'Templated.ITEMS', repo)).toBeNull();
    });

    it('folds a single-line raw string, which Kotlin leaves byte-exact', () => {
      const key = 'src/main/kotlin/com/example/app/api/Raw.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Raw {
    const val ORDERS = """/api/v1/orders"""
}
`,
      });
      expect(resolveKotlinConstant(key, 'Raw.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('drops a constant whose initializer is not a string expression', () => {
      // Kotlin infers property types, so there is no `String` type node to gate
      // on — the initializer is what decides.
      const key = 'src/main/kotlin/com/example/app/api/NonString.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object NonString {
    const val PORT = 8080
    val COMPUTED = buildPath()
}
`,
      });
      expect(resolveKotlinConstant(key, 'NonString.PORT', repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'NonString.COMPUTED', repo)).toBeNull();
    });

    it('does not answer `Owner.NAME` with a same-named top-level constant', () => {
      // In Kotlin `Owner.NAME` means NAME is a member of the object/companion
      // `Owner`; a top-level `NAME` in the same file is a different declaration,
      // so matching it would fabricate a value. (The Java binding's bare-name
      // fallback is sound there only because the file name pins the class.)
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/ApiPaths.kt': `package com.example.app.api

const val ORDERS = "/top-level/orders"

object Unrelated {
    const val ITEMS = "/api/v1/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });
  });

  describe('the fold is bounded in output, depth and time', () => {
    /** `object Doubling { const val X<n> = <leaf>; val X<k> = X<k+1> + X<k+1> … }`. */
    const doublingChain = (levels: number, leaf: string): string => {
      const lines = [`    const val X${levels} = "${leaf}"`];
      for (let i = levels - 1; i >= 0; i--) lines.push(`    val X${i} = X${i + 1} + X${i + 1}`);
      return `package com.example.app.api\n\nobject Doubling {\n${lines.join('\n')}\n}\n`;
    };
    const DOUBLING_KEY = 'src/main/kotlin/com/example/app/api/Doubling.kt';

    it('folds a 30-level shared-descendant DAG instead of exploring 2^30 paths', () => {
      // Every intermediate value here is the EMPTY string, so MAX_FOLD_LENGTH
      // never fires and only the success memo keeps this from re-folding each
      // child once per reference — O(2^depth). The assertion is the explicit
      // timeout: a regression does not fail this test slowly, it fails it.
      const repo = repoOf({ [DOUBLING_KEY]: doublingChain(30, '') });
      expect(resolveKotlinConstant(DOUBLING_KEY, 'Doubling.X0', repo)).toBe('');
    }, 5_000);

    it('caps output at MAX_FOLD_LENGTH, which the depth cap cannot bound', () => {
      // Same shape with a one-character leaf: output doubles per level while
      // depth only increments, so 13 levels land exactly on MAX_FOLD_LENGTH and
      // 14 overrun it. Pinned from both sides — a chain deep enough to matter in
      // practice (30 levels, a gigabyte of string) is the same code path.
      const foldOf = (levels: number): string | null =>
        resolveKotlinConstant(
          DOUBLING_KEY,
          'Doubling.X0',
          repoOf({ [DOUBLING_KEY]: doublingChain(levels, 'a') }),
        );
      expect(foldOf(13)).toHaveLength(MAX_FOLD_LENGTH);
      expect(foldOf(14)).toBeNull();
    });

    /** `object Link { const val X<n> = "/end"; val X<k> = X<k+1> … }`. */
    const referenceChain = (links: number): string => {
      const lines = [`    const val X${links} = "/end"`];
      for (let i = links - 1; i >= 0; i--) lines.push(`    val X${i} = X${i + 1}`);
      return `package com.example.app.api\n\nobject Link {\n${lines.join('\n')}\n}\n`;
    };
    const LINK_KEY = 'src/main/kotlin/com/example/app/api/Link.kt';

    it('resolves a chain inside the cross-file depth cap but stops past it', () => {
      // Each link costs one level of `resolveWithState`, so a 30-link chain
      // resolves and a 40-link one runs into the cap. Asserted from both sides:
      // a bare `toBeNull()` would also pass if the fold had stopped working.
      expect(
        resolveKotlinConstant(LINK_KEY, 'Link.X0', repoOf({ [LINK_KEY]: referenceChain(30) })),
      ).toBe('/end');
      expect(
        resolveKotlinConstant(LINK_KEY, 'Link.X0', repoOf({ [LINK_KEY]: referenceChain(40) })),
      ).toBeNull();
    });

    it('caps operand parsing on a pathologically long `+` chain', () => {
      // `A + B + C` nests left-associatively, so an n-term concatenation is n-1
      // levels deep and a long enough one would recurse without the parse cap.
      const chainOf = (terms: number): string =>
        `val X = ${Array.from({ length: terms }, (_, i) => `"/${i}"`).join(' + ')}`;
      expect(parseKotlinConstOperands(firstInitializer(chainOf(60)))).toHaveLength(60);
      expect(parseKotlinConstOperands(firstInitializer(chainOf(80)))).toBeNull();
    });
  });

  describe('isKotlinConstantFile gate', () => {
    it('admits every shape the extractor harvests', () => {
      expect(isKotlinConstantFile(CONSTS_SRC)).toBe(true);
      expect(isKotlinConstantFile('const val ORDERS = "/api/v1/orders"')).toBe(true);
      expect(isKotlinConstantFile('object O { val ORDERS: String = "/api/v1/orders" }')).toBe(true);
      expect(
        isKotlinConstantFile('class C { companion object { const val O = "/api/v1/orders" } }'),
      ).toBe(true);
    });

    it('rejects a file with no constant carrier at all', () => {
      expect(
        isKotlinConstantFile(`package com.example.app.web

class OrderService {
    fun list(): List<String> = emptyList()
}
`),
      ).toBe(false);
    });
  });
});
