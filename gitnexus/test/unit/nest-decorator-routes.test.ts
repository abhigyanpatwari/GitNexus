import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractNestRoutes } from '../../src/core/ingestion/route-extractors/nest.js';
import { normalizeExtractedRoutePath } from '../../src/core/ingestion/route-extractors/route-path.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const extract = (source: string) =>
  extractNestRoutes(tsParser.parse(source), 'src/x.controller.ts');

/** What the routes phase will key the Route node by: verb + joined path. */
const urls = (source: string) =>
  extract(source).map(
    (r) => `${r.httpMethod} ${normalizeExtractedRoutePath(r.routePath, r.prefix ?? null)}`,
  );

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
    expect(
      extract(`
        @Injectable()
        export class NotAController {
          @Get('looks-like-a-route')
          nope() {}
        }
      `),
    ).toEqual([]);
  });

  it('drops a route whose path is a constant it cannot read', () => {
    // A wrong URL is worse than a missing one — route_map presents this as fact.
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get(ROUTES.SEARCH)
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

  it('drops an interpolated template path rather than emitting its source text', () => {
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get(\`\${prefix}/search\`)
          search() {}
        }
      `),
    ).toEqual([]);
  });

  it('ignores an array-form path it cannot reduce to one URL', () => {
    expect(
      extract(`
        @Controller('x')
        export class C {
          @Get(['a', 'b'])
          multi() {}
        }
      `),
    ).toEqual([]);
  });

  it('returns nothing for a file with no @Controller at all', () => {
    expect(extract(`export function get() { return 1; }`)).toEqual([]);
  });
});
