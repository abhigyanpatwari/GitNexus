import { Delete, Get } from '@nestjs/common';

/**
 * The CRUD handlers every resource controller shares. The class lives in a
 * file of its own and has no `@Controller`: NestJS mounts these handlers under
 * the prefix of each controller that extends it, in whichever file that is.
 */
export abstract class CrudController<T> {
  @Get()
  findEvery(): T[] {
    return [];
  }

  @Get(':id')
  findById(): T | undefined {
    return undefined;
  }

  @Delete(':id')
  destroy(): void {}
}
