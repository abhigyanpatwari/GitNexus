import { User } from './models';

export function getUser(name: string): User {
  return new User(name);
}
