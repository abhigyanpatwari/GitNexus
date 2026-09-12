/**
 * A NestJS controller mounting a METHOD-AGNOSTIC route at `/api/widgets` — the
 * same URL `app/api/widgets/route.ts` produces as a Next.js filesystem route.
 *
 * `@All` maps to httpMethod '*', which `routeNodeKey` keys by URL alone, so
 * this route collides with the filesystem one. It is the shape behind #3049.
 *
 * `@Get('gadgets')` is the NON-colliding companion, and it is here for a
 * reason the `@All` route cannot serve: because the `@All` route loses its key
 * to the filesystem node and is dropped as a duplicate, it leaves NO trace in
 * the graph at all — so the whole of this file could stop being extracted
 * without a single assertion changing. `GET /api/gadgets` is the only witness
 * this fixture can offer that NestJS extraction ran (see the test's comment).
 */
@Controller('api')
export class WidgetsController {
  @All('widgets')
  handleEveryVerb() {
    return 'nest handler';
  }

  @Get('gadgets')
  listGadgets() {
    return '[]';
  }
}
