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
