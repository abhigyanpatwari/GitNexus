/**
 * A NestJS controller mounting a METHOD-AGNOSTIC route at `/api/widgets` — the
 * same URL `app/api/widgets/route.ts` produces as a Next.js filesystem route.
 *
 * `@All` maps to httpMethod '*', which `routeNodeKey` keys by URL alone, so
 * this route collides with the filesystem one. It is the shape behind #3049.
 */
@Controller('api')
export class WidgetsController {
  @All('widgets')
  handleEveryVerb() {
    return 'nest handler';
  }
}
