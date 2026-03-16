import { User } from './user';

export function processUser(): boolean {
  const user = new User();
  return user.save();
}
