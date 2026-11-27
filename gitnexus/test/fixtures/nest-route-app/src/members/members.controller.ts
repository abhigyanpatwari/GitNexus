import { Controller, Get } from '@nestjs/common';
import { CrudController } from '../shared';

interface Member {
  id: string;
}

/**
 * Inherits its CRUD routes through the `shared` barrel and adds one of its
 * own. It redeclares `destroy` without a route decorator, so NestJS serves no
 * `DELETE /members/:id`.
 */
@Controller('members')
export class MembersController extends CrudController<Member> {
  @Get('me')
  currentMember(): Member {
    return { id: 'me' };
  }

  destroy(): void {}
}
