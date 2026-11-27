import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import { extractNestRoutes } from '../../src/core/ingestion/route-extractors/nest.js';
import { normalizeExtractedRoutePath } from '../../src/core/ingestion/route-extractors/route-path.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

// The extractor is registered on the JavaScript provider too, and the two
// grammars place a method decorator differently, so both must be exercised.
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const extract = (source: string) =>
  extractNestRoutes(tsParser.parse(source), 'src/x.controller.ts');

const extractJs = (source: string) =>
  extractNestRoutes(jsParser.parse(source), 'src/x.controller.js');

/** What the routes phase will key the Route node by: verb + joined path. */
const format = (routes: ReturnType<typeof extract>) =>
  routes.map(
    (r) => `${r.httpMethod} ${normalizeExtractedRoutePath(r.routePath, r.prefix ?? null)}`,
  );

const urls = (source: string) => format(extract(source));
const jsUrls = (source: string) => format(extractJs(source));

describe('NestJS decorator routes', () => {
  it('joins the controller prefix with each method path', () => {
    expect(
      urls(`
        @Controller('venues')
        export class VenueController {
          @Get()
          findAll() {}

          @Get('search')
          search() {}

          @Post(':id/follow')
          follow(@Param('id') id: string) {}

          @Delete(':id')
          remove() {}
        }
      `),
    ).toEqual([
      'GET /venues',
      'GET /venues/search',
      'POST /venues/:id/follow',
      'DELETE /venues/:id',
    ]);
  });

  it("emits '/' rather than '' for a pathless @Get, so the handler still resolves", () => {
    // call-processor's claim() short-circuits on a falsy routePath, so ''
    // would create the Route node but silently lose its handler symbol.
    // Both spellings normalize to the same URL.
    const [route] = extract(`
      @Controller('venues')
      export class VenueController {
        @Get()
        findAll() {}
      }
    `);
    expect(route.routePath).toBe('/');
    expect(normalizeExtractedRoutePath(route.routePath, route.prefix ?? null)).toBe('/venues');
  });

  it('handles a prefixless @Controller()', () => {
    expect(
      urls(`
        @Controller()
        export class AppController {
          @Get('health')
          health() {}
        }
      `),
    ).toEqual(['GET /health']);
  });

  it('captures the handler method name for symbol resolution', () => {
    const routes = extract(`
      @Controller('users')
      export class UserController {
        @Patch(':id')
        updateOne() {}
      }
    `);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      httpMethod: 'PATCH',
      routePath: ':id',
      prefix: 'users',
      decoratorName: 'Patch',
      handlerName: 'updateOne',
      filePath: 'src/x.controller.ts',
    });
  });

  it('supports a non-exported controller and all verbs', () => {
    expect(
      urls(`
        @Controller('a')
        class A {
          @Put('p') p() {}
          @Head('h') h() {}
          @Options('o') o() {}
          @All('any') any() {}
        }
      `),
    ).toEqual(['PUT /a/p', 'HEAD /a/h', 'OPTIONS /a/o', '* /a/any']);
  });

  it('applies each controller its own prefix when a file declares several', () => {
    expect(
      urls(`
        @Controller('one')
        export class One { @Get('x') x() {} }

        @Controller('two')
        export class Two { @Get('y') y() {} }
      `),
    ).toEqual(['GET /one/x', 'GET /two/y']);
  });

  it('carries stacked decorators through to the route', () => {
    expect(
      urls(`
        @Controller('secure')
        export class SecureController {
          @UseGuards(AuthGuard)
          @Get('me')
          me() {}
        }
      `),
    ).toEqual(['GET /secure/me']);
  });

  it('sees through a comment between the decorators and the method', () => {
    // Found on a real controller: four stacked decorators, then a JSDoc block,
    // then the method. Breaking the backward walk at the comment made the
    // entire route invisible.
    expect(
      urls(`
        @Controller('dev')
        export class DevController {
          @Post('simulate-expiry')
          @HttpCode(HttpStatus.OK)
          @ApiOperation({ summary: 'x' })
          /**
           * Simulate an expiry.
           */
          simulateExpiry() {}
        }
      `),
    ).toEqual(['POST /dev/simulate-expiry']);
  });

  it('sees through a comment between @Controller and the class', () => {
    expect(
      urls(`
        @Controller('docs')
        /** The controller. */
        export class DocsController {
          @Get('x') x() {}
        }
      `),
    ).toEqual(['GET /docs/x']);
  });

  // ─── Precision guards ──────────────────────────────────────────────

  it('ignores verb-named decorators on a class that is not a @Controller', () => {
    // `Get`/`Post` are ordinary identifiers; without the @Controller
    // requirement any library reusing those names mints phantom endpoints.
    // The unrelated controller is what makes this test reach the per-class
    // check: without a `@Controller` anywhere the file short-circuits at the
    // parse-free substring gate and the assertion proves nothing.
    expect(
      urls(`
        @Controller('y')
        export class RealController {
          @Get('real')
          real() {}
        }

        @Injectable()
        export class NotAController {
          @Get('looks-like-a-route')
          nope() {}
        }
      `),
    ).toEqual(['GET /y/real']);
  });

  it.each([
    { label: 'a constant it cannot read', argument: 'ROUTES.SEARCH' },
    { label: 'an interpolated template', argument: '`${prefix}/search`' },
    { label: 'an array with one element it cannot read', argument: "['a', ROUTES.ADMIN]" },
  ])('drops a route whose path is $label', ({ argument }) => {
    // A wrong URL is worse than a missing one — route_map presents this as fact.
    // The array row is why one bad element poisons the whole array rather than
    // emitting its readable siblings: a half-mapped controller reads as a fully
    // mapped one, which is the same lie with less to notice.
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get(${argument})
          search() {}
        }
      `),
    ).toEqual([]);
  });

  it('drops every route of a controller whose prefix cannot be read', () => {
    expect(
      extract(`
        @Controller(BASE_PATH)
        export class C {
          @Get('search')
          search() {}
        }
      `),
    ).toEqual([]);
  });

  it('returns nothing for a file with no @Controller at all', () => {
    expect(extract(`export function get() { return 1; }`)).toEqual([]);
  });

  // ─── Literal decoding ──────────────────────────────────────────────

  it('decodes an escape in a path instead of deleting it', () => {
    // The source below spells the Nest regex param the way a controller does,
    // `@Get(':id(\\d+)')`, whose runtime value is `:id(\d+)`. tree-sitter SPLITS
    // that literal around the escape_sequence, so keeping only the
    // string_fragment children and joining them yielded `:id(d+)` — a URL the
    // app never serves, i.e. the wrong-path outcome this module calls worse
    // than a missing one.
    const [route] = extract(`
      @Controller('users')
      export class UserController {
        @Get(':id(\\\\d+)')
        one() {}
      }
    `);
    expect(route.routePath).toBe(':id(\\d+)');
  });

  it('decodes a unicode escape rather than dropping its payload', () => {
    expect(
      urls(`
        @Controller('v')
        export class C {
          @Get('/v\\u0069ews')
          views() {}
        }
      `),
    ).toEqual(['GET /v/views']);
  });

  it("treats an empty @Controller('') as carrying no prefix", () => {
    const [route] = extract(`
      @Controller('')
      export class C {
        @Get('a') a() {}
      }
    `);
    expect(route.prefix).toBeNull();
    expect(normalizeExtractedRoutePath(route.routePath, route.prefix ?? null)).toBe('/a');
  });

  // ─── Multi-path (array form) ───────────────────────────────────────

  it('emits one route per path for the array form', () => {
    // `@Get(['a','b'])` mounts the handler at BOTH URLs, so both are routes.
    // N paths needs no new field to say so: N routes is what an
    // ExtractedDecoratorRoute[] already is, the same representation spring.ts
    // uses for `@GetMapping({"/a","/b"})`.
    const routes = extract(`
      @Controller('x')
      export class C {
        @Get(['a', 'b'])
        search() {}
      }
    `);

    expect(format(routes)).toEqual(['GET /x/a', 'GET /x/b']);
    // Everything other than the path is the same route twice — in particular
    // the handler, or only one of the two URLs would resolve to a symbol.
    expect(routes.map((r) => r.handlerName)).toEqual(['search', 'search']);
  });

  it('reads a single-element array as that one path', () => {
    expect(
      urls(`
        @Controller(['a'])
        export class C {
          @Get(['b']) b() {}
        }
      `),
    ).toEqual(['GET /a/b']);
  });

  it('emits nothing for an empty array path, and drops only the route it skips', () => {
    // `@Get([])` is legal and mounts no URL. It is neither a pathless `@Get()`
    // nor an unreadable path: reading it as the first would mint `GET /x`, a
    // URL the app does not serve.
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get([]) none() {}
        }
      `),
    ).toEqual([]);

    // Whichever the reason a path yields no route — knowably empty, or
    // unreadable — it costs exactly its own route and not the controller's
    // others, which is what makes a per-decorator skip safe.
    expect(
      urls(`
        @Controller('x')
        export class C {
          @Get([]) none() {}
          @Get(ROUTES.ADMIN) admin() {}
          @Get('a') a() {}
        }
      `),
    ).toEqual(['GET /x/a']);
  });

  it('decodes escapes inside array elements too', () => {
    // Each element goes through the same `plainString` a scalar path does, so
    // the split-around-escape_sequence trap cannot come back on this arm alone.
    expect(
      extract(`
        @Controller('u')
        export class C {
          @Get([':id(\\\\d+)', '/v\\u0069ews'])
          one() {}
        }
      `).map((r) => r.routePath),
    ).toEqual([':id(\\d+)', '/views']);
  });

  // ─── Controller shapes ─────────────────────────────────────────────

  it('extracts routes from an abstract controller base class', () => {
    // `export abstract class` parses as abstract_class_declaration, a separate
    // node type — and a decorated abstract base sharing CRUD routes with its
    // subclasses is ordinary Nest, so missing it drops the whole controller.
    expect(
      urls(`
        @Controller('base')
        export abstract class BaseController {
          @Get('a') a() {}
        }
      `),
    ).toEqual(['GET /base/a']);
  });

  it('reads the path out of the object form used for URI versioning', () => {
    expect(
      urls(`
        @Controller({ path: 'cats', version: '1' })
        export class CatsController {
          @Get('breeds') breeds() {}
        }
      `),
    ).toEqual(['GET /cats/breeds']);
  });

  it('reads a quoted path key, rather than dropping the class over the quotes', () => {
    expect(
      urls(`
        @Controller({ 'path': 'cats' })
        export class CatsController {
          @Get('breeds') breeds() {}
        }
      `),
    ).toEqual(['GET /cats/breeds']);
  });

  it.each([
    { label: 'no path key', argument: "{ version: '1' }" },
    { label: 'a computed path', argument: '{ path: BASE_PATH }' },
    { label: 'a computed path key', argument: "{ [PATH_KEY]: 'cats' }" },
  ])('still drops a controller whose object form has $label', ({ argument }) => {
    expect(
      extract(`
        @Controller(${argument})
        export class C {
          @Get('a') a() {}
        }
      `),
    ).toEqual([]);
  });

  // A `path` pair proves the mount point only when nothing ELSE in the object
  // can replace it. `{ path: 'cats', ...options }` reads as `cats` under a
  // first-match scan and mounts wherever `options.path` says at runtime;
  // `{ path: 'cats', path: 'dogs' }` mounts at `dogs`. Both are the wrong-URL
  // outcome this module calls worse than a missing one, and both are silent —
  // a published `/cats` looks exactly like a correct one. So the object is read
  // only when every member is a named, non-repeated pair: the whole-entry
  // fail-closed shape `routeFromObject` uses in data-route-table.ts.
  it.each([
    // `options.path` overrides the pair above it, so the extracted prefix and
    // the served prefix disagree with nothing in the file to say so.
    { label: 'a trailing spread', argument: "{ path: 'cats', ...options }" },
    // Deterministically SAFE under JS evaluation order — a later `path` pair
    // always wins over an earlier spread — and refused anyway. Reading member
    // order as proof makes the verdict turn on which side of the spread the
    // author happened to type `path`, and how often each spelling occurs in
    // real controllers is unmeasured. Meanwhile the two failure directions are
    // not symmetric: reading it wrong publishes a URL the app never serves, and
    // `route_map`/`api_impact` present that as fact, while refusing omits a
    // route that is still findable in source.
    { label: 'a leading spread', argument: "{ ...options, path: 'cats' }" },
    { label: 'nothing but a spread', argument: '{ ...options }' },
    // Last write wins at runtime, so a first-match scan names the loser.
    { label: 'a repeated path key', argument: "{ path: 'cats', path: 'dogs' }" },
    // Visible only through `propertyName`: compared as raw key text, `path` and
    // `'path'` are two different keys and the duplicate check never fires.
    {
      label: 'a repeated path key in its quoted spelling',
      argument: "{ path: 'cats', 'path': 'dogs' }",
    },
    // Refusal is on ANY repeated key, not only `path` — a duplicate anywhere is
    // evidence the object is not the fixed literal it reads as.
    {
      label: 'a repeated key other than path',
      argument: "{ path: 'a', version: '1', version: '2' }",
    },
    // A computed key could evaluate to `path` and take the mount with it.
    { label: 'a computed key beside the path', argument: "{ path: 'a', [dynamicKey]: 'b' }" },
    // `shorthand_property_identifier` and `method_definition`; neither is a
    // `pair`, so neither offers a key/value this file can read.
    { label: 'a shorthand property', argument: '{ path }' },
    { label: 'a method', argument: "{ path: 'a', getFoo() {} }" },
  ])('refuses an object form whose path another member could override: $label', ({ argument }) => {
    expect(
      extract(`
        @Controller(${argument})
        export class C {
          @Get('b') b() {}
        }
      `),
    ).toEqual([]);
  });

  it.each([
    // A comment between two pairs is ordinary formatting. It has to be skipped
    // BEFORE the not-a-pair test above, or the refusal fires on it and costs
    // the controller every route it has.
    {
      label: 'a comment between its pairs',
      argument: "{ path: 'a', /* URI versioning */ version: '1' }",
    },
    // Only `path` has to be provable. A non-literal value on an unrelated key
    // is benign: `containsExecutingExpression` in data-route-table.ts refuses
    // these, but it guards whole-entry declarativeness for a static route
    // table — a different invariant from "can this member move the mount".
    {
      label: 'non-literal values on keys other than path',
      argument: "{ path: 'a', host: 'x', scope: Scope.REQUEST, durable: true }",
    },
  ])('still reads the prefix out of an object form with $label', ({ argument }) => {
    expect(
      urls(`
        @Controller(${argument})
        export class C {
          @Get('b') b() {}
        }
      `),
    ).toEqual(['GET /a/b']);
  });

  it.each([
    { label: 'a single path', argument: "{ path: 'a' }" },
    { label: 'an array of paths', argument: "{ path: ['a', 'b'] }" },
    // The verb gate short-circuits on the object form before the object is
    // walked at all, so the class-form refusal never gets a say here.
    { label: 'an object the class form would also refuse', argument: "{ path: 'a', ...options }" },
  ])('mints nothing from the object form on a VERB decorator ($label)', ({ argument }) => {
    // `@Controller` takes the object form; `@Get` and friends take
    // `string | string[]`. Nest mounts nothing here, so emitting a route would
    // invent a URL — the failure this module exists to avoid, and the reason
    // the class prefix below is deliberately readable: the route is dropped
    // because the METHOD path is unreadable, not because the class was.
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get(${argument}) a() {}
        }
      `),
    ).toEqual([]);
  });

  it.each([
    { label: 'the bare array form', argument: "['a', 'b']" },
    { label: 'an array inside the object form', argument: "{ path: ['a', 'b'] }" },
  ])('declines a controller whose prefix is multi-path: $label', ({ argument }) => {
    // Deliberate parity with spring.ts, which detects an array-form class
    // @RequestMapping only to SUPPRESS that class, leaving the prefix x method
    // cross-product to #2280. The method path here is perfectly readable, so
    // the alternative is not "drop one route" but "publish it under one of the
    // two prefixes, or none" — URLs the application does not serve.
    expect(
      extract(`
        @Controller(${argument})
        export class C {
          @Get('a') a() {}
        }
      `),
    ).toEqual([]);
  });

  it('extracts from a .js controller, where a decorator is a CHILD of the method', () => {
    // tree-sitter-javascript nests a method decorator inside method_definition
    // rather than placing it before as a sibling. The same extractor serves the
    // JavaScript provider, so reading siblings only meant every .js Nest
    // controller emitted nothing while the wiring claimed nestjs coverage.
    expect(
      jsUrls(`
        @Controller('venues')
        export class VenueController {
          @UseGuards(AuthGuard)
          @Get('search')
          search() {}
        }
      `),
    ).toEqual(['GET /venues/search']);
  });

  // ─── Verb coverage ─────────────────────────────────────────────────

  it('treats @Sse as the GET endpoint it mounts', () => {
    expect(
      urls(`
        @Controller('events')
        export class EventsController {
          @Sse('stream') stream() {}
        }
      `),
    ).toEqual(['GET /events/stream']);
  });

  it('emits nothing for a decorator that mounts no endpoint', () => {
    // Paired with the @Sse case above: without it, an unsupported route
    // decorator and a non-route decorator are the same silent [].
    expect(
      extract(`
        @Controller('events')
        export class EventsController {
          @UseGuards(AuthGuard) guarded() {}
        }
      `),
    ).toEqual([]);
  });

  it.each(['toString', 'constructor'])(
    'does not mint a route for a decorator named @%s',
    (name) => {
      // The verb table is looked up by decorator name, so a plain object would
      // answer `Object.prototype.toString` here — truthy, and emitted verbatim
      // as the route's httpMethod.
      expect(
        extract(`
        @Controller('x')
        export class C {
          @${name}() f() {}
        }
      `),
      ).toEqual([]);
    },
  );

  it("does not carry a decorated property's decorators onto the next method", () => {
    // The decorator run is accumulated in one forward pass over the class body;
    // a non-method member must reset it, the way the backward walk used to stop.
    expect(
      urls(`
        @Controller('di')
        export class C {
          @Inject(SERVICE)
          private readonly svc: Service;

          @Get('a') a() {}
        }
      `),
    ).toEqual(['GET /di/a']);
  });

  // A Nest route decorator is a FACTORY: `@Get()` invokes it and returns the
  // decorator that registers the route. A bare `@Get` is the factory itself,
  // never applied to anything, so Nest registers nothing — emitting a route for
  // it publishes a URL the app does not serve. `@Get()` with no argument IS a
  // real pathless route and must keep working; the difference is the call, not
  // the argument list.
  it.each([
    { label: 'a bare verb decorator', member: '@Get a() {}' },
    {
      label: 'a bare verb decorator beside a real one',
      member: "@Get a() {}\n  @Post('b') b() {}",
    },
  ])('mints no route for $label', ({ member }) => {
    expect(
      urls(`
        @Controller('x')
        export class C {
          ${member}
        }
      `).filter((route) => route.startsWith('GET')),
    ).toEqual([]);
  });

  it('drops a class whose @Controller is bare rather than invoked', () => {
    // Same rule one level up: an uninvoked `@Controller` registers no
    // controller, so its methods are not routes either.
    expect(
      extract(`
        @Controller
        export class C {
          @Get('a') a() {}
        }
      `),
    ).toEqual([]);
  });

  it('still emits a pathless route for an INVOKED decorator with no argument', () => {
    // The control: `@Get()` differs from `@Get` by the call, and only the call.
    expect(
      urls(`
        @Controller('x')
        export class C {
          @Get() a() {}
        }
      `),
    ).toEqual(['GET /x']);
  });

  // ─── Members Nest never registers as handlers ──────────────────────

  /** Routes a controller emits when `member` is its only member. */
  const memberUrls = (member: string) =>
    urls(`
      @Controller('v')
      export class C {
        ${member}
      }
    `);

  /** A non-handler followed by a real one — the shape both arms below need. */
  const STATIC_THEN_INSTANCE = `
      @Controller('v')
      export class C {
        @Get('s')
        static s() {}

        @Get('i')
        i() {}
      }
    `;

  // Nest's `RequestMapping` writes the handler onto the class PROTOTYPE's
  // `descriptor.value`, and `RouterExplorer` scans prototype instance methods
  // for that metadata. A `static` method lives on the constructor and is never
  // scanned; an accessor's descriptor carries `get`/`set` and no `value` to
  // register. A verb decorator on any of the three mounts NOTHING, so a route
  // minted from one is a URL the app does not serve — the same
  // wrong-answer-dressed-as-fact the object-form refusals above exist for.
  it.each([
    { label: 'a static method', member: "@Get('s') static s() {}" },
    { label: 'a getter', member: "@Get('s') get s(): string { return ''; }" },
    { label: 'a setter', member: "@Get('s') set s(v: string) {}" },
  ])('mints nothing for $label, which Nest never registers as a handler', ({ member }) => {
    expect(memberUrls(member)).toEqual([]);
  });

  // The other half of the modifier check, and the half a mutation can actually
  // reach: these modifiers must NOT reject. `async` matters most — it is the
  // dominant shape of a real Nest handler, so widening the exclusion set to
  // include it would silently delete most routes in most Nest repos while the
  // table above stayed green. `override` and an accessibility modifier are the
  // other tokens that sit in the same position on a `method_definition`, and a
  // method merely NAMED `get`/`set`/`static` is a property_identifier, not a
  // modifier — it must survive too.
  it.each([
    { label: 'an async method', member: "@Get('s') async s() {}" },
    { label: 'a public method', member: "@Get('s') public s() {}" },
    { label: 'a protected method', member: "@Get('s') protected s() {}" },
    {
      label: 'an async method with an accessibility modifier',
      member: "@Get('s') public async s() {}",
    },
    { label: 'a method named get', member: "@Get('s') get() {}" },
    { label: 'a method named static', member: "@Get('s') static() {}" },
    // The control for the mints-nothing table above: identical source minus the
    // modifier, which is what makes those three empty results evidence of the
    // check rather than of a fixture that happens to parse to nothing.
    { label: 'a plain instance method', member: "@Get('s') s() {}" },
  ])('still emits the route for $label', ({ member }) => {
    expect(memberUrls(member)).toEqual(['GET /v/s']);
  });

  it('drops a decorated static method under the JavaScript grammar too', () => {
    // tree-sitter-javascript makes a method decorator a CHILD of
    // `method_definition`, so `children` reads `decorator | static |
    // property_identifier | …` and the modifier is NOT at a fixed index — the
    // check has to test every child's type. The instance method beside it is
    // the in-fixture control: its route proves this .js arm still measures
    // something rather than passing on a fixture that parses to nothing.
    expect(jsUrls(STATIC_THEN_INSTANCE)).toEqual(['GET /v/i']);
  });

  it("does not donate a non-handler member's decorator run to the method after it", () => {
    // Pins the UNCONDITIONAL `pending.length = 0` at the end of the member
    // loop, NOT the modifier check: a non-handler must fall through to that
    // clear rather than `continue` past it. Deliberately green before the
    // modifier check existed too — there the static member consumed the run
    // into its own (wrong) route and then cleared it — so this goes red only
    // if a future edit adds the early `continue`. Asserted over the routes
    // attributed to `i`, because the whole-output form would instead be
    // measuring the modifier check the table above already covers.
    const routes = extract(STATIC_THEN_INSTANCE);

    expect(format(routes.filter((route) => route.handlerName === 'i'))).toEqual(['GET /v/i']);
  });

  // ─── Routes inherited from a base class in the same file ───────────
  //
  // Every expectation below was checked against a running NestJS 12.5.0
  // application: the listed URLs answer, the absent ones return 404.

  it('mounts the handlers of a same-file base class under the controller prefix', () => {
    const routes = extract(`
      abstract class BaseHealth {
        @Get('ping')
        ping() {}
      }

      @Controller('health')
      export class HealthController extends BaseHealth {}
    `);

    expect(format(routes)).toEqual(['GET /health/ping']);
    // The handler is the base method, on the line where it is declared.
    expect(routes[0]).toMatchObject({ handlerName: 'ping', lineNumber: 4, decoratorName: 'Get' });
  });

  it('lists own routes first, then each base class from the nearest up', () => {
    expect(
      urls(`
        class Root {
          @Get('root') root() {}
        }

        class Mid extends Root {
          @Get('mid') mid() {}
        }

        @Controller('levels')
        export class LevelsController extends Mid {
          @Get('own') own() {}
        }
      `),
    ).toEqual(['GET /levels/own', 'GET /levels/mid', 'GET /levels/root']);
  });

  it('gives each controller that extends the base its own copy of the routes', () => {
    expect(
      urls(`
        class Shared {
          @Get('ping') ping() {}
        }

        @Controller('one')
        export class OneController extends Shared {}

        @Controller('two')
        export class TwoController extends Shared {}
      `),
    ).toEqual(['GET /one/ping', 'GET /two/ping']);
  });

  it('inherits from a base class that is a controller itself', () => {
    expect(
      urls(`
        @Controller('base')
        export class BaseController {
          @Get('ping') ping() {}
        }

        @Controller('sub')
        export class SubController extends BaseController {}
      `),
    ).toEqual(['GET /base/ping', 'GET /sub/ping']);
  });

  it('reads the base through type arguments and an implements clause', () => {
    expect(
      urls(`
        abstract class Crud<T> {
          @Get(':id') findOne(): T | undefined { return undefined; }
        }

        @Controller('users')
        export class UsersController extends Crud<User> implements Marker {}
      `),
    ).toEqual(['GET /users/:id']);
  });

  it('inherits every path of a multi-path decorator and a method-agnostic route', () => {
    expect(
      urls(`
        class Base {
          @Get(['a', 'b']) both() {}
          @All('any') any() {}
        }

        @Controller('multi')
        export class MultiController extends Base {}
      `),
    ).toEqual(['GET /multi/a', 'GET /multi/b', '* /multi/any']);
  });

  it.each([
    {
      label: 'redeclared without a route decorator',
      controllerMember: 'list() {}',
      expected: ['GET /x/kept'],
    },
    {
      label: 'redeclared with another route',
      controllerMember: "@Post('changed') list() {}",
      expected: ['POST /x/changed', 'GET /x/kept'],
    },
    {
      label: 'hidden by an accessor of the same name',
      controllerMember: 'get list() { return () => 1; }',
      expected: ['GET /x/kept'],
    },
    {
      label: 'redeclared under a quoted name',
      controllerMember: "'list'() {}",
      expected: ['GET /x/kept'],
    },
  ])('drops an inherited route $label', ({ controllerMember, expected }) => {
    // Nest walks the prototype chain from the controller up and keeps the first
    // declaration of each name, so the base decorator is never read.
    expect(
      urls(`
        class Base {
          @Get('list') list() {}
          @Get('kept') kept() {}
        }

        @Controller('x')
        export class XController extends Base {
          ${controllerMember}
        }
      `),
    ).toEqual(expected);
  });

  it.each([
    { label: 'a class field', controllerMember: 'list = () => 1;' },
    { label: 'a static method', controllerMember: 'static list() {}' },
    { label: 'a private method', controllerMember: '#list() {}' },
  ])('keeps an inherited route beside $label of the same name', ({ controllerMember }) => {
    // None of the three is a property of the controller prototype, so the base
    // method is still the one Nest finds there.
    expect(
      urls(`
        class Base {
          @Get('list') list() {}
        }

        @Controller('x')
        export class XController extends Base {
          ${controllerMember}
        }
      `),
    ).toEqual(['GET /x/list']);
  });

  it('applies the nearest redeclaration when a class between the two redeclares a handler', () => {
    expect(
      urls(`
        class Root {
          @Get('plain') plain() {}
          @Get('changed') changed() {}
          @Get('kept') kept() {}
        }

        class Mid extends Root {
          plain() {}
          @Post('moved') changed() {}
        }

        @Controller('x')
        export class XController extends Mid {}
      `),
    ).toEqual(['POST /x/moved', 'GET /x/kept']);
  });

  it('does not inherit a decorated static method or accessor of the base', () => {
    expect(
      urls(`
        class Base {
          @Get('static') static make() {}
          @Get('getter') get value() { return 1; }
          @Get('ok') ok() {}
        }

        @Controller('x')
        export class XController extends Base {}
      `),
    ).toEqual(['GET /x/ok']);
  });

  it.each([
    { label: 'imported from another file', declaration: '', heritage: 'Base' },
    {
      label: 'reached through a namespace',
      declaration: "class Base { @Get('ping') ping() {} }",
      heritage: 'ns.Base',
    },
    {
      label: 'wrapped in a mixin call',
      declaration: "class Base { @Get('ping') ping() {} }",
      heritage: 'Mixin(Base)',
    },
    {
      label: 'declared inside a function',
      declaration: "function scope() { class Base { @Get('ping') ping() {} } }",
      heritage: 'Base',
    },
    {
      label: 'declared twice in the file',
      declaration:
        "class Base { @Get('ping') ping() {} }\nfunction scope() { class Base { @Get('pong') pong() {} } }",
      heritage: 'Base',
    },
  ])('inherits nothing from a base class $label', ({ declaration, heritage }) => {
    // Which class the clause reaches is not provable from this file alone, and
    // a wrong base would publish URLs the application does not serve.
    expect(
      urls(`
        ${declaration}

        @Controller('x')
        export class XController extends ${heritage} {
          @Get('own') own() {}
        }
      `),
    ).toEqual(['GET /x/own']);
  });

  it.each([
    {
      label: 'the controller has a computed key',
      base: "@Get('list') list() {}",
      controllerMember: '[HANDLER]() {}',
    },
    {
      label: 'the base handler has a computed key',
      base: "@Get('list') [HANDLER]() {}",
      controllerMember: '',
    },
  ])('inherits nothing when $label', ({ base, controllerMember }) => {
    // `['list']() {}` on the controller takes the place of the base `list`
    // exactly as `list() {}` does, and a computed key does not say which name
    // it is. The own route beside it shows the controller is still read.
    expect(
      urls(`
        class Base {
          ${base}
        }

        @Controller('x')
        export class XController extends Base {
          @Get('own') own() {}
          ${controllerMember}
        }
      `),
    ).toEqual(['GET /x/own']);
  });

  it('drops inherited routes too when the controller prefix cannot be read', () => {
    expect(
      extract(`
        class Base {
          @Get('ping') ping() {}
        }

        @Controller(ROUTES.X)
        export class XController extends Base {}
      `),
    ).toEqual([]);
  });

  it('stops at a class that extends itself through another', () => {
    expect(
      urls(`
        class A extends B {
          @Get('a') a() {}
        }

        class B extends A {
          @Get('b') b() {}
        }

        @Controller('x')
        export class XController extends A {}
      `),
    ).toEqual(['GET /x/a', 'GET /x/b']);
  });

  it('inherits under the JavaScript grammar, where the extends clause has no wrapper node', () => {
    expect(
      jsUrls(`
        class Base {
          @Get('ping')
          ping() {}
        }

        @Controller('health')
        export class HealthController extends Base {}
      `),
    ).toEqual(['GET /health/ping']);
  });
});
