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
  buildKotlinConstantIndex,
  extractKotlinModuleConstants,
  foldKotlinOperands,
  isKotlinConstantFile,
  overlayKotlinConstantIndex,
  parseKotlinConstOperands,
  resolveKotlinConstant,
  resolveKotlinImport,
  resolveKotlinImportWithIndex,
  type ModuleConstants,
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

  describe('prepared constant index', () => {
    it('preserves fold results while narrowing lookup to the declared package', () => {
      const files: Record<string, string> = {
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      };
      for (let i = 0; i < 256; i++) {
        files[`src/main/kotlin/com/noise/p${i}/Noise.kt`] = `package com.noise.p${i}

object Noise${i} {
    const val PATH = "/noise/${i}"
}
`;
      }
      const repo = repoOf(files);
      const index = buildKotlinConstantIndex(repo);

      expect(index.constantKeys.size).toBe(257);
      expect(index.byPackage.get('com.example.app.api')?.files).toEqual([CONSTS_KEY]);
      expect(resolveKotlinImportWithIndex('com.example.app.api.ApiPaths', index)).toBe(CONSTS_KEY);
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo, 0, index)).toBe(
        resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo),
      );
    });

    it('reuses package projections for an import-only scan overlay', () => {
      const repo = repoOf({ [CONSTS_KEY]: CONSTS_SRC });
      const index = buildKotlinConstantIndex(repo);
      const controller = extractKotlinModuleConstants(
        parse(`package com.example.app.web

import com.example.app.api.ApiPaths
`),
      );
      const overlaid = overlayKotlinConstantIndex(index, CONTROLLER_KEY, controller);

      expect(overlaid.repo.get(CONTROLLER_KEY)).toBe(controller);
      expect(overlaid.constantKeys).toBe(index.constantKeys);
      expect(overlaid.byPackage).toBe(index.byPackage);
      expect(resolveKotlinImportWithIndex('com.example.app.api.ApiPaths', overlaid)).toBe(
        CONSTS_KEY,
      );
      expect(
        resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', overlaid.repo, 0, overlaid),
      ).toBe('/api/v1/orders');
    });

    it('keeps duplicate declarations ambiguous after an overlay', () => {
      const repo = repoOf({ [CONSTS_KEY]: CONSTS_SRC });
      const index = buildKotlinConstantIndex(repo);
      const duplicateKey = 'src/test/kotlin/com/example/app/api/ApiPaths.kt';
      const duplicate = extractKotlinModuleConstants(
        parse(`package com.example.app.api

object ApiPaths {
    const val ORDERS = "/test-only"
}
`),
      );
      const overlaid = overlayKotlinConstantIndex(index, duplicateKey, duplicate);

      expect(overlaid.constantKeys.size).toBe(2);
      expect(resolveKotlinImportWithIndex('com.example.app.api.ApiPaths', overlaid)).toBeNull();
    });

    it('prefers an exact declared package over a nested path with the same FQN', () => {
      const parentKey = 'src/main/kotlin/com/example/app/Parent.kt';
      const childKey = 'src/main/kotlin/com/example/app/api/ApiPaths.kt';
      const repo = repoOf({
        [parentKey]: `package com.example.app

object api {
    object ApiPaths {
        const val ORDERS = "/wrong"
    }
}
`,
        [childKey]: `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      const index = buildKotlinConstantIndex(repo);

      expect(resolveKotlinImportWithIndex('com.example.app.api.ApiPaths', index)).toBe(childKey);
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo, 0, index)).toBe(
        '/right',
      );
      expect(
        resolveKotlinConstant(
          CONTROLLER_KEY,
          'com.example.app.api.ApiPaths.ORDERS',
          repo,
          0,
          index,
        ),
      ).toBe('/right');
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
      // Same verdict at the resolver layer the fold delegates to. It reads the
      // candidates' DECLARED packages, so it takes the repo map as well as the
      // key set.
      expect(
        resolveKotlinImport(
          CONTROLLER_KEY,
          'com.example.app.api.ApiPaths',
          new Set(Object.keys(files)),
          repo,
        ),
      ).toBeNull();
    });

    it('keeps an unfoldable duplicate in the fully-qualified-name candidate set', () => {
      const repo = repoOf({
        'src/main/kotlin/generated/RoutePaths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = ("/production")
}
`,
        'src/test/kotlin/com/example/app/api/ApiPaths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/test-only"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });

    it('uses the unique declaring file before package filename fallbacks', () => {
      // An unrelated constant file in the same package is not ambiguity when
      // exactly one candidate declares the imported type.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        'src/main/kotlin/com/example/app/api/More.kt': `package com.example.app.api

object MorePaths {
    const val ITEMS = ("/api/v1/items")
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/api/v1/orders');
    });

    it('resolves top-level declarations through a package-star import', () => {
      const repo = repoOf({
        [CONSTS_KEY]: `package com.example.app.api

const val ORDERS = "/api/v1/orders"
object ApiPaths {
    const val ITEMS = "/api/v1/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.*
`,
      });
      const controller = repo.get(CONTROLLER_KEY);
      expect(controller?.wildcardImports).toEqual(['com.example.app.api']);
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/api/v1/orders');
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ITEMS', repo)).toBe('/api/v1/items');
    });

    it('does not treat an object-star import as a package-star import', () => {
      const repo = repoOf({
        [CONSTS_KEY]: CONSTS_SRC,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.ApiPaths.*
`,
      });
      // Kotlin forbids star imports from objects. The resolver searches exact
      // declared packages only, so it cannot fabricate this invalid binding.
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBeNull();
    });

    it('keeps package-star collisions unresolved and lets explicit imports win', () => {
      const repo = repoOf({
        'src/one/Routes.kt': `package one
const val ROUTE = "/one"
`,
        'src/two/Routes.kt': `package two
const val ROUTE = "/two"
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import one.*
import two.*
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ROUTE', repo)).toBeNull();

      const explicitRepo = repoOf({
        'src/one/Routes.kt': `package one
const val ROUTE = "/one"
`,
        'src/two/Routes.kt': `package two
const val ROUTE = "/two"
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import one.*
import two.*
import two.ROUTE
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ROUTE', explicitRepo)).toBe('/two');
    });

    it('lets local non-constant declarations shadow package-star imports', () => {
      const repo = repoOf({
        [CONSTS_KEY]: `package com.example.app.api

const val ROUTE = "/imported"
object ApiPaths {
    const val ITEMS = "/imported/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.*

var ROUTE = runtimeRoute()
class ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ROUTE', repo)).toBeNull();
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ITEMS', repo)).toBeNull();
    });

    it('resolves same-package sibling declarations before package-star imports', () => {
      const repo = repoOf({
        'src/web/Local.kt': `package com.example.app.web
const val ROUTE = "/local"
object ApiPaths {
    const val ITEMS = "/local/items"
}
`,
        [CONSTS_KEY]: `package com.example.app.api
const val ROUTE = "/imported"
object ApiPaths {
    const val ITEMS = "/imported/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web
import com.example.app.api.*
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ROUTE', repo)).toBe('/local');
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ITEMS', repo)).toBe('/local/items');
    });

    it('floors a same-package sibling type before package-star imports', () => {
      const repo = repoOf({
        'src/web/Local.kt': `package com.example.app.web
class ApiPaths
`,
        [CONSTS_KEY]: `package com.example.app.api
object ApiPaths {
    const val ITEMS = "/imported/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web
import com.example.app.api.*
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ITEMS', repo)).toBeNull();
    });

    it('floors ambiguous same-package sibling declarations before package stars', () => {
      const repo = repoOf({
        'src/web/One.kt': `package com.example.app.web
const val ROUTE = "/one"
`,
        'src/web/Two.kt': `package com.example.app.web
const val ROUTE = "/two"
`,
        [CONSTS_KEY]: `package com.example.app.api
const val ROUTE = "/imported"
`,
        [CONTROLLER_KEY]: `package com.example.app.web
import com.example.app.api.*
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ROUTE', repo)).toBeNull();
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

  describe('member names resolve in their declaring scope, not a flat namespace', () => {
    /** Two objects declaring `BASE`; only `A` is referenced. Order is the axis. */
    const siblingShadow = (first: 'A' | 'B'): string => {
      const a = `object A {
    const val BASE = "/right"
    const val ROUTE = BASE + "/m"
}`;
      const b = `object B {
    const val BASE = "/wrong"
}`;
      return `package com.example.app.api\n\n${first === 'A' ? `${a}\n\n${b}` : `${b}\n\n${a}`}\n`;
    };
    const SIBLING_KEY = 'src/main/kotlin/com/example/app/api/Siblings.kt';

    it('answers a sibling initializer identically whichever object is declared first', () => {
      // `A.ROUTE = BASE + "/m"` means `A.BASE`, so the answer is `/right/m` in
      // both spellings. Recording every member under its BARE name too made the
      // operand resolve through whichever object was walked last, so moving
      // `object B` above `object A` changed the emitted route for source that
      // had not changed — the same file, merely reordered, served a different
      // path. Both orders are asserted because either one alone passes on a
      // last-wins implementation.
      for (const first of ['A', 'B'] as const) {
        const repo = repoOf({ [SIBLING_KEY]: siblingShadow(first) });
        expect(resolveKotlinConstant(SIBLING_KEY, 'A.ROUTE', repo), `${first} first`).toBe(
          '/right/m',
        );
        expect(resolveKotlinConstant(SIBLING_KEY, 'B.BASE', repo), `${first} first`).toBe('/wrong');
      }
    });

    it('does not bind an `object` member to its bare name, so an import still wins', () => {
      // `object Local { const val ORDERS }` binds `Local.ORDERS` and nothing
      // else — bare `ORDERS` in this file is the IMPORT. A bare key for the
      // object member is a binding Kotlin does not have, and it outranks the
      // import because the fold consults literals before imports.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object Paths {
    const val ORDERS = "/imported"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.Paths.ORDERS

object Local {
    const val ORDERS = "/local-member"
}
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/imported');
      // The qualified spelling still reaches the object member.
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'Local.ORDERS', repo)).toBe('/local-member');
    });

    it('keeps a top-level `const val` shadowing a same-named import', () => {
      // The control for the test above: a top-level declaration IS the bare
      // binding, so it must keep winning over the import.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object Paths {
    const val ORDERS = "/imported"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.Paths.ORDERS

const val ORDERS = "/local"
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/local');
    });

    it('keeps a companion member visible under its bare name INSIDE its class', () => {
      // The other control: a companion's members ARE in scope unqualified
      // throughout the enclosing class, which is where route annotations sit —
      // but ONLY there. The binding is reached from the reference site through
      // the enclosing type chain, not from a file-level key, so all three
      // spellings below are asserted together: the same name answers one way
      // inside `OrderApi` and does not answer at all outside it.
      const key = 'src/main/kotlin/com/example/app/web/OrderApi.kt';
      const repo = repoOf({
        [key]: `package com.example.app.web

class OrderApi {
    companion object {
        const val ORDERS = "/companion/orders"
    }
}
`,
      });
      const bare = [{ kind: 'ref', name: 'ORDERS' } as const];
      expect(foldKotlinOperands(key, bare, repo, ['OrderApi'])).toBe('/companion/orders');
      expect(foldKotlinOperands(key, bare, repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'OrderApi.ORDERS', repo)).toBe('/companion/orders');
    });

    it('does not let a companion outrank a top-level constant outside its class', () => {
      // Recording the companion's simple name at FILE level put it in the same
      // namespace as the top-level declaration, and companions are recorded
      // last, so the companion won every unqualified reference in the file —
      // including from a class that is not its own. Kotlin binds the top-level
      // `ORDERS` there. Both scopes are asserted from one file; either alone
      // passes on an implementation that gets the other wrong.
      const key = 'src/main/kotlin/com/example/app/web/Routes.kt';
      const repo = repoOf({
        [key]: `package com.example.app.web

const val ORDERS = "/top"

class Holder {
    companion object {
        const val ORDERS = "/companion"
    }
}

class OrderController
`,
      });
      const bare = [{ kind: 'ref', name: 'ORDERS' } as const];
      expect(foldKotlinOperands(key, bare, repo, ['OrderController'])).toBe('/top');
      expect(foldKotlinOperands(key, bare, repo, ['Holder'])).toBe('/companion');
      expect(foldKotlinOperands(key, bare, repo)).toBe('/top');
    });

    it('does not fall through an unfoldable companion to a top-level constant', () => {
      const key = 'src/main/kotlin/com/example/app/web/Routes.kt';
      const repo = repoOf({
        [key]: `package com.example.app.web

const val ORDERS = "/top"

class Holder {
    companion object {
        const val ORDERS = ("/companion")
    }
}

class Other
`,
      });
      const bare = [{ kind: 'ref', name: 'ORDERS' } as const];
      expect(foldKotlinOperands(key, bare, repo, ['Holder'])).toBeNull();
      expect(foldKotlinOperands(key, bare, repo, ['Other'])).toBe('/top');
      expect(foldKotlinOperands(key, bare, repo)).toBe('/top');
    });

    it('scopes each of two colliding companions to its own class', () => {
      // Kotlin scopes the member name to its enclosing class, so the same
      // spelling means a different constant in each body. One file-level
      // namespace could only answer last-wins — both reads returned `/h2`, and
      // reordering the two classes flipped both to `/h1`. Both orders are
      // asserted, because either alone passes on a last-wins implementation.
      const holders = (first: 'A' | 'B'): string => {
        const a = `class HolderA {
    companion object {
        const val ORDERS = "/h1"
    }
}`;
        const b = `class HolderB {
    companion object {
        const val ORDERS = "/h2"
    }
}`;
        return `package com.example.app.web\n\n${first === 'A' ? `${a}\n\n${b}` : `${b}\n\n${a}`}\n`;
      };
      const key = 'src/main/kotlin/com/example/app/web/Holders.kt';
      const bare = [{ kind: 'ref', name: 'ORDERS' } as const];
      for (const first of ['A', 'B'] as const) {
        const repo = repoOf({ [key]: holders(first) });
        expect(foldKotlinOperands(key, bare, repo, ['HolderA']), `${first} first`).toBe('/h1');
        expect(foldKotlinOperands(key, bare, repo, ['HolderB']), `${first} first`).toBe('/h2');
      }
    });

    it('folds a TOP-LEVEL initializer at file level despite a same-named companion', () => {
      // A top-level initializer has an EMPTY scope chain, so `qualifyRef` leaves
      // its operand bare and the file-level maps answer it. A file-wide
      // companion key WAS one of those maps, so `ROUTE` folded to `/comp/m`
      // where Kotlin serves `/top/m` — the case an earlier note in the resolver
      // claimed could not arise because sibling initializers "go through the
      // scope chain". An empty chain is exactly what that missed.
      const key = 'src/main/kotlin/com/example/app/web/Routes.kt';
      const repo = repoOf({
        [key]: `package com.example.app.web

const val BASE = "/top"
const val ROUTE = BASE + "/m"

class Holder {
    companion object {
        const val BASE = "/comp"
    }
}
`,
      });
      expect(resolveKotlinConstant(key, 'ROUTE', repo)).toBe('/top/m');
      // The companion's own binding is intact, reached the way Kotlin reaches it.
      expect(resolveKotlinConstant(key, 'Holder.BASE', repo)).toBe('/comp');
    });

    it('lets a single-name import win over a companion outside that companion class', () => {
      // The fold consults literals before imports, so a file-level companion key
      // outranked a genuine `import …Paths.ORDERS` everywhere in the file. The
      // import is what Kotlin binds outside `Holder`; inside `Holder`, the
      // companion shadows it.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object Paths {
    const val ORDERS = "/imported"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.Paths.ORDERS

class Holder {
    companion object {
        const val ORDERS = "/companion"
    }
}
`,
      });
      const bare = [{ kind: 'ref', name: 'ORDERS' } as const];
      expect(foldKotlinOperands(CONTROLLER_KEY, bare, repo)).toBe('/imported');
      expect(foldKotlinOperands(CONTROLLER_KEY, bare, repo, ['Other'])).toBe('/imported');
      expect(foldKotlinOperands(CONTROLLER_KEY, bare, repo, ['Holder'])).toBe('/companion');
    });

    it('reaches an enclosing class companion from a NESTED type', () => {
      // Kotlin keeps the companion's members in scope through the nested types
      // of its class, so the whole enclosing chain is walked, innermost first —
      // and the inner link still wins where both declare the name.
      const key = 'src/main/kotlin/com/example/app/web/Nested.kt';
      const repo = repoOf({
        [key]: `package com.example.app.web

class Outer {
    companion object {
        const val ORDERS = "/outer"
        const val ONLY_OUTER = "/only-outer"
    }

    class Inner {
        companion object {
            const val ORDERS = "/inner"
        }
    }
}
`,
      });
      expect(
        foldKotlinOperands(key, [{ kind: 'ref', name: 'ORDERS' }], repo, ['Outer.Inner', 'Outer']),
      ).toBe('/inner');
      expect(
        foldKotlinOperands(key, [{ kind: 'ref', name: 'ONLY_OUTER' }], repo, [
          'Outer.Inner',
          'Outer',
        ]),
      ).toBe('/only-outer');
    });

    it('keys a nested object by its full enclosing type path', () => {
      // `Inner`'s initializer names `P`, which `Inner` does not declare and
      // `Outer` does; the scope chain is walked innermost-first, so it means
      // `Outer.P` — not the same-named member of the unrelated `Other`. The
      // declaration itself is reachable as `Outer.Inner.Q`, never `Inner.Q`.
      const key = 'src/main/kotlin/com/example/app/api/Nested.kt';
      const controllerKey = 'src/main/kotlin/com/example/app/web/Controller.kt';
      const nestedImportKey = 'src/main/kotlin/com/example/app/web/NestedImport.kt';
      const memberImportKey = 'src/main/kotlin/com/example/app/web/MemberImport.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

object Other {
    const val P = "/wrong"
}

object Outer {
    const val P = "/right"
    object Inner {
        const val Q = P + "/q"
    }
}
`,
        [controllerKey]: `package com.example.app.web

import com.example.app.api.Outer
`,
        [nestedImportKey]: `package com.example.app.web

import com.example.app.api.Outer.Inner
`,
        [memberImportKey]: `package com.example.app.web

import com.example.app.api.Outer.Inner.Q
`,
      });
      expect(resolveKotlinConstant(key, 'Outer.Inner.Q', repo)).toBe('/right/q');
      expect(resolveKotlinConstant(controllerKey, 'Outer.Inner.Q', repo)).toBe('/right/q');
      expect(resolveKotlinConstant(controllerKey, 'com.example.app.api.Outer.Inner.Q', repo)).toBe(
        '/right/q',
      );
      expect(resolveKotlinConstant(nestedImportKey, 'Inner.Q', repo)).toBe('/right/q');
      expect(resolveKotlinConstant(memberImportKey, 'Q', repo)).toBe('/right/q');
      expect(resolveKotlinConstant(key, 'Inner.Q', repo)).toBeNull();
    });

    it('does not fall through to a file-level constant for an unfoldable sibling', () => {
      // `A.R` names `A.BASE`, which does not fold. The answer is the skip floor,
      // not the top-level `BASE` that happens to share the simple name.
      const key = 'src/main/kotlin/com/example/app/api/Unfoldable.kt';
      const repo = repoOf({
        [key]: `package com.example.app.api

const val BASE = "/top-level"

object A {
    val BASE = buildBase()
    val R = BASE + "/r"
}
`,
      });
      expect(resolveKotlinConstant(key, 'A.R', repo)).toBeNull();
      expect(resolveKotlinConstant(key, 'BASE', repo)).toBe('/top-level');
    });

    it('lets an unfoldable object member leave a same-named import alone', () => {
      // A local declaration drops a same-named import only when it SHADOWS it.
      // An object member shadows nothing, so dropping the import here would
      // floor a reference the language resolves perfectly well.
      const repo = repoOf({
        'src/main/kotlin/com/example/app/api/Paths.kt': `package com.example.app.api

object Paths {
    const val ORDERS = "/imported"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.app.api.Paths.ORDERS

object Local {
    val ORDERS = buildOrders()
}
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ORDERS', repo)).toBe('/imported');
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'Local.ORDERS', repo)).toBeNull();
    });
  });

  describe('imports resolve on the declared package, not on the path', () => {
    it('folds through the file that DECLARES the package, not one whose path imitates it', () => {
      // `src/x/com/example/api/ApiPaths.kt` ends with the imported FQN but
      // declares `package x.com.example.api`, so it is a different declaration
      // entirely. Selecting candidates by path made it beat the real file — and
      // because the decoy declares the same member, the fold did not skip, it
      // published `/wrong`.
      const repo = repoOf({
        'src/generated/Constants.kt': `package com.example.api

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        'src/x/com/example/api/ApiPaths.kt': `package x.com.example.api

object ApiPaths {
    const val ORDERS = "/wrong"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/right');
    });

    it('does not let a deep directory impersonate a root-level package', () => {
      // `package data` lives at the repository root, which the old
      // package-DIRECTORY fallback could not see at all, while
      // `src/main/kotlin/com/example/data/` matched `data` by path suffix. Both
      // halves are gone: the declared package is the whole test.
      const repo = repoOf({
        'Constants.kt': `package data

object Constants {
    const val ORDERS = "/right"
}
`,
        'src/main/kotlin/com/example/data/AppPaths.kt': `package com.example.data

object Constants {
    const val ORDERS = "/wrong"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import data.Constants
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'Constants.ORDERS', repo)).toBe('/right');
    });

    it('skips rather than guesses when no file declares the imported package', () => {
      // The same import with the real declaration absent. A path-suffix match
      // answered `/wrong` here; the honest answer is that the constant is not
      // in this repository.
      const repo = repoOf({
        'src/main/kotlin/com/example/data/AppPaths.kt': `package com.example.data

object Constants {
    const val ORDERS = "/wrong"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import data.Constants
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'Constants.ORDERS', repo)).toBeNull();
    });

    it('skips when two files declare the same fully-qualified name', () => {
      // A test-source copy of a production constant: same package, same object,
      // different value. Only the copy follows the `<package>/<Name>.kt`
      // convention, so a file-name tie-break picked it and folded a test-only
      // path into a production route. Two declarations of one FQN name no single
      // declaration, whichever paths they sit at.
      const repo = repoOf({
        'src/main/kotlin/generated/RoutePaths.kt': `package com.example.api

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        'src/test/kotlin/com/example/api/ApiPaths.kt': `package com.example.api

object ApiPaths {
    const val ORDERS = "/test-only"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });

    it('prefers a unique declarer among same-package candidates', () => {
      // The declaration itself is stronger evidence than either filename or
      // package-only fallback, even when its file also follows the convention.
      const repo = repoOf({
        'src/main/kotlin/com/example/api/ApiPaths.kt': `package com.example.api

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        'src/main/kotlin/com/example/api/Other.kt': `package com.example.api

object OtherPaths {
    const val ITEMS = "/items"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/right');
    });

    it('reaches the sole file of a package whose name matches nothing', () => {
      // The decoy declares a DIFFERENT package, so it is not a candidate at all
      // and the unconventionally named `Constants.kt` is the only one left.
      // This used to be the one shape the old resolver's safety argument
      // covered, and it covered it by emitting nothing.
      const repo = repoOf({
        'src/generated/Constants.kt': `package com.example.api

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        'src/x/com/example/api/ApiPaths.kt': `package x.com.example.api

object ApiPaths {
    const val OTHER = "/other"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/right');
    });

    it('rejects a candidate carrying no recorded package', () => {
      // `RepoConstants` is typed over the agnostic shape, so an entry some other
      // producer put there has no `packageName`. Unknown is not "the default
      // package": the candidate is rejected, and the fold floors to skip.
      const key = 'src/main/kotlin/com/example/api/ApiPaths.kt';
      const foreign = extractKotlinModuleConstants(
        parse(`package com.example.api

object ApiPaths {
    const val ORDERS = "/right"
}
`),
      );
      const repo = new Map<string, ModuleConstants>();
      // Stripped to the agnostic shape: same maps, no `packageName`.
      repo.set(key, {
        literals: foreign.literals,
        exprs: foreign.exprs,
        imports: foreign.imports,
      });
      repo.set(
        CONTROLLER_KEY,
        extractKotlinModuleConstants(
          parse(`package com.example.app.web

import com.example.api.ApiPaths
`),
        ),
      );
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });

    it('matches a package whose segment is backtick-quoted on one side only', () => {
      // `` package com.example.`api` `` and `package com.example.api` name the
      // SAME package: the quotes are lexical syntax, not part of the name. The
      // declared package was recorded with the backticks and the import required
      // an exact string match, so the one real candidate was rejected and the
      // route lost. All three spellings are asserted, because either side can
      // carry the quotes — a declaration may quote a segment an import spells
      // plainly, and an import may quote one the declaration does not.
      const declaration = (pkg: string): string => `package ${pkg}

object ApiPaths {
    const val ORDERS = "/right"
}
`;
      const importing = (spec: string): string => `package com.example.app.web

import ${spec}
`;
      const CONSTS = 'src/main/kotlin/com/example/api/ApiPaths.kt';
      for (const [declared, spec] of [
        ['com.example.`api`', 'com.example.api.ApiPaths'],
        ['com.example.api', 'com.example.`api`.ApiPaths'],
        ['com.example.`api`', 'com.example.`api`.ApiPaths'],
      ] as const) {
        const repo = repoOf({
          [CONSTS]: declaration(declared),
          [CONTROLLER_KEY]: importing(spec),
        });
        expect(
          resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo),
          `${declared} <- ${spec}`,
        ).toBe('/right');
      }
    });

    it('still refuses a package that merely resembles the quoted one', () => {
      // The control for the test above: unquoting compares NAMES, it does not
      // widen the match. `com.example.other` is a different package however
      // either side spells it, so the fold floors to skip rather than reaching
      // for the only file it can see.
      const repo = repoOf({
        'src/main/kotlin/com/example/other/ApiPaths.kt': `package com.example.\`other\`

object ApiPaths {
    const val ORDERS = "/wrong"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.api.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBeNull();
    });

    it('folds through a KEYWORD package segment, which Kotlin can only spell quoted', () => {
      // `package com.example.fun` does not compile — the segment must be
      // `` `fun` `` on both sides. Unquoting must not break the case that only
      // works BECAUSE it is quoted, so this is the control for the pair above.
      const repo = repoOf({
        'src/main/kotlin/com/example/fun/ApiPaths.kt': `package com.example.\`fun\`

object ApiPaths {
    const val ORDERS = "/right"
}
`,
        [CONTROLLER_KEY]: `package com.example.app.web

import com.example.\`fun\`.ApiPaths
`,
      });
      expect(resolveKotlinConstant(CONTROLLER_KEY, 'ApiPaths.ORDERS', repo)).toBe('/right');
    });

    it('matches a backtick-quoted declaration name and reference', () => {
      // Quoting reaches declarations too, and the two sides need not agree:
      // `` object `ApiPaths` `` is keyed `ApiPaths.ORDERS`, and a reference
      // written `` `ApiPaths`.`ORDERS` `` parses to that same name.
      const key = 'src/main/kotlin/com/example/api/ApiPaths.kt';
      const repo = repoOf({
        [key]: `package com.example.api

object \`ApiPaths\` {
    const val \`ORDERS\` = "/right"
}
`,
      });
      expect(resolveKotlinConstant(key, 'ApiPaths.ORDERS', repo)).toBe('/right');
      expect(parseKotlinConstOperands(firstInitializer('val X = `ApiPaths`.`ORDERS`\n'))).toEqual([
        { kind: 'ref', name: 'ApiPaths.ORDERS' },
      ]);
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
      expect(isKotlinConstantFile('val ORDERS = "/api/v1/orders"')).toBe(true);
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

    it('admits top-level vals without admitting locals or constructor properties', () => {
      expect(
        isKotlinConstantFile(`package com.example.app.api

@JvmField
val ORDERS: String = "/api/v1/orders"
`),
      ).toBe(true);
      expect(
        isKotlinConstantFile(`val ORDERS:
    String
    = "/api/v1/orders"
`),
      ).toBe(true);
      expect(isKotlinConstantFile('val ORDERS: String get() = "/computed"')).toBe(true);
      expect(isKotlinConstantFile('val ORDERS by lazy { "/computed" }')).toBe(true);
      expect(isKotlinConstantFile('val `ORDER PATH` = "/api/v1/orders"')).toBe(true);
      expect(
        isKotlinConstantFile(`fun route(): String {
    val ORDERS = "/local"
    return ORDERS
}
`),
      ).toBe(false);
      expect(isKotlinConstantFile('class Holder { val ORDERS = "/instance" }')).toBe(false);
      expect(isKotlinConstantFile('data class Route(val path: String = "/constructor")')).toBe(
        false,
      );
    });

    it('ignores declaration-shaped text in comments and literals', () => {
      expect(isKotlinConstantFile('// const val ORDERS = "/comment"')).toBe(false);
      expect(
        isKotlinConstantFile('/* outer /* const val ORDERS = "/nested-comment" */ end */'),
      ).toBe(false);
      expect(isKotlinConstantFile('val text() = "const val ORDERS = \\"/string\\""')).toBe(false);
      expect(isKotlinConstantFile('val text() = """const val ORDERS = "/raw-string\""""')).toBe(
        false,
      );
      expect(
        isKotlinConstantFile(`fun route(): String {
    val open = '{'
    val close = '}'
    return "$open$close"
}
`),
      ).toBe(false);
    });

    it('admits a backtick-quoted name, because the extractor resolves one', () => {
      // A gate NARROWER than the extractor costs a fact: the file is never
      // parsed into the repo map, so a cross-file reference to the constant
      // floors to skip. `unquoteKotlinIdentifier` strips the quoting everywhere
      // a name becomes a key, so these declarations are ones this module folds.
      expect(isKotlinConstantFile('const val `ORDERS` = "/api/v1/orders"')).toBe(true);
      expect(isKotlinConstantFile('object O { val `ORDERS`: String = "/api/v1/orders" }')).toBe(
        true,
      );
      expect(
        isKotlinConstantFile('class C { companion object { const val `O` = "/orders" } }'),
      ).toBe(true);
    });

    it('does not let the backtick arm widen into a file with no carrier', () => {
      // The control for the arm above: accepting backticks must not turn the
      // gate into "any file mentioning val", which is the whole repository.
      expect(
        isKotlinConstantFile(`package com.example.app.web

class OrderService {
    fun list(): List<String> {
        val \`local name\` = "not a constant"
        return listOf(\`local name\`)
    }
}
`),
      ).toBe(false);
    });
  });
});
