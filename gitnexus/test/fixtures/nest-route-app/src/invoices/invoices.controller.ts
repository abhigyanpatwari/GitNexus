import { Controller, Get, Post } from '@nestjs/common';

/**
 * Handlers shared by controllers that keep an audit trail. The class has no
 * `@Controller` of its own: NestJS mounts its handlers under the prefix of
 * each controller that extends it.
 */
abstract class AuditedController {
  @Get('history')
  history(): string[] {
    return [];
  }

  @Post('archive')
  archive(): void {}
}

@Controller('invoices')
export class InvoicesController extends AuditedController {
  @Get()
  listInvoices(): string[] {
    return [];
  }

  // Redeclared without a route decorator, so NestJS serves no `POST
  // /invoices/archive`: the prototype chain reaches this method first.
  archive(): void {}
}
