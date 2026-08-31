/**
 * Constant-valued Spring route paths on the Kotlin group plugin.
 *
 * Drives `KOTLIN_HTTP_PLUGIN.prepareRepo` + `scan(tree, ctx, rel)` with all
 * three arguments, which is the shape the http-route-extractor orchestrator
 * uses. The existing Kotlin guards call `scan(tree)` with ONE argument and are
 * therefore structurally blind here: without a repo context the plugin has no
 * constant map and drops every constant-valued route.
 *
 * Asserted:
 *   • the four reference forms fold to the right provider contract — qualified
 *     access, fully-qualified name, single-name import, `+`-concatenation;
 *   • a class prefix that resolves to NO literal suppresses every method route
 *     under that class, literal ones included (the prefix is not knowable here,
 *     and emitting the methods unprefixed would publish paths the application
 *     does not serve) — the rule `java.ts` already applies. Pinned across every
 *     spelling that reaches the suppression, because the analysis inverts a
 *     literalness test rather than listing node types: a bare constant, both
 *     argument spellings, `[…]`, `arrayOf(…)`, a call, an `if`, and an
 *     interpolated string;
 *   • a prefix that resolves only PARTLY still publishes its resolvable arm —
 *     Kotlin's vararg `@RequestMapping("/lit", ApiPaths.BASE)` keeps `/lit`,
 *     because suppression exists to avoid wrong routes, not to discard right
 *     ones;
 *   • a `@RequestMapping` with no path argument at all is not a prefix and does
 *     not suppress anything;
 *   • an OpenFeign consumer folds a constant method path, and both consumer
 *     lanes (`@(Get|…)Mapping` and `@RequestLine`) are suppressed by an
 *     unresolvable governing prefix for the same reason a provider is —
 *     resolved in "path wins" order, so a literal `@FeignClient(path)` rescues
 *     an interface whose `@RequestMapping` is a constant, and an unresolvable
 *     `path` is fatal on its own;
 *   • an unresolvable constant emits nothing rather than a guessed path;
 *   • a cross-file fold survives BACKSLASHED repository keys — the shape glob
 *     v13 hands the orchestrator on Windows, and the one every other fixture
 *     here misses by writing POSIX string literals;
 *   • a constant that folds to `""` publishes the class prefix, exactly as the
 *     literal `@GetMapping("")` beside it does — an empty fold is a success,
 *     not the skip floor;
 *   • without a repo context the plugin emits nothing (the documented skip
 *     floor, and the branch the 1-argument guards cannot reach);
 *   • literal routes are untouched and are not emitted twice.
 */

import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { KOTLIN_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/kotlin.js';
import type { HttpLanguagePlugin } from '../../../src/core/group/extractors/http-patterns/types.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Optional grammar; the suite skips when its native binding is unavailable.
}

const describeKotlin = Kotlin && KOTLIN_HTTP_PLUGIN ? describe : describe.skip;
// Non-null only inside `describeKotlin`, which is skipped when the plugin is null.
const plugin = KOTLIN_HTTP_PLUGIN as HttpLanguagePlugin;

const parseSource = (p: Parser, src: string): Parser.Tree => {
  p.setLanguage(Kotlin as Parser.Language);
  return p.parse(src);
};

/** prepareRepo + a 3-argument scan over every file; contracts of one role. */
function contracts(files: Record<string, string>, role: 'provider' | 'consumer'): string[] {
  const ctx = plugin.prepareRepo?.({
    repoPath: '/virtual',
    files: Object.keys(files),
    parser: new Parser(),
    readFile: (rel: string) => files[rel] ?? null,
    parseSource,
  });
  const out: string[] = [];
  for (const rel of Object.keys(files)) {
    for (const d of plugin.scan(parseSource(new Parser(), files[rel]), ctx, rel)) {
      if (d.role === role) out.push(`${d.method} ${d.path}`);
    }
  }
  return out.sort();
}

const providers = (files: Record<string, string>): string[] => contracts(files, 'provider');
const consumers = (files: Record<string, string>): string[] => contracts(files, 'consumer');

const CONSTS = 'src/main/kotlin/com/example/app/api/ApiPaths.kt';
const CONTROLLER = 'src/main/kotlin/com/example/app/web/OrderController.kt';
const CLIENT = 'src/main/kotlin/com/example/app/client/OrderClient.kt';

const CONSTS_SRC = `package com.example.app.api

object ApiPaths {
    const val BASE = "/api/v1"
    const val ORDERS = BASE + "/orders"
}
`;

describeKotlin('Kotlin constant-valued Spring routes (group plugin)', () => {
  it('folds a qualified reference in a positional argument', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('folds a standalone top-level val from another file', () => {
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

val ORDERS = "/api/v1/orders"
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ORDERS

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('folds declarations imported through a package star', () => {
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

const val ORDERS = "/api/v1/orders"
object ApiPaths {
    const val ITEMS = "/api/v1/items"
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.*

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}

    @GetMapping(ApiPaths.ITEMS)
    fun items() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/items', 'GET /api/v1/orders']);
  });

  it('prefers same-package sibling declarations over package-star imports', () => {
    expect(
      providers({
        [CONSTS]: `package com.example.app.api
const val ORDERS = "/imported"
object ApiPaths {
    const val ITEMS = "/imported/items"
}
`,
        'src/main/kotlin/com/example/app/web/LocalPaths.kt': `package com.example.app.web
const val ORDERS = "/local"
object ApiPaths {
    const val ITEMS = "/local/items"
}
`,
        [CONTROLLER]: `package com.example.app.web
import com.example.app.api.*

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}

    @GetMapping(ApiPaths.ITEMS)
    fun items() {}
}
`,
      }),
    ).toEqual(['GET /local', 'GET /local/items']);
  });

  it('folds a constant imported through a nested object', () => {
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

object Outer {
    object Inner {
        const val ORDERS = "/nested/orders"
    }
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.Outer.Inner

@RestController
class OrderController {
    @GetMapping(Inner.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /nested/orders']);
  });

  it('folds a named `value =` / `path =` argument and an inline concatenation', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @PostMapping(value = ApiPaths.BASE + "/orders/create")
    fun create() {}

    @DeleteMapping(path = ApiPaths.ORDERS)
    fun remove() {}
}
`,
      }),
    ).toEqual(['DELETE /api/v1/orders', 'POST /api/v1/orders/create']);
  });

  it('folds a fully-qualified reference and a single-name import', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths.ORDERS

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}

    @PutMapping(com.example.app.api.ApiPaths.ORDERS)
    fun replace() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders', 'PUT /api/v1/orders']);
  });

  it('ignores a non-route named argument', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(path = ApiPaths.ORDERS, produces = [MediaType.APPLICATION_JSON_VALUE])
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('suppresses every method route under a CONSTANT class prefix', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping(ApiPaths.BASE)
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}

    @GetMapping("/literal")
    fun literal() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('suppresses them just the same when the class prefix is a NAMED argument', () => {
    // `@RequestMapping(value = ApiPaths.BASE)` takes the other branch of
    // `kotlinRouteArgumentExpression` (read the key, then take `namedChild(1)`)
    // than the positional case above. Both must reach the same verdict: a
    // regression in the named branch would let the class escape suppression and
    // publish every method under it unprefixed.
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping(value = ApiPaths.BASE)
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}

    @GetMapping("/literal")
    fun literal() {}
}
`,
      }),
    ).toEqual([]);
  });

  /**
   * A controller carrying `prefix` as its class-level `@RequestMapping`, with
   * one constant-valued and one literal route under it. `decls` holds any
   * top-level declaration the prefix expression refers to.
   */
  const controllerWithPrefix = (prefix: string, decls = ''): Record<string, string> => ({
    [CONSTS]: CONSTS_SRC,
    [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths
${decls}
@RestController
@RequestMapping(${prefix})
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}

    @GetMapping("/literal")
    fun literal() {}
}
`,
  });

  // Every prefix spelling that resolves to no literal, and so must suppress.
  // This is a table rather than one representative case on purpose: the two
  // tests above pin a BARE constant, which any node-type allow-list would also
  // catch. These are the shapes such a list forgets — and forgetting one does
  // not degrade to "no route", it publishes every method of the class at its
  // UNPREFIXED path, which the application does not serve. The `if` and the
  // interpolated string are the two that need no constant map at all to go
  // wrong, and the `[…]` / `arrayOf(…)` pair matters because the literal
  // prefix patterns DO reach inside both — so a naive "is it a literal
  // container?" test would pass them straight through.
  it.each([
    ['a collection literal holding a constant', '[ApiPaths.BASE]', ''],
    ['an arrayOf(…) holding a constant', 'arrayOf(ApiPaths.BASE)', ''],
    ['a named collection literal holding a constant', 'value = [ApiPaths.BASE]', ''],
    ['a function call', 'buildPath()', '\nfun buildPath(): String = ApiPaths.BASE\n'],
    ['an interpolated string', '"${ApiPaths.BASE}"', ''],
    ['an if expression', 'if (USE_V2) "/api/v2" else "/api/v1"', '\nconst val USE_V2 = false\n'],
  ])('suppresses every method route under a class prefix that is %s', (_label, prefix, decls) => {
    expect(providers(controllerWithPrefix(prefix, decls))).toEqual([]);
  });

  it('keeps both routes when that same class prefix is a plain literal', () => {
    // The control for the table above: same two methods, same helper, a prefix
    // the extractor can resolve. Without it an empty result there would be
    // indistinguishable from the fixture failing to produce routes at all.
    expect(providers(controllerWithPrefix('"/api"'))).toEqual([
      'GET /api/api/v1/orders',
      'GET /api/literal',
    ]);
  });

  it('keeps the resolvable arm of a PARTLY resolvable class prefix', () => {
    // Kotlin's vararg spelling. `/lit` is a real prefix the application really
    // serves, so the routes under it are derivable and must survive; only the
    // `ApiPaths.BASE` arm is missing from the result, exactly as it was before
    // constant folding existed. Marking the class unfoldable here would trade a
    // wrong route for a missing one, which is not the bargain suppression makes.
    expect(providers(controllerWithPrefix('"/lit", ApiPaths.BASE'))).toEqual([
      'GET /lit/api/v1/orders',
      'GET /lit/literal',
    ]);
    // Same shape spelled as one collection argument.
    expect(providers(controllerWithPrefix('["/lit", ApiPaths.BASE]'))).toEqual([
      'GET /lit/api/v1/orders',
      'GET /lit/literal',
    ]);
  });

  it('does not treat a @RequestMapping without a path argument as a prefix', () => {
    // `produces` is not a path, so this class has no prefix — not an
    // unresolvable one. Suppressing here would drop routes that are correct and
    // complete as written.
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping(produces = [MediaType.APPLICATION_JSON_VALUE])
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('does not treat an EMPTY class path array as an unresolvable prefix', () => {
    // `@RequestMapping(arrayOf())` designates NO prefix — Spring maps the class
    // at the application root — so `/literal` really is served at `/literal`.
    // Treating it as an unresolvable prefix suppressed every route under the
    // class, the literal one included, which no constant fold was ever involved
    // in. The arithmetic behind that: an empty array has no elements, and "no
    // element is a literal" is trivially true of an empty set, so the class read
    // as unresolvable. "No prefix" is not "an unresolvable prefix".
    expect(providers(controllerWithPrefix('arrayOf()'))).toEqual([
      'GET /api/v1/orders',
      'GET /literal',
    ]);
  });

  it('keeps an inherited route under an EMPTY interface path array', () => {
    const files = {
      'src/OrderApi.kt': `package com.example.app

@RequestMapping([])
interface OrderApi {
    @GetMapping("/orders")
    fun list()
}
`,
      'src/OrderController.kt': `package com.example.app

@RestController
class OrderController : OrderApi {
    override fun list() {}
}
`,
    };
    const detections =
      plugin.scanProject?.(
        Object.entries(files).map(([filePath, source]) => ({
          filePath,
          tree: parseSource(new Parser(), source),
        })),
      ) ?? [];
    expect(
      detections.flatMap((file) =>
        file.detections
          .filter((detection) => detection.role === 'provider')
          .map((detection) => `${detection.method} ${detection.path}`),
      ),
    ).toEqual(['GET /orders']);
  });

  it('still suppresses a NON-empty array whose only element is a constant', () => {
    // The control for the empty `arrayOf()` case: an array that DOES designate
    // a prefix still suppresses when that prefix is unknowable.
    expect(providers(controllerWithPrefix('arrayOf(ApiPaths.BASE)'))).toEqual([]);
  });

  it('does not treat an EMPTY @FeignClient(path) array as an unresolvable path', () => {
    // Same distinction on the consumer side, where the governing-prefix guard is
    // its own set: `path = arrayOf()` adds no prefix, so the remote URL is
    // exactly the method's own path and the consumer is knowable.
    expect(
      consumers({
        [CLIENT]: `package com.example.app.client

@FeignClient(name = "orders", path = arrayOf())
interface OrderClient {
    @GetMapping("/orders")
    fun listOrders(): String
}
`,
      }),
    ).toEqual(['GET /orders']);
  });

  it('still applies a LITERAL class prefix to a folded method path', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping("/api/v1")
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/api/v1/orders']);
  });

  it('emits nothing when the constant cannot be resolved', () => {
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('emits nothing for a constant route scanned without a repo context', () => {
    // This is the branch the 1-argument guards cannot reach; pin it so it is
    // not silently dead in the suite.
    const tree = parseSource(
      new Parser(),
      `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
    );
    expect(plugin.scan(tree).filter((d) => d.role === 'provider')).toEqual([]);
  });

  it('folds a constant method path on a @FeignClient interface', () => {
    expect(
      consumers({
        [CONSTS]: CONSTS_SRC,
        [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders")
interface OrderClient {
    @GetMapping(ApiPaths.ORDERS)
    fun list()
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('drops a @FeignClient consumer whose interface prefix is a CONSTANT', () => {
    // In tree-sitter-kotlin an `interface` is a `class_declaration`, so the
    // suppression rule reaches a Feign interface too — and it must, for the same
    // reason it reaches a controller: the prefix is not knowable here, so the
    // alternative is publishing the remote call at `/orders` when the service is
    // really called at `/api/v1/orders`. A dropped consumer edge is a missing
    // fact; a wrong URL is a false edge.
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders")
@RequestMapping(ApiPaths.BASE)
interface OrderClient {
    @GetMapping("/orders")
    fun list()
}
`,
    };
    expect(consumers(files)).toEqual([]);
    // Control: the identical interface with a LITERAL prefix is still detected,
    // so the empty result above is the suppression rule and not a blind spot in
    // Feign detection itself.
    expect(
      consumers({
        ...files,
        [CLIENT]: files[CLIENT].replace(
          '@RequestMapping(ApiPaths.BASE)',
          '@RequestMapping("/api/v1")',
        ),
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('drops a @FeignClient consumer whose `path` argument is a CONSTANT', () => {
    // `path` is the Feign client's own prefix and is never a `@RequestMapping`,
    // so the class-prefix analysis cannot see it. Left unchecked, this interface
    // falls through to the no-prefix fallback and publishes a remote call to
    // `/api/v1/orders` as a call to `/orders` — a consumer edge pointing at a
    // route no service serves.
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders", path = ApiPaths.BASE)
interface OrderClient {
    @GetMapping(ApiPaths.ORDERS)
    fun list()
}
`,
    };
    expect(consumers(files)).toEqual([]);
    // Control: the same interface with a LITERAL `path` is still detected.
    expect(
      consumers({
        ...files,
        [CLIENT]: files[CLIENT].replace('path = ApiPaths.BASE', 'path = "/svc"'),
      }),
    ).toEqual(['GET /svc/api/v1/orders']);
  });

  it('lets a literal @FeignClient(path) outrank a CONSTANT @RequestMapping', () => {
    // `path` wins over `@RequestMapping` when the URL is assembled, so it has to
    // win when resolvability is judged too — otherwise an interface whose real
    // prefix is perfectly knowable loses its consumer to a `@RequestMapping`
    // that never governed it.
    expect(
      consumers({
        [CONSTS]: CONSTS_SRC,
        [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders", path = "/svc")
@RequestMapping(ApiPaths.BASE)
interface OrderClient {
    @GetMapping("/orders")
    fun list()
}
`,
      }),
    ).toEqual(['GET /svc/orders']);
  });

  it('drops a @RequestLine consumer under an unresolvable interface prefix', () => {
    // `@RequestLine` carries its own verb and path but is still prefixed by the
    // interface, and it resolves through the same "path wins" fallback chain as
    // the `@(Get|…)Mapping` lane — so an unresolvable governing prefix leaves
    // the remote URL just as unknowable here.
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders")
@RequestMapping(ApiPaths.BASE)
interface OrderClient {
    @RequestLine("GET /list")
    fun list()
}
`,
    };
    expect(consumers(files)).toEqual([]);
    // Control: a literal interface prefix still yields the prefixed consumer.
    expect(
      consumers({
        ...files,
        [CLIENT]: files[CLIENT].replace(
          '@RequestMapping(ApiPaths.BASE)',
          '@RequestMapping("/lit")',
        ),
      }),
    ).toEqual(['GET /lit/list']);
  });

  it('judges @RequestLine and @(Get|…)Mapping alike on ONE interface', () => {
    // Both lanes read the same prefix through the same fallback chain, so they
    // must reach the same verdict on it. A guard on only one of them lets the
    // interface suppress one route and publish the other under the very same
    // unresolvable prefix — a self-inconsistency visible in a single scan.
    expect(
      consumers({
        [CONSTS]: CONSTS_SRC,
        [CLIENT]: `package com.example.app.client

import com.example.app.api.ApiPaths

@FeignClient(name = "orders")
@RequestMapping(ApiPaths.BASE)
interface OrderClient {
    @GetMapping(ApiPaths.ORDERS)
    fun list()

    @RequestLine("GET /list")
    fun listLegacy()
}
`,
      }),
    ).toEqual([]);
  });

  it('folds across files when repository keys use Windows separators', () => {
    // The orchestrator's file list comes from glob v13, which has no
    // `posix: true` and joins with the platform separator, so on Windows both
    // `prepareRepo({files})` and `scan(tree, ctx, rel)` see
    // `src\main\kotlin\…`. `resolveKotlinImport` asks whether a key ends with
    // `com/example/app/api/ApiPaths.kt` — a test no backslashed key can pass —
    // so EVERY cross-file fold returned null on Windows and on Windows only:
    // the pre-pass still ran and the context was still built, the feature was
    // just silently absent. Every other fixture in this file is a POSIX string
    // literal, which is exactly why CI stayed green.
    //
    // The keys are backslashed HERE rather than derived from `path.sep`, so the
    // regression is pinned on every runner instead of only on the Windows
    // matrix — the plugin reads keys, not the host OS, so simulating the keys
    // simulates the whole bug.
    const winKey = (rel: string): string => rel.replace(/\//g, '\\');
    expect(
      providers({
        [winKey(CONSTS)]: CONSTS_SRC,
        [winKey(CONTROLLER)]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('treats a constant that folds to "" as the class prefix itself', () => {
    // `const val ROOT = ""` is Spring's idiom for "the collection root", and
    // `joinPath` resolves it against the class prefix exactly as it resolves the
    // literal `@PostMapping("")` beside it. The fold used to collapse `''` into
    // the skip floor, so the two annotations below — the same path, written two
    // ways — disagreed: the literal published `POST /api`, the constant
    // published nothing. Asserting BOTH in one class is the point; a test on the
    // constant alone would pass against any chosen convention rather than
    // pinning the two spellings together.
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

object ApiPaths {
    const val ROOT = ""
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping("/api")
class OrderController {
    @GetMapping(ApiPaths.ROOT)
    fun list() {}

    @PostMapping("")
    fun create() {}
}
`,
      }),
    ).toEqual(['GET /api/', 'POST /api/']);
  });

  it('serves the same route whichever of two same-named objects is declared first', () => {
    // `A.ROUTE = BASE + "/m"` means `A.BASE`. Recording every object member
    // under its bare name too made that operand resolve through whichever
    // same-named sibling was walked LAST, so reordering two objects — a change
    // Kotlin does not even see — moved the published route from `/right/m` to
    // `/wrong/m`. Both orders are asserted; either alone passes on a last-wins
    // implementation.
    const controllerWith = (objects: string): string => `package com.example.app.web

${objects}

@RestController
class OrderController {
    @GetMapping(A.ROUTE)
    fun get() {}
}
`;
    const A = `object A {
    const val BASE = "/right"
    const val ROUTE = BASE + "/m"
}`;
    const B = `object B {
    const val BASE = "/wrong"
}`;
    expect(providers({ [CONTROLLER]: controllerWith(`${A}\n\n${B}`) })).toEqual(['GET /right/m']);
    expect(providers({ [CONTROLLER]: controllerWith(`${B}\n\n${A}`) })).toEqual(['GET /right/m']);
  });

  it('reads a bare route constant from the import, not from a local object member', () => {
    // Bare `ORDERS` in this file is the IMPORT: `object Local` binds
    // `Local.ORDERS` and nothing else. A bare key for the object member is a
    // binding Kotlin does not have, and it outranked the import because the fold
    // consults literals before imports — publishing a path the service does not
    // serve.
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths.ORDERS

object Local {
    const val ORDERS = "/local"
}

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('keeps a companion constant readable under its bare name', () => {
    // The control for the test above, and the reason object members and
    // companion members are keyed differently: a companion's members ARE in
    // scope unqualified throughout the enclosing class, which is precisely where
    // route annotations sit.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
class OrderController {
    companion object {
        const val ORDERS = "/api/v1/orders"
    }

    @GetMapping(ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('resolves a bare companion constant inside a nested class', () => {
    // Declaration extraction and reference-site qualification must agree on
    // the full owner path. `ORDERS` here means `Outer.Inner.ORDERS`, not the
    // nonexistent top-level `Inner.ORDERS`.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
class Outer {
    class Inner {
        companion object {
            const val ORDERS = "/nested/orders"
        }

        @GetMapping(ORDERS)
        fun list() {}
    }
}
`,
      }),
    ).toEqual(['GET /nested/orders']);
  });

  it('folds through the file that declares the package, not one whose path imitates it', () => {
    // The decoy's PATH ends with the imported FQN, but it declares
    // `package x.com.example.app.api` — a different declaration. Choosing the
    // candidate by path let it win, and because it declares the same member the
    // fold did not skip: it published `/wrong`. The declared `package` is the
    // authority; the path is only a tie-break among files that already declare
    // the right one.
    expect(
      providers({
        'src/generated/Constants.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        'src/x/com/example/app/api/ApiPaths.kt': `package x.com.example.app.api

object ApiPaths {
    const val ORDERS = "/wrong"
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('emits nothing when a test-source copy duplicates a production constant', () => {
    // Same package, same object, different value, and only the copy follows the
    // `<package>/<Name>.kt` convention — so a file-name tie-break folded a
    // test-only path into a production route. Two declarations of one
    // fully-qualified name identify no single declaration, so the honest answer
    // is no route: preferring the production source set would be a guess about
    // build configuration this layer cannot see.
    expect(
      providers({
        'src/main/kotlin/generated/RoutePaths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`,
        'src/test/kotlin/com/example/app/api/ApiPaths.kt': `package com.example.app.api

object ApiPaths {
    const val ORDERS = "/test-only"
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('keeps an unfoldable production twin in duplicate-FQN detection', () => {
    expect(
      providers({
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
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('resolves a bare reference by the class it sits in, not by declaration order', () => {
    // A companion member is bound unqualified inside its enclosing class BODY
    // and nowhere else. Recorded under a file-level bare key it landed in the
    // same namespace as top-level declarations and, because companions are
    // walked last, won every unqualified reference in the file — so the
    // reference in `OrderController` below, which is not `Holder`'s body,
    // published `/companion` where the application serves `/top`.
    //
    // Both classes are asserted from ONE file: a fixture with only the wrong
    // one would also pass on an implementation that simply dropped companions,
    // and a fixture with only the right one would pass on the old file-wide key.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

const val ORDERS = "/top"

class Holder {
    companion object {
        const val ORDERS = "/companion"
    }

    @GetMapping(ORDERS)
    fun inside() {}
}

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun outside() {}
}
`,
      }),
    ).toEqual(['GET /companion', 'GET /top']);
  });

  it('does not publish a top-level route for an unfoldable companion binding', () => {
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

const val ORDERS = "/top"

@RestController
class Holder {
    companion object {
        const val ORDERS = ("/companion")
    }

    @GetMapping(ORDERS)
    fun inside() {}
}

@RestController
class OtherController {
    @GetMapping(ORDERS)
    fun outside() {}
}
`,
      }),
    ).toEqual(['GET /top']);
  });

  it('gives two colliding companions each their own class', () => {
    // Kotlin scopes each companion's members to its own class, so the two
    // references below mean different constants even though they are spelled
    // identically. One file-level namespace could only answer last-wins: both
    // read `/h2`, and swapping the two classes flipped both to `/h1`.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
class FirstController {
    companion object {
        const val ORDERS = "/h1"
    }

    @GetMapping(ORDERS)
    fun list() {}
}

@RestController
class SecondController {
    companion object {
        const val ORDERS = "/h2"
    }

    @GetMapping(ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /h1', 'GET /h2']);
  });

  it('folds a top-level initializer at file level even when a companion shares the name', () => {
    // `ROUTE`'s initializer is TOP-LEVEL, so its scope chain is empty and its
    // operand `BASE` means the top-level `BASE`. With a file-wide companion key
    // the empty chain left the operand bare and the companion answered it,
    // publishing `/comp/m` where the application serves `/top/m`.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

const val BASE = "/top"
const val ROUTE = BASE + "/m"

class Holder {
    companion object {
        const val BASE = "/comp"
    }
}

@RestController
class OrderController {
    @GetMapping(ROUTE)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /top/m']);
  });

  it('folds through a package whose segment is backtick-quoted on one side only', () => {
    // `` package com.example.app.`api` `` and `package com.example.app.api` are
    // the same package to the compiler — the quotes are lexical syntax, not part
    // of the name. Comparing the two verbatim rejected the one real candidate
    // and dropped the route. Both directions are asserted because either side
    // can carry the quotes.
    const controller = (spec: string): string => `package com.example.app.web

import ${spec}

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`;
    const quotedDeclaration = `package com.example.app.\`api\`

object ApiPaths {
    const val ORDERS = "/api/v1/orders"
}
`;
    // Declaration quoted, import plain.
    expect(
      providers({
        [CONSTS]: quotedDeclaration,
        [CONTROLLER]: controller('com.example.app.api.ApiPaths'),
      }),
    ).toEqual(['GET /api/v1/orders']);
    // Import quoted, declaration plain.
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: controller('com.example.app.`api`.ApiPaths'),
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('folds a same-file top-level `val` even when the file imports nothing', () => {
    // Three conditions have to line up for this to break, which is why a
    // realistic controller never hit it: the constant is a top-level non-`const`
    // `val` (so `isKotlinConstantFile` rejects the file and the pre-pass never
    // indexes it), the file declares no `object` (the gate's other arm), and it
    // imports nothing. The on-demand overlay in `scan` is the file's only
    // remaining chance, and it used to admit the extraction only when the file
    // had imports — throwing away the very constants the route needs.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

val PATH = "/orders"

@RestController
@RequestMapping("/api/v1")
class OrderController {
    @GetMapping(PATH)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('folds a backtick-quoted constant declared in its own file', () => {
    // The gate decides whether a file is parsed into the repo map at all, so a
    // gate that rejects backticks silently drops a constant the resolver can
    // fold — a cross-file reference to it then floors to skip.
    expect(
      providers({
        [CONSTS]: `package com.example.app.api

object ApiPaths {
    const val \`ORDERS\` = "/api/v1/orders"
}
`,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('resolves a PARTIALLY qualified reference against the enclosing scopes', () => {
    // `Inner.Q` carries an owner, but not its whole one: the key is
    // `Outer.Inner.Q`. Treating any dotted reference as already complete looked
    // for a key nothing declares and dropped the route.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
object Outer {
    object Inner {
        const val Q = "/orders"
    }

    @GetMapping(Inner.Q)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /orders']);
  });

  it('binds a partially qualified reference to the NESTED owner, not a top-level twin', () => {
    // The severe half of the same defect. Kotlin binds `ApiPaths` to the nested
    // object, so the route is `/inner`. Left unqualified, `ApiPaths.ORDERS`
    // matched the TOP-LEVEL object instead and published `/orders` — a path the
    // application does not serve, which is worse than the dropped route above.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

object ApiPaths {
    const val ORDERS = "/orders"
}

@RestController
class OrderController {
    object ApiPaths {
        const val ORDERS = "/inner"
    }

    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /inner']);
  });

  it('resolves a partially qualified reference inside an INITIALIZER too', () => {
    // The same rule on the other side. `ROUTE = Inner.Q + "/m"` sits in
    // `Outer`'s body, so `Inner.Q` means `Outer.Inner.Q` there. Fixing only the
    // reference site would leave the two halves disagreeing about what a dotted
    // name means — the asymmetry that produced the earlier defects here.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

object Outer {
    object Inner {
        const val Q = "/orders"
    }

    const val ROUTE = Inner.Q + "/m"
}

@RestController
class OrderController {
    @GetMapping(Outer.ROUTE)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /orders/m']);
  });

  it('folds a partially qualified reference regardless of its sibling operands', () => {
    // Control for the allocation gate: it must not decide the result. Gating on
    // "some operand is bare" made this same `Inner.Q` fold only because `SUFFIX`
    // sits beside it, while `Inner.Q` alone did not — the same reference
    // resolving differently by the company it keeps.
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
object Outer {
    object Inner {
        const val Q = "/orders"
    }

    const val SUFFIX = "/list"

    @GetMapping(Inner.Q + SUFFIX)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /orders/list']);
  });

  it('leaves literal routes unchanged and emits each exactly once', () => {
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
@RequestMapping("/api/v1")
class OrderController {
    @GetMapping("/orders")
    fun list() {}

    @PostMapping(value = "/orders")
    fun create() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders', 'POST /api/v1/orders']);
  });
});
