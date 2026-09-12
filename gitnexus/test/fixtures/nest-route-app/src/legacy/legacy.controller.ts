import { Controller, Get } from '@nestjs/common';

const ROUTE_PREFIXES = { legacy: 'legacy' };

/**
 * The prefix is not a literal, so the URLs of this controller's methods are
 * unknowable here. `route_map` presents its output as fact: a missing route is
 * recoverable, a route mounted at the wrong URL is not.
 */
@Controller(ROUTE_PREFIXES.legacy)
export class LegacyController {
  @Get('reports')
  legacyReports(): string {
    return 'legacy';
  }
}
