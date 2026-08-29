import { Controller, Get } from '@nestjs/common';

/**
 * A controller with no prefix of its own. `@Controller()` is legal NestJS and
 * means "mount at the root", so the method path must reach the graph bare —
 * this is the fixture half of the extractor's `prefix: '' -> null` mapping.
 */
@Controller()
export class HealthController {
  @Get('health')
  health(): string {
    return 'ok';
  }
}
