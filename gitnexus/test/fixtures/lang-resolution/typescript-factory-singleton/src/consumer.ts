import { fooService } from './service';

export function caller(id: string) {
  return fooService.getUser(id);
}
