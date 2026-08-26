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
    { label: 'an array form it cannot reduce to one URL', argument: "['a', 'b']" },
  ])('drops a route whose path is $label', ({ argument }) => {
    // A wrong URL is worse than a missing one — route_map presents this as fact.
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
});
